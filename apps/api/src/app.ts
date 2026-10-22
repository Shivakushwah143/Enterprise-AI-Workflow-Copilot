/**
 * HTTP API.
 *
 * Authorization rules that hold for every route:
 *   - the tenant and role come from the bearer token, never the request body;
 *   - a permission is checked with `requirePermission` before any work happens;
 *   - a resource that belongs to another tenant is reported as 404, not 403, so
 *     the API does not confirm its existence.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  ApproveWorkflowSchema,
  CopilotError,
  ExecuteSchema,
  IntentRequestSchema,
  RegisterApplicationSchema,
  StartRecordingSchema,
  roleCan,
  type Capabilities,
  type Execution,
  type Guidance,
  type LandingPage,
  type Permission,
  type Plan,
  type Skill,
  type Workflow,
} from "@copilot/shared";
import type { ExecutionRow, SessionRow, Store } from "@copilot/knowledge";
import type { KnowledgeEngine } from "@copilot/knowledge";
import {
  buildPlan,
  executeSkill,
  guidanceFor,
  llmStatus,
  resolveIntent,
  type SkillContext,
} from "@copilot/agent";
import { configuredEmbeddingProvider } from "@copilot/knowledge";
import { inspectBundle, type WorkflowEngine } from "@copilot/workflow";
import { createLogger, type Logger } from "./log.js";
import { startRecording } from "./recordings.js";
import { runStagehandTask, stagehandStatus } from "./stagehand.js";

export interface ApiDeps {
  store: Store;
  engine: WorkflowEngine;
  knowledge: KnowledgeEngine;
  artifactRoot: string;
  log?: Logger;
}

type Env = { Variables: { session: SessionRow } };

const log = createLogger("api");

function requirePermission(session: SessionRow, permission: Permission): void {
  if (!roleCan(session.user.role, permission)) {
    throw new CopilotError(
      "forbidden",
      `Role "${session.user.role}" lacks the "${permission}" permission.`,
      403,
    );
  }
}

function toPublicExecution(row: ExecutionRow): Execution {
  return {
    id: row.id,
    tenantId: row.tenantId,
    skillId: row.skillId,
    workflowId: row.workflowId,
    intent: row.intent,
    inputs: Object.fromEntries(
      Object.entries(row.inputs).map(([key, value]) => [key, String(value)]),
    ),
    status: row.status,
    outcome: row.outcome,
    engineOutcome: row.engineOutcome,
    engineReportPath: row.engineReportPath,
    steps: row.steps,
    verification: row.verification,
    message: row.message,
    modelCalls: row.modelCalls,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

export function createApp(deps: ApiDeps) {
  const logger = deps.log ?? log;
  const app = new Hono<Env>();
  const plans = new Map<string, { plan: Plan; expiresAt: number }>();

  const rememberPlan = (plan: Plan): void => {
    plans.set(plan.id, { plan, expiresAt: Date.now() + 30 * 60_000 });
    for (const [key, value] of plans) {
      if (value.expiresAt < Date.now()) plans.delete(key);
    }
  };

  const publicRoutes = new Set(["POST /api/auth/login", "GET /api/health", "GET /api/capabilities"]);

  app.use("*", async (c, next) => {
    const pathname = new URL(c.req.url).pathname;
    if (!pathname.startsWith("/api")) return next();
    if (publicRoutes.has(`${c.req.method} ${pathname}`)) return next();
    const header = c.req.header("authorization") ?? "";
    const token = header.replace(/^bearer\s+/i, "").trim();
    const session = token ? await deps.store.getSession(token) : null;
    if (!session) {
      throw new CopilotError("unauthenticated", "Missing or expired bearer token.", 401);
    }
    c.set("session", session);
    await next();
  });

  app.onError((error, c) => {
    if (error instanceof CopilotError) {
      logger({ event: "api.error", code: error.code, message: error.message });
      return c.json(
        { error: { code: error.code, message: error.message, detail: error.detail } },
        error.status as 400,
      );
    }
    if (error instanceof z.ZodError) {
      return c.json(
        {
          error: {
            code: "invalid_request",
            message: "Request validation failed.",
            detail: error.flatten(),
          },
        },
        400,
      );
    }
    logger({
      event: "api.unhandled",
      message: error instanceof Error ? error.message : String(error),
    });
    return c.json(
      { error: { code: "internal_error", message: "Unexpected server error." } },
      500,
    );
  });

  /* ---------------- health & capabilities ---------------- */

  app.get("/api/health", (c) => c.json({ ok: true, ts: new Date().toISOString() }));

  let cachedProbe: { at: number; value: Awaited<ReturnType<WorkflowEngine["probe"]>> } | null = null;
  const probe = async () => {
    if (cachedProbe && Date.now() - cachedProbe.at < 60_000) return cachedProbe.value;
    const value = await deps.engine.probe();
    cachedProbe = { at: Date.now(), value };
    return value;
  };

  app.get("/api/capabilities", async (c) => {
    const engineProbe = await probe();
    const vector = deps.knowledge.vectorStatus();
    const stagehand = await stagehandStatus();
    const llm = llmStatus();
    const embeddings = configuredEmbeddingProvider();
    const payload: Capabilities = {
      engine: {
        kind: deps.engine.kind,
        available: engineProbe.ok,
        detail: engineProbe.ok
          ? `OpenAdapt ${engineProbe.engine?.version ?? "unknown"} on Python ${engineProbe.python ?? "?"}; Chromium ${
              engineProbe.chromiumInstalled ? "installed" : "NOT installed"
            }.`
          : `Engine unavailable: ${engineProbe.error ?? "unknown error"}`,
      },
      llm: {
        provider: llm.provider,
        model: llm.model,
        status: llm.status,
        detail: llm.detail,
      },
      embeddings: {
        provider: embeddings?.name ?? null,
        status: embeddings ? "configured" : "unconfigured",
        detail: embeddings
          ? `Embeddings via ${embeddings.name}.`
          : "No embedding provider configured (set EMBEDDING_PROVIDER and a key). Documents are searchable by keyword only.",
      },
      vectorSearch: vector,
      stagehand,
      database: { kind: deps.store.sql.kind, tenancyEnforced: true },
    };
    return c.json(payload);
  });

  /* ---------------- auth ---------------- */

  app.post("/api/auth/login", async (c) => {
    const body = z
      .object({ tenantSlug: z.string().min(1), email: z.string().email() })
      .parse(await c.req.json());
    const tenant = await deps.store.findTenantBySlug(body.tenantSlug);
    if (!tenant) {
      throw new CopilotError("unauthenticated", "Unknown tenant or user.", 401);
    }
    const user = await deps.store.findUserByEmail(tenant.id, body.email.toLowerCase());
    if (!user) {
      throw new CopilotError("unauthenticated", "Unknown tenant or user.", 401);
    }
    const session = await deps.store.createSession(user);
    logger({ event: "auth.login", tenantId: tenant.id, userId: user.id, role: user.role });
    return c.json({
      token: session.token,
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      userId: user.id,
      role: user.role,
      displayName: user.displayName,
      expiresAt: session.expiresAt,
    });
  });

  app.get("/api/me", (c) => {
    const session = c.get("session");
    return c.json({
      tenantId: session.tenant.id,
      tenantSlug: session.tenant.slug,
      userId: session.user.id,
      role: session.user.role,
      displayName: session.user.displayName,
    });
  });

  /* ---------------- applications ---------------- */

  app.get("/api/applications", async (c) => {
    const session = c.get("session");
    return c.json({ items: await deps.store.listApplications(session.tenant.id) });
  });

  app.post("/api/applications", async (c) => {
    const session = c.get("session");
    requirePermission(session, "application:write");
    const body = RegisterApplicationSchema.parse(await c.req.json());
    const application = await deps.store.createApplication({
      tenantId: session.tenant.id,
      name: body.name,
      baseUrl: body.baseUrl,
      verificationBaseUrl: body.verificationBaseUrl,
      kind: body.kind,
    });
    logger({ event: "application.registered", applicationId: application.id });
    return c.json(application, 201);
  });

  app.get("/api/context", async (c) => {
    const session = c.get("session");
    const url = c.req.query("url") ?? "";
    const application = url
      ? await deps.store.findApplicationForUrl(session.tenant.id, url)
      : null;
    const skills = await deps.store.listSkills(session.tenant.id, "active");
    const suggested = application
      ? skills.filter((s) => s.applicationId === application.id)
      : [];
    let path = "/";
    let title = "";
    try {
      const parsed = new URL(url);
      path = parsed.pathname;
      title = parsed.host;
    } catch {
      /* the page may not report a URL */
    }
    const payload: LandingPage = {
      href: url,
      path,
      title,
      appName: application?.name ?? null,
      applicationId: application?.id ?? null,
      suggestedSkills: suggested.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
      })),
    };
    return c.json(payload);
  });

  /* ---------------- recordings ---------------- */

  app.post("/api/recordings", async (c) => {
    const session = c.get("session");
    requirePermission(session, "application:write");
    const body = StartRecordingSchema.parse(await c.req.json());
    const recording = await startRecording(
      {
        store: deps.store,
        engine: deps.engine,
        artifactRoot: deps.artifactRoot,
        log: logger,
      },
      {
        tenantId: session.tenant.id,
        userId: session.user.id,
        applicationId: body.applicationId,
        mode: body.mode,
        workflowName: body.workflowName,
      },
    );
    return c.json(
      {
        ...recording,
        /** Visible recording indicator state for the extension. */
        recording: true,
      },
      202,
    );
  });

  app.get("/api/recordings/:id", async (c) => {
    const session = c.get("session");
    const recording = await deps.store.getRecording(session.tenant.id, c.req.param("id"));
    if (!recording) throw new CopilotError("not_found", "Recording not found.", 404);
    const workflow = recording.workflowId
      ? await deps.store.getWorkflow(session.tenant.id, recording.workflowId)
      : null;
    return c.json({ recording, workflow });
  });

  /* ---------------- workflows ---------------- */

  app.get("/api/workflows", async (c) => {
    const session = c.get("session");
    requirePermission(session, "workflow:read");
    return c.json({ items: await deps.store.listWorkflows(session.tenant.id) });
  });

  app.get("/api/workflows/:id", async (c) => {
    const session = c.get("session");
    requirePermission(session, "workflow:read");
    const workflow = await deps.store.getWorkflow(session.tenant.id, c.req.param("id"));
    if (!workflow) throw new CopilotError("not_found", "Workflow not found.", 404);
    return c.json(workflow);
  });

  app.post("/api/workflows/:id/approve", async (c) => {
    const session = c.get("session");
    requirePermission(session, "workflow:approve");
    const body = ApproveWorkflowSchema.parse(await c.req.json().catch(() => ({})));
    const workflow = await deps.store.getWorkflow(session.tenant.id, c.req.param("id"));
    if (!workflow) throw new CopilotError("not_found", "Workflow not found.", 404);

    const irreversible = workflow.steps.filter((s) => s.risk === "irreversible");
    if (irreversible.length > 0 && !body.acknowledgeRisk) {
      throw new CopilotError(
        "invalid_request",
        `This workflow contains ${irreversible.length} irreversible step(s). Re-send with acknowledgeRisk: true to approve.`,
        400,
        { irreversibleSteps: irreversible.map((s) => s.intent) },
      );
    }
    const uncertain = workflow.steps.filter((s) => s.confidence !== "identified");
    if (uncertain.length > 0 && !body.acknowledgeRisk) {
      throw new CopilotError(
        "invalid_request",
        `${uncertain.length} step(s) were identified with less than full confidence. Re-send with acknowledgeRisk: true to approve.`,
        400,
        { uncertainSteps: uncertain.map((s) => ({ index: s.index, note: s.uncertaintyNote })) },
      );
    }

    // Parameter specs come from the compiled bundle: the engine is the source
    // of truth for names/types, and we never invent a parameter here.
    const requiredInputs = await paramsForWorkflow(workflow);

    await deps.store.setWorkflowStatus(session.tenant.id, workflow.id, "approved");
    const skill = await deps.store.createSkill({
      tenantId: session.tenant.id,
      workflowId: workflow.id,
      name: body.name ?? workflow.name,
      description: body.description ?? workflow.description ?? workflow.name,
      requiredInputs,
      triggeredBy: body.triggeredBy,
      verification: body.verification,
      approvedBy: session.user.email,
    });
    logger({
      event: "workflow.approved",
      workflowId: workflow.id,
      skillId: skill.id,
      verification: Boolean(body.verification),
      approvedBy: session.user.email,
    });
    return c.json({ workflow: await deps.store.getWorkflow(session.tenant.id, workflow.id), skill }, 201);
  });

  app.post("/api/workflows/:id/reject", async (c) => {
    const session = c.get("session");
    requirePermission(session, "workflow:approve");
    const workflow = await deps.store.getWorkflow(session.tenant.id, c.req.param("id"));
    if (!workflow) throw new CopilotError("not_found", "Workflow not found.", 404);
    await deps.store.setWorkflowStatus(session.tenant.id, workflow.id, "rejected");
    return c.json(await deps.store.getWorkflow(session.tenant.id, workflow.id));
  });

  /* ---------------- skills ---------------- */

  app.get("/api/skills", async (c) => {
    const session = c.get("session");
    requirePermission(session, "workflow:read");
    const status = c.req.query("status");
    return c.json({
      items: await deps.store.listSkills(
        session.tenant.id,
        status === "active" || status === "disabled" ? status : undefined,
      ),
    });
  });

  app.get("/api/skills/:id", async (c) => {
    const session = c.get("session");
    requirePermission(session, "workflow:read");
    const skill = await deps.store.getSkill(session.tenant.id, c.req.param("id"));
    if (!skill) throw new CopilotError("not_found", "Skill not found.", 404);
    return c.json(skill);
  });

  app.get("/api/guidance", async (c) => {
    const session = c.get("session");
    requirePermission(session, "workflow:read");
    const skillId = c.req.query("skillId") ?? "";
    const stepIndex = Number(c.req.query("stepIndex") ?? 0);
    const skill = await deps.store.getSkill(session.tenant.id, skillId);
    if (!skill) throw new CopilotError("not_found", "Skill not found.", 404);
    const workflow = await deps.store.getWorkflow(session.tenant.id, skill.workflowId);
    if (!workflow) throw new CopilotError("not_found", "Workflow not found.", 404);
    const guidance: Guidance | null = guidanceFor(workflow, stepIndex);
    if (!guidance) throw new CopilotError("not_found", "Step not found.", 404);
    return c.json({ ...guidance, skillId });
  });

  /* ---------------- intent -> plan ---------------- */

  app.post("/api/plans", async (c) => {
    const session = c.get("session");
    const body = IntentRequestSchema.parse(await c.req.json());
    const contexts = await loadContexts(deps, session.tenant.id);
    const resolution = await resolveIntent(contexts, body.intent);
    const plan = buildPlan({
      tenantId: session.tenant.id,
      intent: body.intent,
      resolution,
      contexts,
    });
    rememberPlan(plan);
    logger({
      event: "plan.created",
      planId: plan.id,
      skillId: plan.skillId,
      method: resolution.method,
      missing: plan.missingInputs.map((m) => m.name),
      requiresApproval: plan.requiresApproval,
    });
    return c.json({
      plan,
      method: resolution.method,
      notes: resolution.notes,
      modelCalls: resolution.modelCalls,
      knowledge: body.intent
        ? await deps.knowledge.search(session.tenant.id, body.intent, 3)
        : { hits: [], method: "keyword" as const, notice: null },
    });
  });

  app.get("/api/plans/:id", (c) => {
    const plan = plans.get(c.req.param("id"));
    if (!plan) throw new CopilotError("not_found", "Plan not found or expired.", 404);
    return c.json(plan.plan);
  });

  /* ---------------- execution ---------------- */

  app.post("/api/executions", async (c) => {
    const session = c.get("session");
    requirePermission(session, "skill:execute");
    const body = ExecuteSchema.parse(await c.req.json());
    const stored = plans.get(body.planId);
    if (!stored) throw new CopilotError("not_found", "Plan not found or expired.", 404);
    const plan = stored.plan;
    if (plan.blockers.length > 0) {
      throw new CopilotError("conflict", plan.blockers.join(" "), 409, { blockers: plan.blockers });
    }
    if (!plan.skillId || !plan.workflowId) {
      throw new CopilotError("conflict", "The plan has no executable skill.", 409);
    }
    const skill = await deps.store.getSkill(session.tenant.id, plan.skillId);
    if (!skill) throw new CopilotError("not_found", "Skill not found.", 404);
    if (skill.status !== "active") {
      throw new CopilotError("conflict", "This skill is disabled.", 409);
    }
    const workflow = await deps.store.getWorkflow(session.tenant.id, plan.workflowId);
    if (!workflow) throw new CopilotError("not_found", "Workflow not found.", 404);
    const application = await deps.store.getApplication(session.tenant.id, skill.applicationId);
    if (!application) throw new CopilotError("not_found", "Application not found.", 404);

    const inputs: Record<string, string> = {};
    for (const [key, value] of Object.entries(body.inputs)) {
      const spec = skill.requiredInputs.find((p) => p.name === key);
      if (!spec) {
        throw new CopilotError(
          "invalid_request",
          `Unknown input "${key}" for this skill.`,
          400,
          { allowed: skill.requiredInputs.map((p) => p.name) },
        );
      }
      if (value !== "") inputs[key] = value;
    }
    for (const resolved of plan.resolvedInputs) {
      if (inputs[resolved.name] === undefined && resolved.value !== null) {
        inputs[resolved.name] = resolved.value;
      }
    }

    const execution = await executeSkill({
      store: deps.store,
      engine: deps.engine,
      tenantId: session.tenant.id,
      userId: session.user.id,
      plan,
      skill,
      workflow,
      inputs,
      approved: body.approved,
      applicationUrl: application.baseUrl,
      artifactRoot: deps.artifactRoot,
      log: logger,
    });
    return c.json(toPublicExecution(execution), 201);
  });

  app.get("/api/executions", async (c) => {
    const session = c.get("session");
    requirePermission(session, "execution:read");
    const items = await deps.store.listExecutions(session.tenant.id, 25);
    return c.json({ items: items.map(toPublicExecution) });
  });

  app.get("/api/executions/:id", async (c) => {
    const session = c.get("session");
    requirePermission(session, "execution:read");
    const execution = await deps.store.getExecution(session.tenant.id, c.req.param("id"));
    if (!execution) throw new CopilotError("not_found", "Execution not found.", 404);
    return c.json(toPublicExecution(execution));
  });

  /* ---------------- knowledge ---------------- */

  app.post("/api/knowledge/documents", async (c) => {
    const session = c.get("session");
    requirePermission(session, "knowledge:write");
    const body = z
      .object({
        title: z.string().min(2).max(200),
        content: z.string().min(10).max(200_000),
        applicationId: z.string().nullable().default(null),
        kind: z.enum(["sop", "doc"]).default("sop"),
      })
      .parse(await c.req.json());
    const result = await deps.knowledge.ingest({
      tenantId: session.tenant.id,
      applicationId: body.applicationId,
      title: body.title,
      kind: body.kind,
      content: body.content,
    });
    return c.json(result, 201);
  });

  app.get("/api/knowledge/search", async (c) => {
    const session = c.get("session");
    requirePermission(session, "workflow:read");
    const query = c.req.query("q") ?? "";
    if (query.trim().length < 2) {
      throw new CopilotError("invalid_request", "Query is too short.", 400);
    }
    return c.json(await deps.knowledge.search(session.tenant.id, query, 5));
  });

  /* ---------------- Stagehand (AI browser path) ---------------- */

  app.post("/api/stagehand/tasks", async (c) => {
    const session = c.get("session");
    requirePermission(session, "skill:execute");
    const body = z
      .object({ url: z.string().url(), instruction: z.string().min(4).max(500) })
      .parse(await c.req.json());
    // Consequential language on an AI-driven session always needs approval, and
    // this route never approves on the caller's behalf.
    const result = await runStagehandTask({
      url: body.url,
      instruction: body.instruction,
    });
    logger({
      event: "stagehand.task",
      tenantId: session.tenant.id,
      url: body.url,
      ok: result.ok,
    });
    return c.json(result);
  });

  return app;
}

async function paramsForWorkflow(
  workflow: Workflow,
): Promise<Skill["requiredInputs"]> {
  if (workflow.bundlePath) {
    try {
      const inspected = await inspectBundle(workflow.bundlePath);
      if (inspected.params.length > 0) return inspected.params;
    } catch {
      /* fall through to the step-derived parameters */
    }
  }
  const fromSteps = new Map<string, Skill["requiredInputs"][number]>();
  for (const step of workflow.steps) {
    if (!step.paramName) continue;
    if (fromSteps.has(step.paramName)) continue;
    fromSteps.set(step.paramName, {
      name: step.paramName,
      label: (step.fieldLabel ?? step.paramName).replace(/_/g, " "),
      required: true,
      secret: step.isSecret,
    });
  }
  return [...fromSteps.values()];
}

async function loadContexts(deps: ApiDeps, tenantId: string): Promise<SkillContext[]> {
  const skills = await deps.store.listSkills(tenantId, "active");
  const contexts: SkillContext[] = [];
  for (const skill of skills) {
    const workflow = await deps.store.getWorkflow(tenantId, skill.workflowId);
    if (workflow && workflow.status === "approved") {
      contexts.push({ skill, workflow });
    }
  }
  return contexts;
}

export type { Context };
