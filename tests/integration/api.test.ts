/**
 * API integration tests.
 *
 * These run the real HTTP app (Hono `fetch`), the real PostgreSQL (PGlite)
 * repositories, the real system-of-record verification (against the real demo
 * application), and a fake workflow engine.
 *
 * The fake engine is what makes the important assertion cheap: it can report
 * "success" without writing anything, which is exactly the failure mode the
 * copilot must never call success. Engine behaviour is independent of the
 * oracle, so the outcome can only be right if verification really decides it.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { envUrl, type Application, type Skill, type VerificationContract } from "@copilot/shared";
import { KnowledgeEngine, Store, openDb, type Sql } from "@copilot/knowledge";
import type {
  CompileRequest,
  EngineCompileResult,
  EngineProbe,
  EngineRecordingResult,
  EngineReplayResult,
  ReplayRequest,
  WorkflowEngine,
} from "@copilot/workflow";
import { createApp } from "../../apps/api/src/app.js";

const CRM_PORT = Number(process.env.TEST_CRM_PORT ?? 4300);

let dir: string;
let artifacts: string;
let sql: Sql;
let store: Store;
let knowledge: KnowledgeEngine;
let demoApps: ChildProcess | null = null;
let app: ReturnType<typeof createApp>;

/**
 * The demo applications run as their own process, exactly as `pnpm dev:demo`
 * starts them, so this test exercises the HTTP surface rather than an in-test
 * copy of it.
 */
async function startDemoApps(dataDir: string): Promise<void> {
  // Refuse to run against a server this test did not start: a leftover demo
  // app keeps its own database, and a "fresh" run would silently verify
  // against stale records.
  try {
    const existing = await fetch(`http://127.0.0.1:${CRM_PORT}/api/status`);
    if (existing.ok) {
      throw new Error(
        `port ${CRM_PORT} is already serving a demo application; stop it before running the integration suite`,
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("already serving")) throw error;
    // Connection refused is the expected path.
  }
  const tsxCli = path.resolve("node_modules/tsx/dist/cli.mjs");
  demoApps = spawn(process.execPath, [tsxCli, "apps/demo/src/main.ts"], {
    env: {
      ...process.env,
      DEMO_DATA_DIR: dataDir,
      DEMO_CRM_PORT: String(CRM_PORT),
      DEMO_STOCK_PORT: String(Number(CRM_PORT) + 100),
    },
    stdio: "ignore",
    windowsHide: true,
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${CRM_PORT}/api/status`);
      if (response.ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("the demo applications did not start in time");
}

async function stopDemoApps(): Promise<void> {
  if (!demoApps) return;
  const child = demoApps;
  demoApps = null;
  child.kill();
  if (child.exitCode !== null) return;
  // Wait for the process to release its SQLite files before the temp directory
  // is deleted; on Windows an ORPHANED server keeps acme.db locked (EBUSY).
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** The engine's vertical: "write" performs the business action, "claim" lies. */
type EngineBehaviour = "write" | "claim" | "crash";
let behaviour: EngineBehaviour = "write";

/** Steps mirroring the demonstration, as a compiled bundle would describe it. */
const BUNDLE_STEPS = [
  {
    id: "s0",
    intent: "Open the new customer form",
    action: "click",
    risk: "reversible",
    anchor: { structural: { selector: "#new-customer", role: "button", name: "New customer" } },
  },
  {
    id: "s1",
    intent: "Focus the company name field",
    action: "click",
    risk: "reversible",
    anchor: { structural: { selector: "#customer-name", role: "textbox", name: "Company name" } },
  },
  {
    id: "s2",
    intent: "Type the company name",
    action: "type",
    param: "company_name",
    field_label: "Company name",
    risk: "reversible",
    anchor: { structural: { selector: "#customer-name", role: "textbox", name: "Company name" } },
  },
  {
    id: "s3",
    intent: "Focus the contact email field",
    action: "click",
    risk: "reversible",
    anchor: { structural: { selector: "#customer-email", role: "textbox", name: "Contact email" } },
  },
  {
    id: "s4",
    intent: "Type the contact email",
    action: "type",
    param: "email",
    field_label: "Contact email",
    risk: "reversible",
    anchor: { structural: { selector: "#customer-email", role: "textbox", name: "Contact email" } },
  },
  {
    id: "s5",
    intent: "Save the customer",
    action: "click",
    risk: "irreversible",
    anchor: { structural: { selector: "#save-customer", role: "button", name: "Save customer" } },
  },
];

const fakeEngine: WorkflowEngine = {
  kind: "fake-engine",
  async probe(): Promise<EngineProbe> {
    return {
      ok: true,
      python: "test",
      engine: { name: "fake-engine", version: "0.0.0", path: "memory" },
      chromiumInstalled: true,
    };
  },
  async recordScripted(request): Promise<EngineRecordingResult> {
    const recordingDir = request.outDir;
    await mkdir(recordingDir, { recursive: true });
    await writeFile(path.join(recordingDir, "events.jsonl"), "{}\n", "utf8");
    return { ok: true, recordingDir, title: "Create customer", events: 1, frames: 1 };
  },
  async recordInteractive(request) {
    // Stand-in for a headed recorder: the API considers the session live until
    // `stop()` resolves it, exactly like the real bridge waiting for the admin.
    await mkdir(request.outDir, { recursive: true });
    await writeFile(path.join(request.outDir, "events.jsonl"), "{}\n", "utf8");
    let finish: (value: EngineRecordingResult) => void = () => {};
    const result = new Promise<EngineRecordingResult>((resolve) => {
      finish = resolve;
    });
    return {
      result,
      stop: async () => {
        finish({
          ok: true,
          recordingDir: request.outDir,
          title: "Interactive recording",
          events: 1,
          frames: 1,
        });
      },
    };
  },
  async compile(request: CompileRequest): Promise<EngineCompileResult> {
    await mkdir(request.bundleDir, { recursive: true });
    const bundle = {
      schema_version: 1,
      name: request.name,
      param_specs: [
        { name: "company_name", required: true },
        { name: "email", required: true },
      ],
      secret_params: [],
      steps: BUNDLE_STEPS,
    };
    const file = path.join(request.bundleDir, "workflow.json");
    await writeFile(file, JSON.stringify(bundle, null, 2), "utf8");
    return { ok: true, bundleDir: request.bundleDir, workflowJson: file };
  },
  async replay(request: ReplayRequest): Promise<EngineReplayResult> {
    const base = {
      reportPath: path.join(request.runDir, "report.json"),
      transactionOutcome: "COMMITTED",
      haltReason: null,
      haltIntent: null,
      rungCounts: { structural: BUNDLE_STEPS.length },
      healCount: 0,
      modelCalls: 0,
      totalMs: 5,
      stepsTotalMs: 5,
      engineOverheadMs: 0,
      steps: BUNDLE_STEPS.map((step, index) => ({
        index,
        stepId: step.id,
        intent: step.intent,
        ok: behaviour !== "crash",
        skipped: false,
        rung: behaviour === "crash" ? null : "structural",
        postconditionsOk: behaviour !== "crash",
        identityOk: behaviour !== "crash",
        risk: step.risk,
        error: behaviour === "crash" ? "engine crashed before the write" : null,
        durationMs: 5,
        inputVerified: null,
        fieldRead: null,
        failureCategory: null,
      })),
    };
    if (behaviour === "crash") {
      return {
        ...base,
        ok: true,
        success: false,
        executionOutcome: "HALTED",
        haltReason: "crash",
        haltIntent: "Save the customer",
      };
    }
    await mkdir(request.runDir, { recursive: true });
    await writeFile(
      path.join(request.runDir, "report.json"),
      JSON.stringify({ success: true }, null, 2),
      "utf8",
    );
    if (behaviour === "claim") {
      // The dangerous case: the UI appeared to work, nothing was persisted.
      return { ...base, ok: true, success: true, executionOutcome: "COMPLETED" };
    }
    // A real UI save: the application is what actually writes the record.
    const response = await fetch(`http://127.0.0.1:${CRM_PORT}/api/customers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: request.params["company_name"],
        email: request.params["email"],
        tier: "Standard",
      }),
    });
    if (!response.ok) {
      // What a real engine report carries when the app refuses the write: a
      // safety halt, no policy refusal record, and the app's own error text.
      return {
        ...base,
        ok: true,
        success: false,
        executionOutcome: "HALTED",
        haltReason: `application rejected the write: HTTP ${response.status}`,
        haltIntent: "Save the customer",
        haltObservedTexts: ["Save failed: Downstream validation rejected this customer"],
        steps: base.steps.map((step, index) =>
          index === base.steps.length - 1
            ? { ...step, ok: false, safetyHalt: true, failureCategory: "safety_halt" }
            : step,
        ),
      };
    }
    return { ...base, ok: true, success: true, executionOutcome: "COMPLETED" };
  },
};

async function call<T = any>(
  method: string,
  route: string,
  options: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.token) headers["authorization"] = `Bearer ${options.token}`;
  const response = await app.request(route, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
}

interface Session {
  token: string;
}

async function login(email: string, tenantSlug = "acme-demo"): Promise<Session> {
  const response = await call<Session>("POST", "/api/auth/login", {
    body: { tenantSlug, email },
  });
  expect(response.status).toBe(200);
  return response.body;
}

// Compiling a recording is a database write plus a bundle read. On embedded
// PostgreSQL that lands in well under a second; against a remote server (Neon)
// the first one has been measured at 15.7s, so a 15s budget failed a pipeline
// that was working. Wait long enough for the remote case; a genuinely stuck
// recording still fails, just later.
async function waitForCompiled(token: string, recordingId: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { body } = await call<{
      recording: { status: string; error: string | null; mode: string };
      workflow: any;
    }>("GET", `/api/recordings/${recordingId}`, { token });
    if (body.recording.status !== "recording") return body;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("recording did not finish in time");
}

let adminToken: string;
let employeeToken: string;
let outsiderToken: string;
let application: Application;
let workflowId: string;
let skill: Skill;

/**
 * This suite tests policy, persistence and plumbing - not the provider. Model
 * credentials are removed for its duration so a developer with a real key in
 * `.env` gets the same deterministic results as CI, and so no test makes a
 * network call. The provider itself is covered by the unit tests and by
 * `pnpm check:groq`.
 */
const MODEL_KEYS = ["GROQ_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "LLM_PROVIDER"];
const savedModelEnv = new Map<string, string | undefined>();

beforeAll(async () => {
  for (const key of MODEL_KEYS) {
    savedModelEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  dir = await mkdtemp(path.join(tmpdir(), "copilot-integration-"));
  artifacts = path.join(dir, "artifacts");
  await mkdir(artifacts, { recursive: true });
  await startDemoApps(path.join(dir, "demo"));

  // The same suite runs against a real PostgreSQL when asked, which is how the
  // pgvector path is exercised. A placeholder (`YOUR_...`) counts as unset:
  // treating documentation as a URL would fail like an outage.
  const testUrl = envUrl("TEST_DATABASE_URL");
  sql = testUrl
    ? await openDb({ url: testUrl })
    : await openDb({ dataDir: path.join(dir, "pg") });
  store = new Store(sql);
  knowledge = new KnowledgeEngine(store);
  app = createApp({ store, engine: fakeEngine, knowledge, artifactRoot: artifacts });

  const tenant = await store.ensureTenant("acme-demo", "Acme Demo Corp");
  await store.ensureUser(tenant.id, "admin@acme.test", "Ada Admin", "admin");
  await store.ensureUser(tenant.id, "employee@acme.test", "Eve Employee", "employee");
  const otherTenant = await store.ensureTenant("other-tenant", "Other Tenant Inc");
  await store.ensureUser(otherTenant.id, "admin@other.test", "Otto Outsider", "admin");
  // A remote test database keeps its rows between runs. Registering the same
  // application again would give the tenant two rows with the same base URL, and
  // `findApplicationForUrl` would resolve whichever came first - so `/api/context`
  // would report the older row and none of this run's skills. Reuse it instead.
  const existing = (await store.listApplications(tenant.id)).find(
    (a) => a.name === "AcmeDesk CRM" && a.baseUrl === `http://127.0.0.1:${CRM_PORT}`,
  );
  application =
    existing ??
    (await store.createApplication({
      tenantId: tenant.id,
      name: "AcmeDesk CRM",
      baseUrl: `http://127.0.0.1:${CRM_PORT}`,
      verificationBaseUrl: `http://127.0.0.1:${CRM_PORT}`,
      kind: "browser",
    }));
  adminToken = (await login("admin@acme.test")).token;
  employeeToken = (await login("employee@acme.test")).token;
  outsiderToken = (await login("admin@other.test", "other-tenant")).token;
});

afterAll(async () => {
  await sql?.close();
  await stopDemoApps();
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  for (const [key, value] of savedModelEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("authorization", () => {
  it("rejects unauthenticated API calls", async () => {
    const response = await call("GET", "/api/workflows");
    expect(response.status).toBe(401);
  });

  it("does not let an employee approve a workflow", async () => {
    const response = await call("POST", "/api/workflows/does-not-exist/approve", {
      token: employeeToken,
      body: {},
    });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("forbidden");
  });

  it("reports an unknown tenant's workflow as not found, not forbidden", async () => {
    const response = await call("GET", "/api/workflows/nope", { token: adminToken });
    expect(response.status).toBe(404);
  });
});

describe("record -> compile -> approve", () => {
  const verification: VerificationContract = {
    kind: "http",
    tier: "system_of_record",
    url: `http://127.0.0.1:${CRM_PORT}/api/customers?name={company_name}`,
    recordPath: "items",
    expect: { name: "company_name", email: "email" },
    match: "equals",
  };

  it("records a demonstration and stores a draft workflow", async () => {
    const started = await call<{ id: string; recording: boolean }>(
      "POST",
      "/api/recordings",
      {
        token: adminToken,
        body: { applicationId: application.id, mode: "scripted" },
      },
    );
    expect(started.status).toBe(202);
    expect(started.body.recording).toBe(true);

    const finished = await waitForCompiled(adminToken, started.body.id);
    expect(finished.recording.status).toBe("compiled");
    expect(finished.recording.error).toBeNull();
    expect(finished.workflow?.status).toBe("draft");
    expect(finished.workflow?.steps).toHaveLength(BUNDLE_STEPS.length);
    workflowId = finished.workflow!.id;
  });

  it("refuses to approve an irreversible workflow without acknowledgement", async () => {
    const response = await call("POST", `/api/workflows/${workflowId}/approve`, {
      token: adminToken,
      body: { name: "Create customer" },
    });
    expect(response.status).toBe(400);
    expect(response.body.error.detail.irreversibleSteps).toBeTruthy();
  });

  it("approves the workflow into an active skill bound to a verification contract", async () => {
    const response = await call<{ workflow: { status: string }; skill: Skill }>(
      "POST",
      `/api/workflows/${workflowId}/approve`,
      {
        token: adminToken,
        body: {
          name: "Create customer",
          description: "Creates a customer in AcmeDesk CRM",
          triggeredBy: ["customer", "client", "crm"],
          verification,
          acknowledgeRisk: true,
        },
      },
    );
    expect(response.status).toBe(201);
    expect(response.body.workflow.status).toBe("approved");
    skill = response.body.skill;
    expect(skill.status).toBe("active");
    expect(skill.requiredInputs.map((p) => p.name).sort()).toEqual([
      "company_name",
      "email",
    ]);
    expect(skill.verification?.kind).toBe("http");
  });
});

describe("employee request -> plan -> guarded execution", () => {
  let planId: string;

  it("selects the approved skill from natural language and extracts new inputs", async () => {
    const response = await call<any>("POST", "/api/plans", {
      token: employeeToken,
      body: {
        intent:
          'Create a customer named "Northwind Freight" with contact ops@northwind.test',
      },
    });
    expect(response.status).toBe(200);
    expect(response.body.plan.skillId).toBe(skill.id);
    expect(response.body.plan.blockers).toEqual([]);
    expect(response.body.plan.requiresApproval).toBe(true);
    expect(response.body.plan.resolvedInputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "company_name", value: "Northwind Freight" }),
        expect.objectContaining({ name: "email", value: "ops@northwind.test" }),
      ]),
    );
    planId = response.body.plan.id;
  });

  it("refuses to execute an irreversible workflow without explicit approval", async () => {
    const response = await call<any>("POST", "/api/executions", {
      token: employeeToken,
      body: { planId, inputs: {}, approved: false },
    });
    expect(response.status).toBe(201);
    expect(response.body.outcome).toBe("REJECTED_POLICY");
    expect(response.body.status).toBe("failed");
  });

  it("verifies the business effect in the system of record, not by UI success", async () => {
    behaviour = "write";
    const response = await call<any>("POST", "/api/executions", {
      token: employeeToken,
      body: { planId, inputs: {}, approved: true },
    });
    expect(response.status).toBe(201);
    expect(response.body.outcome).toBe("VERIFIED");
    expect(response.body.verification?.passed).toBe(true);
    expect(response.body.verification?.tier).toBe("system_of_record");
    // M4: every run records whether memory was consulted, and the answer here
    // is "enabled, nothing applicable yet".
    expect(response.body.memory?.mode).toBe("enabled");
    expect(response.body.memory?.appliedRepairIds).toEqual([]);

    const oracle = await fetch(
      `http://127.0.0.1:${CRM_PORT}/api/customers?name=Northwind%20Freight`,
    );
    const body = await oracle.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].email).toBe("ops@northwind.test");
  });

  it("refuses a second run because the record already exists", async () => {
    const again = await call<any>("POST", "/api/plans", {
      token: employeeToken,
      body: {
        intent:
          'Create a customer named "Northwind Freight" with contact ops@northwind.test',
      },
    });
    const response = await call<any>("POST", "/api/executions", {
      token: employeeToken,
      body: { planId: again.body.plan.id, inputs: {}, approved: true },
    });
    expect(response.body.outcome).toBe("REJECTED");
    expect(response.body.message).toContain("already exists");
  });

  it("reports FAILED when the engine claims success but the record is absent", async () => {
    const plan = await call<any>("POST", "/api/plans", {
      token: employeeToken,
      body: {
        intent: 'Create a customer named "Contoso Marine" with contact ops@contoso.test',
      },
    });
    behaviour = "claim";
    const response = await call<any>("POST", "/api/executions", {
      token: employeeToken,
      body: { planId: plan.body.plan.id, inputs: {}, approved: true },
    });
    expect(response.body.engineOutcome).toBe("COMPLETED");
    expect(response.body.outcome).toBe("FAILED");
    expect(response.body.verification?.passed).toBe(false);
    expect(response.body.message).toContain("does not contain the record");
    behaviour = "write";
  });

  it("reports FAILED when the application rejects the write", async () => {
    await fetch(`http://127.0.0.1:${CRM_PORT}/api/faults`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "reject-create" }),
    });
    const plan = await call<any>("POST", "/api/plans", {
      token: employeeToken,
      body: {
        intent: 'Create a customer named "Fabrikam Rail" with contact ops@fabrikam.test',
      },
    });
    const response = await call<any>("POST", "/api/executions", {
      token: employeeToken,
      body: { planId: plan.body.plan.id, inputs: {}, approved: true },
    });
    expect(response.body.outcome).toBe("FAILED");
    expect(response.body.verification?.passed).toBe(false);
    // P0: a write the application rejected is an application failure, not a
    // policy refusal and not an unexplained halt.
    expect(response.body.failure?.origin).toBe("application");
    expect(response.body.failure?.code).toBe("APPLICATION_REJECTED");
    expect(response.body.failure?.evidence?.applicationEvidence?.messages).toEqual([
      expect.stringContaining("Save failed"),
    ]);

    await fetch(`http://127.0.0.1:${CRM_PORT}/api/faults`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "none" }),
    });
  });

  it("rejects an unknown input instead of silently ignoring it", async () => {
    const plan = await call<any>("POST", "/api/plans", {
      token: employeeToken,
      body: { intent: "create a customer named Globex" },
    });
    const response = await call<any>("POST", "/api/executions", {
      token: employeeToken,
      body: { planId: plan.body.plan.id, inputs: { tier: "Enterprise" }, approved: true },
    });
    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain("Unknown input");
  });
});

describe("interactive Learn My App", () => {
  // This drives the real interactive recorder (headed Chromium). Against a remote
  // test database the round-trips push it past the default 30s budget.
  it("keeps the session live until the admin stops it, then compiles a draft", { timeout: 60_000 }, async () => {
    const started = await call<any>("POST", "/api/recordings", {
      token: adminToken,
      body: {
        applicationId: application.id,
        mode: "interactive",
        paramFields: ["company_name", "email"],
      },
    });
    expect(started.status).toBe(202);
    expect(started.body.mode).toBe("interactive");
    expect(started.body.interactive).toBe(true);

    const live = await call<any>("GET", `/api/recordings/${started.body.id}`, {
      token: adminToken,
    });
    expect(live.body.recording.status).toBe("recording");

    const stopped = await call<any>("POST", `/api/recordings/${started.body.id}/stop`, {
      token: adminToken,
      body: {},
    });
    expect(stopped.status).toBe(202);
    expect(stopped.body.stopping).toBe(true);

    const finished = await waitForCompiled(adminToken, started.body.id);
    expect(finished.recording.status).toBe("compiled");
    expect(finished.recording.mode).toBe("interactive");
    expect(finished.workflow.status).toBe("draft");
    expect(finished.workflow.steps).toHaveLength(BUNDLE_STEPS.length);
  });

  it("reports a stop for a recording that is not live", async () => {
    const response = await call<any>("POST", "/api/recordings/does-not-exist/stop", {
      token: adminToken,
      body: {},
    });
    expect(response.status).toBe(404);
  });

  it("persists plans and scopes them to the tenant that created them", async () => {
    const created = await call<any>("POST", "/api/plans", {
      token: employeeToken,
      body: { intent: "create a customer named Persisted Plan Ltd" },
    });
    expect(created.status).toBe(200);
    const planId = created.body.plan.id;

    // The same token, after a fresh API instance, can still read the plan.
    const sameTenant = await call<any>("GET", `/api/plans/${planId}`, {
      token: employeeToken,
    });
    expect(sameTenant.status).toBe(200);
    expect(sameTenant.body.id).toBe(planId);

    const otherTenant = await call<any>("GET", `/api/plans/${planId}`, {
      token: outsiderToken,
    });
    expect(otherTenant.status).toBe(404);

    const execute = await call<any>("POST", "/api/executions", {
      token: outsiderToken,
      body: { planId, inputs: {}, approved: true },
    });
    expect(execute.status).toBe(404);
  });

  it("keeps recording controls to admins", async () => {
    const start = await call<any>("POST", "/api/recordings", {
      token: employeeToken,
      body: { applicationId: application.id, mode: "interactive" },
    });
    expect(start.status).toBe(403);
    const stop = await call<any>("POST", "/api/recordings/any/stop", {
      token: employeeToken,
      body: {},
    });
    expect(stop.status).toBe(403);
  });
});

describe("extension-facing endpoints", () => {
  it("reports the application and suggested skills for a landing page", async () => {
    const response = await call<any>(
      "GET",
      `/api/context?url=${encodeURIComponent(`http://127.0.0.1:${CRM_PORT}/`)}`,
      { token: employeeToken },
    );
    expect(response.status).toBe(200);
    expect(response.body.appName).toBe("AcmeDesk CRM");
    expect(response.body.suggestedSkills.map((s: { name: string }) => s.name)).toContain(
      "Create customer",
    );
  });

  it("refuses to choose between duplicate application rows, then accepts an explicit choice", async () => {
    // A historical duplicate: same tenant, same identity, no rows merged. The
    // API must not pick one for the user.
    const duplicate = await store.createApplication({
      tenantId: (await store.ensureTenant("acme-demo", "Acme Demo Corp")).id,
      name: "AcmeDesk CRM",
      baseUrl: `http://127.0.0.1:${CRM_PORT}`,
    });
    try {
      const ambiguous = await call<any>(
        "GET",
        `/api/context?url=${encodeURIComponent(`http://127.0.0.1:${CRM_PORT}/`)}`,
        { token: employeeToken },
      );
      expect(ambiguous.status).toBe(409);
      expect(ambiguous.body.error.code).toBe("application_ambiguous");
      const candidates = ambiguous.body.error.detail.candidates as { id: string }[];
      expect(candidates.length).toBeGreaterThanOrEqual(2);

      const chosen = await call<any>(
        "GET",
        `/api/context?url=${encodeURIComponent(
          `http://127.0.0.1:${CRM_PORT}/`,
        )}&applicationId=${application.id}`,
        { token: employeeToken },
      );
      expect(chosen.status).toBe(200);
      expect(chosen.body.applicationId).toBe(application.id);
      expect(chosen.body.suggestedSkills.map((s: { name: string }) => s.name)).toContain(
        "Create customer",
      );

      // A choice that names another tenant's row is not honoured.
      const foreign = await call<any>(
        "GET",
        `/api/context?url=${encodeURIComponent(
          `http://127.0.0.1:${CRM_PORT}/`,
        )}&applicationId=${duplicate.id.replace(/[0-9a-f]/g, "0")}`,
        { token: employeeToken },
      );
      expect(foreign.status).toBe(404);
    } finally {
      await sql.query("DELETE FROM applications WHERE id = $1", [duplicate.id]);
    }
  });

  it("registers an application once per identity", async () => {
    const first = await call<any>("POST", "/api/applications", {
      token: adminToken,
      body: { name: "Idempotent App", baseUrl: `http://127.0.0.1:${CRM_PORT}/` },
    });
    const second = await call<any>("POST", "/api/applications", {
      token: adminToken,
      body: { name: "Idempotent App", baseUrl: `http://127.0.0.1:${CRM_PORT}` },
    });
    expect([200, 201]).toContain(first.status);
    expect([200, 201]).toContain(second.status);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.reused).toBe(true);
  });

  it("cancels only a live recording and refuses anything else", async () => {
    const cancel = await call<any>("POST", "/api/recordings/no-such-recording/cancel", {
      token: adminToken,
      body: {},
    });
    expect(cancel.status).toBe(404);

    const employeeCancel = await call<any>("POST", "/api/recordings/no-such-recording/cancel", {
      token: employeeToken,
      body: {},
    });
    expect(employeeCancel.status).toBe(403);
  });

  it("refuses a controlled browser session for an unregistered page", async () => {
    const response = await call<any>("POST", "/api/stagehand/sessions", {
      token: employeeToken,
      body: {
        url: "http://127.0.0.1:4999/unregistered",
        instruction: "open the dashboard",
        approved: true,
      },
    });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("invalid_request");
  });

  it("never plans a skill from a different application than the page's", async () => {
    const tenant = await store.ensureTenant("acme-demo", "Acme Demo Corp");
    const stock = await store.createApplication({
      tenantId: tenant.id,
      name: "StockDesk",
      baseUrl: `http://127.0.0.1:${Number(CRM_PORT) + 100}`,
    });
    const workflow = await store.createWorkflow({
      tenantId: tenant.id,
      applicationId: stock.id,
      name: "Register stock item",
      description: null,
      bundlePath: null,
      recordingId: null,
      steps: [],
      uncertainty: [],
    });
    await store.setWorkflowStatus(tenant.id, workflow.id, "approved");
    const stockSkill = await store.createSkill({
      tenantId: tenant.id,
      workflowId: workflow.id,
      name: "Register stock item",
      description: "Registers stock in StockDesk",
      requiredInputs: [],
      triggeredBy: ["stock", "sku", "warehouse"],
      verification: null,
      approvedBy: "admin@acme.test",
    });
    try {
      const unrestricted = await call<any>("POST", "/api/plans", {
        token: employeeToken,
        body: { intent: "Register stock item SKU-8842 with quantity 40" },
      });
      expect(unrestricted.body.plan.skillId).toBe(stockSkill.id);

      const scoped = await call<any>("POST", "/api/plans", {
        token: employeeToken,
        body: {
          intent: "Register stock item SKU-8842 with quantity 40",
          applicationId: application.id,
        },
      });
      expect(scoped.body.plan.skillId).not.toBe(stockSkill.id);

      const foreign = await call<any>("POST", "/api/plans", {
        token: employeeToken,
        body: { intent: "Register stock item SKU-8842", applicationId: stock.id },
      });
      expect(foreign.status).toBe(200);
    } finally {
      await sql.query("DELETE FROM skills WHERE id = $1", [stockSkill.id]);
      await sql.query("DELETE FROM workflows WHERE id = $1", [workflow.id]);
      await sql.query("DELETE FROM applications WHERE id = $1", [stock.id]);
    }
  });

  it("refuses a consequential AI session before opening a browser", async () => {
    const response = await call<any>("POST", "/api/stagehand/sessions", {
      token: employeeToken,
      body: {
        url: `http://127.0.0.1:${CRM_PORT}/`,
        instruction: "delete every customer record",
        approved: false,
      },
    });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("conflict");
  });

  it("does not reveal another tenant's browser session", async () => {
    const response = await call<any>("GET", "/api/stagehand/sessions/00000000-0000-0000-0000-000000000000", {
      token: outsiderToken,
    });
    expect(response.status).toBe(404);
  });

  it("returns real guidance with a recorded selector, and never a guessed one", async () => {
    const first = await call<any>(
      "GET",
      `/api/guidance?skillId=${skill.id}&stepIndex=0`,
      { token: employeeToken },
    );
    expect(first.status).toBe(200);
    expect(first.body.selector).toBe("#new-customer");
    expect(first.body.highlightable).toBe(true);
    expect(first.body.totalSteps).toBe(BUNDLE_STEPS.length);

    const missing = await call<any>(
      "GET",
      `/api/guidance?skillId=${skill.id}&stepIndex=99`,
      { token: employeeToken },
    );
    expect(missing.status).toBe(404);
  });

  it("reports capability status honestly for the environment it runs in", async () => {
    const response = await call<any>("GET", "/api/capabilities");
    expect(response.status).toBe(200);
    expect(response.body.database.kind).toBe(envUrl("TEST_DATABASE_URL") ? "postgres" : "pglite");
    expect(response.body.database.tenancyEnforced).toBe(true);
    // Embeddings have no provider in this project yet, whatever else is set.
    expect(response.body.vectorSearch.status).not.toBe("configured");
    // This suite runs with model credentials removed (see beforeAll), so the
    // honest answer here is "unconfigured": it must not claim coverage.
    expect(response.body.llm.status).toBe("unconfigured");
    expect(response.body.llm.provider).toBeNull();
  });

  it("labels a configured provider, without calling it", async () => {
    process.env.GROQ_API_KEY = "gsk_unit_test_key_not_real";
    try {
      const response = await call<any>("GET", "/api/capabilities");
      expect(response.body.llm.status).toBe("configured");
      expect(response.body.llm.provider).toBe("groq");
      expect(response.body.stagehand.status).toBe("configured");
    } finally {
      delete process.env.GROQ_API_KEY;
    }
  });

  it("reports Stagehand as installed but unconfigured, not blocked", async () => {
    const response = await call<any>("GET", "/api/capabilities");
    expect(response.body.stagehand.status).toBe("unconfigured");
    expect(response.body.stagehand.detail).toContain("GROQ_API_KEY");
  });

  it("refuses a consequential Stagehand instruction without approval", async () => {
    const refused = await call<any>("POST", "/api/stagehand/tasks", {
      token: adminToken,
      body: {
        url: `http://127.0.0.1:${CRM_PORT}/`,
        instruction: "delete every customer record",
      },
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toContain("approved: true");

    const approved = await call<any>("POST", "/api/stagehand/tasks", {
      token: adminToken,
      body: {
        url: `http://127.0.0.1:${CRM_PORT}/`,
        instruction: "delete every customer record",
        approved: true,
      },
    });
    // Approved, but no model credentials in this environment: blocked, never faked.
    expect(approved.status).toBe(503);
  });

  it("returns execution history for the extension to display", async () => {
    const response = await call<any>("GET", "/api/executions", { token: employeeToken });
    expect(response.status).toBe(200);
    const outcomes = response.body.items.map((i: { outcome: string }) => i.outcome);
    expect(outcomes).toContain("VERIFIED");
    expect(outcomes).toContain("FAILED");
  });
});
