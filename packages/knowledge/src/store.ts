/**
 * Tenant-scoped repositories.
 *
 * Rule enforced by construction: every method that touches business data takes
 * `tenantId` as its first argument and binds it into the WHERE clause. There is
 * no "get by id without tenant" method, so a handler cannot accidentally read
 * another tenant's row: it would have to pass a tenant it does not own, and the
 * session's tenant comes from the bearer token, never from the request body.
 */
import { randomUUID } from "node:crypto";
import type {
  Application,
  Episode,
  ExecutionOutcome,
  ExecutionTimings,
  Plan,
  ExecutionStepResult,
  FailureOrigin,
  FailureResult,
  MemoryAudit,
  ParamSpec,
  RecordingMode,
  RecordingStatus,
  RecoverySummary,
  Repair,
  RepairAction,
  RepairStatus,
  Role,
  Skill,
  VerificationContract,
  VerificationResult,
  Workflow,
  WorkflowStatus,
  WorkflowStep,
} from "@copilot/shared";
import type { Sql } from "./db.js";

/**
 * Canonical form of an application's base URL.
 *
 * Identity is `scheme://host[:port][/path]`, so all of these describe one
 * application: `http://127.0.0.1:4300`, `http://127.0.0.1:4300/`,
 * `HTTP://127.0.0.1:4300//`, and `http://127.0.0.1:4300/?tab=home#top`.
 * A different path is a different application (`/crm` vs `/stock`), and a
 * different port is a different origin. Non-HTTP URLs have no application
 * identity at all, so they normalize to null instead of a guess.
 */
export function normalizeApplicationUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(String(raw).trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;
  const defaultPort =
    (url.protocol === "http:" && url.port === "80") ||
    (url.protocol === "https:" && url.port === "443");
  const port = url.port && !defaultPort ? `:${url.port}` : "";
  const pathname = url.pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  return `${url.protocol}//${url.hostname.toLowerCase()}${port}${pathname}`;
}

/**
 * The resolver's answer. `ambiguous` is a refusal, not a tie-break: two rows
 * with the same identity cannot both be "the" application, and picking one
 * arbitrarily is how a skill ends up executing against the wrong record.
 */
export type ApplicationResolution =
  | { status: "resolved"; application: Application; candidates: Application[] }
  | { status: "ambiguous"; application: null; candidates: Application[] }
  | { status: "none"; application: null; candidates: [] };

/** Serializes registration per (tenant, identity) inside this process. */
const registrationLocks = new Map<string, Promise<unknown>>();

async function withRegistrationLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = registrationLocks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(run);
  const guarded = next.catch(() => undefined);
  registrationLocks.set(key, guarded);
  try {
    return await next;
  } finally {
    if (registrationLocks.get(key) === guarded) registrationLocks.delete(key);
  }
}

export interface Tenant {
  id: string;
  slug: string;
  name: string;
}

export interface User {
  id: string;
  tenantId: string;
  email: string;
  displayName: string;
  role: Role;
}

export interface SessionRow {
  token: string;
  tenant: Tenant;
  user: User;
  expiresAt: string;
}

export interface RecordingRow {
  id: string;
  tenantId: string;
  applicationId: string;
  status: RecordingStatus;
  mode: RecordingMode;
  directory: string;
  workflowId: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface ExecutionRow {
  id: string;
  tenantId: string;
  skillId: string;
  workflowId: string;
  intent: string;
  inputs: Record<string, string>;
  status: "queued" | "running" | "succeeded" | "failed" | "halted";
  outcome: ExecutionOutcome | null;
  engineOutcome: string | null;
  engineReportPath: string | null;
  steps: ExecutionStepResult[];
  verification: VerificationResult | null;
  message: string | null;
  modelCalls: number;
  requestedBy: string | null;
  failure: FailureResult | null;
  timings: ExecutionTimings | null;
  recovery: RecoverySummary | null;
  /** Which stored repairs were considered and whether one was used (M4). */
  memory: MemoryAudit | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface DocumentChunkHit {
  chunkId: string;
  documentId: string;
  title: string;
  content: string;
  score: number;
  method: "keyword" | "vector";
}

const now = (): string => new Date().toISOString();

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  return [];
}

/**
 * JSONB arrives as an object on both backends, but a driver is free to hand
 * back the text it received. Parse defensively rather than trusting a shape.
 */
function asJson<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  return value as T;
}

function mapEpisode(row: Record<string, unknown>): Episode {
  return {
    id: String(row["id"]),
    tenantId: String(row["tenant_id"]),
    executionId: String(row["execution_id"]),
    skillId: String(row["skill_id"]),
    workflowId: String(row["workflow_id"]),
    applicationId: String(row["application_id"]),
    intent: String(row["intent"]),
    outcome: (row["outcome"] as ExecutionOutcome | null) ?? null,
    failure: asJson<FailureResult>(row["failure"]),
    recovery: asJson<RecoverySummary>(row["recovery"]),
    traceRef: (row["trace_ref"] as string | null) ?? null,
    context: asJson<Record<string, unknown>>(row["context"]) ?? {},
    createdAt: new Date(String(row["created_at"])).toISOString(),
  };
}

function mapRepair(row: Record<string, unknown>): Repair {
  return {
    id: String(row["id"]),
    tenantId: String(row["tenant_id"]),
    applicationId: String(row["application_id"]),
    workflowId: String(row["workflow_id"]),
    skillId: String(row["skill_id"]),
    workflowVersion: Number(row["workflow_version"]),
    failureOrigin: String(row["failure_origin"]) as FailureOrigin,
    failureCode: String(row["failure_code"]),
    action: asJson<RepairAction>(row["action"]) ?? {
      kind: "selector_override",
      stepIndex: 0,
      fromSelector: null,
      toSelector: "",
    },
    conditions: asJson<Record<string, unknown>>(row["conditions"]) ?? {},
    status: String(row["status"]) as RepairStatus,
    successCount: Number(row["success_count"]),
    failureCount: Number(row["failure_count"]),
    createdBy: (row["created_by"] as string | null) ?? null,
    reviewedBy: (row["reviewed_by"] as string | null) ?? null,
    createdAt: new Date(String(row["created_at"])).toISOString(),
    reviewedAt: row["reviewed_at"]
      ? new Date(String(row["reviewed_at"])).toISOString()
      : null,
    lastUsedAt: row["last_used_at"]
      ? new Date(String(row["last_used_at"])).toISOString()
      : null,
  };
}

/* ------------------------------------------------------------------ */
/* Mappers                                                             */
/* ------------------------------------------------------------------ */

function mapStep(row: Record<string, unknown>): WorkflowStep {
  return {
    id: String(row["id"]),
    index: Number(row["idx"]),
    intent: String(row["intent"]),
    action: String(row["action"]),
    risk: row["risk"] === "irreversible" ? "irreversible" : "reversible",
    anchorKind: String(row["anchor_kind"]) as WorkflowStep["anchorKind"],
    elementRole: (row["element_role"] as string | null) ?? null,
    elementName: (row["element_name"] as string | null) ?? null,
    selector: (row["selector"] as string | null) ?? null,
    ocrText: (row["ocr_text"] as string | null) ?? null,
    fieldLabel: (row["field_label"] as string | null) ?? null,
    paramName: (row["param_name"] as string | null) ?? null,
    isSecret: Boolean(row["is_secret"]),
    postconditions: (row["postconditions"] as WorkflowStep["postconditions"]) ?? [],
    confidence: String(row["confidence"]) as WorkflowStep["confidence"],
    uncertaintyNote: (row["uncertainty_note"] as string | null) ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

export class Store {
  constructor(
    readonly sql: Sql,
    private readonly log: (event: Record<string, unknown>) => void = () => {},
  ) {}

  /* ---------------- tenants, users, sessions ---------------- */

  async ensureTenant(slug: string, name: string): Promise<Tenant> {
    const existing = await this.sql.query<{ id: string; slug: string; name: string }>(
      "SELECT id, slug, name FROM tenants WHERE slug = $1",
      [slug],
    );
    const found = existing[0];
    if (found) return { id: found.id, slug: found.slug, name: found.name };
    const tenant: Tenant = { id: randomUUID(), slug, name };
    await this.sql.query(
      "INSERT INTO tenants (id, slug, name, created_at) VALUES ($1, $2, $3, $4)",
      [tenant.id, tenant.slug, tenant.name, now()],
    );
    this.log({ event: "tenant.created", tenantId: tenant.id, slug });
    return tenant;
  }

  async findTenantBySlug(slug: string): Promise<Tenant | null> {
    const rows = await this.sql.query<{ id: string; slug: string; name: string }>(
      "SELECT id, slug, name FROM tenants WHERE slug = $1",
      [slug],
    );
    const row = rows[0];
    return row ? { id: row.id, slug: row.slug, name: row.name } : null;
  }

  async ensureUser(
    tenantId: string,
    email: string,
    displayName: string,
    role: Role,
  ): Promise<User> {
    const existing = await this.sql.query<Record<string, unknown>>(
      "SELECT id, tenant_id, email, display_name, role FROM users WHERE tenant_id = $1 AND email = $2",
      [tenantId, email],
    );
    const row = existing[0];
    if (row) {
      return {
        id: String(row["id"]),
        tenantId: String(row["tenant_id"]),
        email: String(row["email"]),
        displayName: String(row["display_name"]),
        role: String(row["role"]) as Role,
      };
    }
    const user: User = { id: randomUUID(), tenantId, email, displayName, role };
    await this.sql.query(
      "INSERT INTO users (id, tenant_id, email, display_name, role, created_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [user.id, user.tenantId, user.email, user.displayName, user.role, now()],
    );
    return user;
  }

  async ensureRole(
    tenantId: string,
    name: string,
    permissions: readonly string[],
  ): Promise<void> {
    await this.sql.query(
      `INSERT INTO roles (id, tenant_id, name, permissions) VALUES ($1,$2,$3,$4::jsonb)
       ON CONFLICT (tenant_id, name) DO UPDATE SET permissions = EXCLUDED.permissions`,
      [randomUUID(), tenantId, name, JSON.stringify(permissions)],
    );
  }

  async findUserByEmail(tenantId: string, email: string): Promise<User | null> {
    const rows = await this.sql.query<Record<string, unknown>>(
      "SELECT id, tenant_id, email, display_name, role FROM users WHERE tenant_id = $1 AND email = $2",
      [tenantId, email],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: String(row["id"]),
      tenantId: String(row["tenant_id"]),
      email: String(row["email"]),
      displayName: String(row["display_name"]),
      role: String(row["role"]) as Role,
    };
  }

  async createSession(user: User, ttlMs = 12 * 60 * 60 * 1000): Promise<SessionRow> {
    const token = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    await this.sql.query(
      "INSERT INTO sessions (token, user_id, tenant_id, expires_at, created_at) VALUES ($1,$2,$3,$4,$5)",
      [token, user.id, user.tenantId, expiresAt, now()],
    );
    const tenantRows = await this.sql.query<{ id: string; slug: string; name: string }>(
      "SELECT id, slug, name FROM tenants WHERE id = $1",
      [user.tenantId],
    );
    const tenant = tenantRows[0];
    if (!tenant) throw new Error("tenant disappeared");
    return { token, tenant, user, expiresAt };
  }

  async getSession(token: string): Promise<SessionRow | null> {
    const rows = await this.sql.query<Record<string, unknown>>(
      `SELECT s.token, s.expires_at, s.user_id, t.id AS tenant_id, t.slug, t.name AS tenant_name,
              u.email, u.display_name, u.role
         FROM sessions s
         JOIN tenants t ON t.id = s.tenant_id
         JOIN users u ON u.id = s.user_id
        WHERE s.token = $1`,
      [token],
    );
    const row = rows[0];
    if (!row) return null;
    const expiresAt = new Date(String(row["expires_at"])).toISOString();
    if (Date.parse(expiresAt) < Date.now()) return null;
    return {
      token: String(row["token"]),
      expiresAt,
      tenant: {
        id: String(row["tenant_id"]),
        slug: String(row["slug"]),
        name: String(row["tenant_name"]),
      },
      user: {
        id: String(row["user_id"]),
        tenantId: String(row["tenant_id"]),
        email: String(row["email"]),
        displayName: String(row["display_name"]),
        role: String(row["role"]) as Role,
      },
    };
  }

  /* ---------------- applications ---------------- */

  async createApplication(input: {
    tenantId: string;
    name: string;
    baseUrl: string;
    verificationBaseUrl?: string | undefined;
    kind?: "browser" | "desktop" | undefined;
  }): Promise<Application> {
    const app: Application = {
      id: randomUUID(),
      tenantId: input.tenantId,
      name: input.name,
      baseUrl: input.baseUrl.replace(/\/$/, ""),
      kind: input.kind ?? "browser",
      verificationBaseUrl: (input.verificationBaseUrl ?? input.baseUrl).replace(/\/$/, ""),
      createdAt: now(),
    };
    await this.sql.query(
      `INSERT INTO applications (id, tenant_id, name, base_url, verification_base_url, kind, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        app.id,
        app.tenantId,
        app.name,
        app.baseUrl,
        app.verificationBaseUrl,
        app.kind,
        app.createdAt,
      ],
    );
    await this.upsertNode(app.tenantId, "application", app.id, app.name);
    return app;
  }

  /**
   * Register once per (tenant, normalized base URL).
   *
   * Existing rows are returned untouched: duplicates are never merged or
   * deleted here, because they may already carry workflows and audit records.
   * Two concurrent registrations for the same identity serialize, so only one
   * row is created. (A database unique index would be stronger, but it cannot
   * be added while historical duplicates exist - see PHASE6_VALIDATION.md.)
   */
  async ensureApplication(input: {
    tenantId: string;
    name: string;
    baseUrl: string;
    verificationBaseUrl?: string | undefined;
    kind?: "browser" | "desktop" | undefined;
  }): Promise<{ application: Application; created: boolean }> {
    const identity = normalizeApplicationUrl(input.baseUrl);
    if (!identity) {
      throw new Error(`"${input.baseUrl}" is not an http(s) URL, so it cannot identify an application.`);
    }
    return withRegistrationLock(`${input.tenantId}|${identity}`, async () => {
      const existing = (await this.listApplications(input.tenantId)).find(
        (app) => normalizeApplicationUrl(app.baseUrl) === identity,
      );
      if (existing) return { application: existing, created: false };
      return { application: await this.createApplication(input), created: true };
    });
  }

  async listApplications(tenantId: string): Promise<Application[]> {
    const rows = await this.sql.query<Record<string, unknown>>(
      "SELECT * FROM applications WHERE tenant_id = $1 ORDER BY created_at",
      [tenantId],
    );
    return rows.map((row) => ({
      id: String(row["id"]),
      tenantId: String(row["tenant_id"]),
      name: String(row["name"]),
      baseUrl: String(row["base_url"]),
      kind: String(row["kind"]) as Application["kind"],
      verificationBaseUrl: (row["verification_base_url"] as string | null) ?? null,
      createdAt: new Date(String(row["created_at"])).toISOString(),
    }));
  }

  async getApplication(tenantId: string, applicationId: string): Promise<Application | null> {
    const all = await this.listApplications(tenantId);
    return all.find((a) => a.id === applicationId) ?? null;
  }

  /**
   * Resolve a page URL to exactly one registered application of this tenant.
   *
   * Order of proof:
   *   1. an exact normalized identity match wins - but if there is more than
   *      one such row the answer is `ambiguous`, never "the oldest one";
   *   2. otherwise the longest base *path* that contains the request on a
   *      segment boundary wins (`/crm` matches `/crm/customers`, not `/crmx`),
   *      and a tie at that length is again `ambiguous`;
   *   3. anything else is `none`.
   *
   * Tenant scoping happens before matching: another tenant's row is not a
   * candidate at all, so it can neither win nor influence ambiguity.
   */
  async resolveApplicationForUrl(
    tenantId: string,
    url: string,
  ): Promise<ApplicationResolution> {
    const normalized = normalizeApplicationUrl(url);
    if (!normalized) return { status: "none", application: null, candidates: [] };

    const apps = (await this.listApplications(tenantId)).map((application) => ({
      application,
      identity: normalizeApplicationUrl(application.baseUrl),
    }));
    const usable = apps.filter(
      (entry): entry is { application: Application; identity: string } => entry.identity !== null,
    );

    const exact = usable.filter((entry) => entry.identity === normalized).map((e) => e.application);
    if (exact.length === 1) {
      return { status: "resolved", application: exact[0]!, candidates: exact };
    }
    if (exact.length > 1) return { status: "ambiguous", application: null, candidates: exact };

    const request = new URL(normalized);
    const requestPath = request.pathname;
    const containing = usable.filter(({ identity }) => {
      const base = new URL(identity);
      // A prefix is only meaningful inside the same origin: a root-path app on
      // another port is a different application, not the most general match.
      if (base.origin !== request.origin) return false;
      const basePath = base.pathname;
      if (basePath === "" || basePath === "/") return true;
      return requestPath === basePath || requestPath.startsWith(`${basePath}/`);
    });
    if (containing.length === 0) return { status: "none", application: null, candidates: [] };

    const longest = Math.max(...containing.map(({ identity }) => new URL(identity).pathname.length));
    const best = containing
      .filter(({ identity }) => new URL(identity).pathname.length === longest)
      .map((entry) => entry.application);
    if (best.length === 1) {
      return { status: "resolved", application: best[0]!, candidates: best };
    }
    return { status: "ambiguous", application: null, candidates: best };
  }

  /**
   * @deprecated Lossy by design: an ambiguous URL has no single answer. Kept for
   * callers that only need "is this page a known application"; use
   * `resolveApplicationForUrl` when the chosen row matters.
   */
  async findApplicationForUrl(tenantId: string, url: string): Promise<Application | null> {
    const resolution = await this.resolveApplicationForUrl(tenantId, url);
    return resolution.status === "resolved" ? resolution.application : null;
  }

  async upsertPage(
    tenantId: string,
    applicationId: string,
    pagePath: string,
    title: string,
  ): Promise<string> {
    const existing = await this.sql.query<{ id: string }>(
      "SELECT id FROM app_pages WHERE tenant_id = $1 AND application_id = $2 AND path = $3",
      [tenantId, applicationId, pagePath],
    );
    const found = existing[0];
    if (found) return found.id;
    const id = randomUUID();
    await this.sql.query(
      `INSERT INTO app_pages (id, tenant_id, application_id, path, title, discovered_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, tenantId, applicationId, pagePath, title, now()],
    );
    await this.upsertNode(tenantId, "page", id, title || pagePath);
    return id;
  }

  async upsertElement(input: {
    tenantId: string;
    applicationId: string;
    pageId: string;
    semanticName: string;
    elementRole: string | null;
    selector: string | null;
    label: string | null;
    state?: Record<string, unknown> | undefined;
    confidence: "identified" | "probable" | "unknown";
  }): Promise<string> {
    const id = randomUUID();
    await this.sql.query(
      `INSERT INTO ui_elements
         (id, tenant_id, application_id, page_id, semantic_name, element_role, selector, label, state, confidence, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`,
      [
        id,
        input.tenantId,
        input.applicationId,
        input.pageId,
        input.semanticName,
        input.elementRole,
        input.selector,
        input.label,
        JSON.stringify(input.state ?? {}),
        input.confidence,
        now(),
      ],
    );
    await this.upsertNode(input.tenantId, "element", id, input.semanticName);
    return id;
  }

  async listElements(tenantId: string, applicationId: string) {
    return this.sql.query<Record<string, unknown>>(
      "SELECT * FROM ui_elements WHERE tenant_id = $1 AND application_id = $2 ORDER BY created_at",
      [tenantId, applicationId],
    );
  }

  /* ---------------- recordings ---------------- */

  async createRecording(input: {
    tenantId: string;
    applicationId: string;
    mode: RecordingMode;
    directory: string;
    createdBy: string;
  }): Promise<RecordingRow> {
    const row: RecordingRow = {
      id: randomUUID(),
      tenantId: input.tenantId,
      applicationId: input.applicationId,
      status: "recording",
      mode: input.mode,
      directory: input.directory,
      workflowId: null,
      error: null,
      startedAt: now(),
      finishedAt: null,
    };
    await this.sql.query(
      `INSERT INTO recordings (id, tenant_id, application_id, status, mode, directory, created_by, started_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        row.id,
        row.tenantId,
        row.applicationId,
        row.status,
        row.mode,
        row.directory,
        input.createdBy,
        row.startedAt,
      ],
    );
    this.log({ event: "recording.started", recordingId: row.id, mode: row.mode });
    return row;
  }

  async updateRecording(
    tenantId: string,
    recordingId: string,
    patch: {
      status?: RecordingStatus;
      workflowId?: string | null;
      error?: string | null;
      finishedAt?: string | null;
    },
  ): Promise<void> {
    await this.sql.query(
      `UPDATE recordings SET
         status = COALESCE($3, status),
         workflow_id = COALESCE($4, workflow_id),
         error = COALESCE($5, error),
         finished_at = COALESCE($6, finished_at)
       WHERE tenant_id = $1 AND id = $2`,
      [
        tenantId,
        recordingId,
        patch.status ?? null,
        patch.workflowId ?? null,
        patch.error ?? null,
        patch.finishedAt ?? null,
      ],
    );
  }

  async getRecording(tenantId: string, recordingId: string): Promise<RecordingRow | null> {
    const rows = await this.sql.query<Record<string, unknown>>(
      "SELECT * FROM recordings WHERE tenant_id = $1 AND id = $2",
      [tenantId, recordingId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: String(row["id"]),
      tenantId: String(row["tenant_id"]),
      applicationId: String(row["application_id"]),
      status: String(row["status"]) as RecordingStatus,
      mode: String(row["mode"]) as RecordingMode,
      directory: String(row["directory"]),
      workflowId: (row["workflow_id"] as string | null) ?? null,
      error: (row["error"] as string | null) ?? null,
      startedAt: new Date(String(row["started_at"])).toISOString(),
      finishedAt: row["finished_at"] ? new Date(String(row["finished_at"])).toISOString() : null,
    };
  }

  /* ---------------- workflows ---------------- */

  async createWorkflow(input: {
    tenantId: string;
    applicationId: string;
    name: string;
    description: string | null;
    bundlePath: string | null;
    recordingId: string | null;
    steps: Omit<WorkflowStep, "id">[];
    uncertainty: string[];
  }): Promise<Workflow> {
    const id = randomUUID();
    const createdAt = now();
    await this.sql.query(
      `INSERT INTO workflows (id, tenant_id, application_id, name, description, status, bundle_path, recording_id, uncertainty, created_at)
       VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$8::jsonb,$9)`,
      [
        id,
        input.tenantId,
        input.applicationId,
        input.name,
        input.description,
        input.bundlePath,
        input.recordingId,
        JSON.stringify(input.uncertainty),
        createdAt,
      ],
    );
    const steps: WorkflowStep[] = [];
    for (const step of input.steps) {
      const stepId = randomUUID();
      await this.sql.query(
        `INSERT INTO workflow_steps
           (id, tenant_id, workflow_id, idx, intent, action, risk, anchor_kind, element_role, element_name,
            selector, ocr_text, field_label, param_name, is_secret, postconditions, confidence, uncertainty_note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18)`,
        [
          stepId,
          input.tenantId,
          id,
          step.index,
          step.intent,
          step.action,
          step.risk,
          step.anchorKind,
          step.elementRole,
          step.elementName,
          step.selector,
          step.ocrText,
          step.fieldLabel,
          step.paramName,
          step.isSecret,
          JSON.stringify(step.postconditions),
          step.confidence,
          step.uncertaintyNote,
        ],
      );
      steps.push({ ...step, id: stepId });
    }
    await this.upsertNode(input.tenantId, "workflow", id, input.name);
    await this.addEdge(input.tenantId, "application", input.applicationId, "workflow", id, "contains");
    this.log({ event: "workflow.compiled", workflowId: id, steps: steps.length });
    return {
      id,
      tenantId: input.tenantId,
      applicationId: input.applicationId,
      applicationName: "",
      name: input.name,
      description: input.description,
      status: "draft",
      bundlePath: input.bundlePath,
      recordingId: input.recordingId,
      steps,
      uncertainty: input.uncertainty,
      createdAt,
    };
  }

  async getWorkflow(tenantId: string, workflowId: string): Promise<Workflow | null> {
    const rows = await this.sql.query<Record<string, unknown>>(
      `SELECT w.*, a.name AS application_name FROM workflows w
         JOIN applications a ON a.id = w.application_id
        WHERE w.tenant_id = $1 AND w.id = $2`,
      [tenantId, workflowId],
    );
    const row = rows[0];
    if (!row) return null;
    const stepRows = await this.sql.query<Record<string, unknown>>(
      "SELECT * FROM workflow_steps WHERE tenant_id = $1 AND workflow_id = $2 ORDER BY idx",
      [tenantId, workflowId],
    );
    return {
      id: String(row["id"]),
      tenantId: String(row["tenant_id"]),
      applicationId: String(row["application_id"]),
      applicationName: String(row["application_name"]),
      name: String(row["name"]),
      description: (row["description"] as string | null) ?? null,
      status: String(row["status"]) as WorkflowStatus,
      bundlePath: (row["bundle_path"] as string | null) ?? null,
      recordingId: (row["recording_id"] as string | null) ?? null,
      steps: stepRows.map(mapStep),
      uncertainty: asStringArray(row["uncertainty"]),
      createdAt: new Date(String(row["created_at"])).toISOString(),
    };
  }

  async listWorkflows(tenantId: string): Promise<Workflow[]> {
    const rows = await this.sql.query<{ id: string }>(
      "SELECT id FROM workflows WHERE tenant_id = $1 ORDER BY created_at DESC",
      [tenantId],
    );
    const out: Workflow[] = [];
    for (const row of rows) {
      const workflow = await this.getWorkflow(tenantId, row.id);
      if (workflow) out.push(workflow);
    }
    return out;
  }

  async setWorkflowStatus(
    tenantId: string,
    workflowId: string,
    status: WorkflowStatus,
  ): Promise<void> {
    await this.sql.query(
      "UPDATE workflows SET status = $3 WHERE tenant_id = $1 AND id = $2",
      [tenantId, workflowId, status],
    );
  }

  /* ---------------- skills ---------------- */

  async createSkill(input: {
    tenantId: string;
    workflowId: string;
    name: string;
    description: string;
    requiredInputs: ParamSpec[];
    triggeredBy: string[];
    verification: VerificationContract | null;
    approvedBy: string | null;
    status?: "active" | "disabled" | undefined;
  }): Promise<Skill> {
    const existing = await this.sql.query<{ id: string; version: number }>(
      "SELECT id, version FROM skills WHERE tenant_id = $1 AND workflow_id = $2 AND status = 'active'",
      [input.tenantId, input.workflowId],
    );
    const prior = existing[0];
    const version = prior ? Number(prior.version) + 1 : 1;
    if (prior) {
      await this.sql.query("UPDATE skills SET status = 'disabled' WHERE id = $1", [prior.id]);
    }
    const id = randomUUID();
    const approvedAt = input.approvedBy ? now() : null;
    await this.sql.query(
      `INSERT INTO skills (id, tenant_id, workflow_id, name, description, status, required_inputs, triggered_by, verification, approved_by, approved_at, version)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11,$12)`,
      [
        id,
        input.tenantId,
        input.workflowId,
        input.name,
        input.description,
        input.status ?? "active",
        JSON.stringify(input.requiredInputs),
        JSON.stringify(input.triggeredBy),
        input.verification ? JSON.stringify(input.verification) : null,
        input.approvedBy,
        approvedAt,
        version,
      ],
    );
    await this.upsertNode(input.tenantId, "skill", id, input.name);
    await this.addEdge(input.tenantId, "workflow", input.workflowId, "skill", id, "published_as");
    this.log({
      event: "skill.created",
      skillId: id,
      workflowId: input.workflowId,
      approved: Boolean(input.approvedBy),
    });
    const workflow = await this.getWorkflow(input.tenantId, input.workflowId);
    return {
      id,
      tenantId: input.tenantId,
      workflowId: input.workflowId,
      workflowName: workflow?.name ?? input.name,
      applicationId: workflow?.applicationId ?? "",
      name: input.name,
      description: input.description,
      status: input.status ?? "active",
      requiredInputs: input.requiredInputs,
      triggeredBy: input.triggeredBy,
      verification: input.verification,
      approvedBy: input.approvedBy,
      approvedAt,
      version,
    };
  }

  async listSkills(tenantId: string, status?: "active" | "disabled"): Promise<Skill[]> {
    const rows = await this.sql.query<Record<string, unknown>>(
      status
        ? "SELECT * FROM skills WHERE tenant_id = $1 AND status = $2 ORDER BY approved_at DESC"
        : "SELECT * FROM skills WHERE tenant_id = $1 ORDER BY approved_at DESC",
      status ? [tenantId, status] : [tenantId],
    );
    const out: Skill[] = [];
    for (const row of rows) {
      const workflow = await this.getWorkflow(tenantId, String(row["workflow_id"]));
      out.push({
        id: String(row["id"]),
        tenantId: String(row["tenant_id"]),
        workflowId: String(row["workflow_id"]),
        workflowName: workflow?.name ?? "unknown",
        applicationId: workflow?.applicationId ?? "",
        name: String(row["name"]),
        description: String(row["description"]),
        status: String(row["status"]) as Skill["status"],
        requiredInputs: (row["required_inputs"] as ParamSpec[]) ?? [],
        triggeredBy: asStringArray(row["triggered_by"]),
        verification: (row["verification"] as Skill["verification"]) ?? null,
        approvedBy: (row["approved_by"] as string | null) ?? null,
        approvedAt: row["approved_at"]
          ? new Date(String(row["approved_at"])).toISOString()
          : null,
        version: Number(row["version"]),
      });
    }
    return out;
  }

  async getSkill(tenantId: string, skillId: string): Promise<Skill | null> {
    const all = await this.listSkills(tenantId);
    return all.find((s) => s.id === skillId) ?? null;
  }

  /* ---------------- knowledge documents ---------------- */

  async addDocument(input: {
    tenantId: string;
    applicationId: string | null;
    title: string;
    kind: "sop" | "doc";
    content: string;
    chunkSize?: number | undefined;
  }): Promise<{ documentId: string; chunks: number }> {
    const documentId = randomUUID();
    await this.sql.query(
      `INSERT INTO documents (id, tenant_id, application_id, title, kind, content, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [documentId, input.tenantId, input.applicationId, input.title, input.kind, input.content, now()],
    );
    const size = input.chunkSize ?? 600;
    const text = input.content.trim();
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += size) {
      chunks.push(text.slice(i, i + size));
    }
    for (const [index, chunk] of chunks.entries()) {
      await this.sql.query(
        "INSERT INTO doc_chunks (id, tenant_id, document_id, idx, content) VALUES ($1,$2,$3,$4,$5)",
        [randomUUID(), input.tenantId, documentId, index, chunk],
      );
    }
    await this.upsertNode(input.tenantId, "document", documentId, input.title);
    if (input.applicationId) {
      await this.addEdge(
        input.tenantId,
        "application",
        input.applicationId,
        "document",
        documentId,
        "documented_by",
      );
    }
    return { documentId, chunks: chunks.length };
  }

  /**
   * Keyword retrieval. Always available, no provider required.
   * Scoring is deliberately simple and explainable: term overlap, weighted by
   * title matches, normalized to 0..1.
   */
  async searchChunksKeyword(
    tenantId: string,
    query: string,
    limit = 5,
  ): Promise<DocumentChunkHit[]> {
    const terms = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2);
    if (terms.length === 0) return [];
    const rows = await this.sql.query<Record<string, unknown>>(
      `SELECT c.id AS chunk_id, c.document_id, c.content, d.title
         FROM doc_chunks c
         JOIN documents d ON d.id = c.document_id
        WHERE c.tenant_id = $1
          AND (${terms.map((_, i) => `lower(c.content) LIKE $${i + 2}`).join(" OR ")}
               OR ${terms.map((_, i) => `lower(d.title) LIKE $${i + 2}`).join(" OR ")})
        LIMIT 200`,
      [tenantId, ...terms.map((t) => `%${t}%`)],
    );
    return rows
      .map((row) => {
        const content = String(row["content"]).toLowerCase();
        const title = String(row["title"]).toLowerCase();
        const hits = terms.filter((t) => content.includes(t)).length;
        const titleHits = terms.filter((t) => title.includes(t)).length;
        const score = Math.min(1, (hits + titleHits * 1.5) / (terms.length * 2));
        return {
          chunkId: String(row["chunk_id"]),
          documentId: String(row["document_id"]),
          title: String(row["title"]),
          content: String(row["content"]),
          score: Number(score.toFixed(4)),
          method: "keyword" as const,
        };
      })
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async storeEmbedding(
    tenantId: string,
    chunkId: string,
    embedding: number[],
  ): Promise<boolean> {
    if (!this.sql.vectorAvailable()) return false;
    const literal = `[${embedding.join(",")}]`;
    await this.sql.query(
      "UPDATE doc_chunks SET embedding = $3::vector WHERE tenant_id = $1 AND id = $2",
      [tenantId, chunkId, literal],
    );
    return true;
  }

  async searchChunksVector(
    tenantId: string,
    embedding: number[],
    limit = 5,
  ): Promise<DocumentChunkHit[]> {
    if (!this.sql.vectorAvailable()) return [];
    const literal = `[${embedding.join(",")}]`;
    const rows = await this.sql.query<Record<string, unknown>>(
      `SELECT c.id AS chunk_id, c.document_id, c.content, d.title,
              1 - (c.embedding <=> $2::vector) AS score
         FROM doc_chunks c
         JOIN documents d ON d.id = c.document_id
        WHERE c.tenant_id = $1 AND c.embedding IS NOT NULL
        ORDER BY c.embedding <=> $2::vector
        LIMIT $3`,
      [tenantId, literal, limit],
    );
    return rows.map((row) => ({
      chunkId: String(row["chunk_id"]),
      documentId: String(row["document_id"]),
      title: String(row["title"]),
      content: String(row["content"]),
      score: Number(Number(row["score"]).toFixed(4)),
      method: "vector" as const,
    }));
  }

  /* ---------------- plans ---------------- */

  /**
   * Plans are reviewable artifacts, so they survive an API restart and are
   * scoped to the tenant that produced them. Expired plans are pruned on read.
   */
  async savePlan(plan: Plan, ttlMs = 30 * 60_000): Promise<void> {
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    await this.sql.query(
      `INSERT INTO plans (id, tenant_id, intent, skill_id, workflow_id, payload, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
       ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, expires_at = EXCLUDED.expires_at`,
      [
        plan.id,
        plan.tenantId,
        plan.intent,
        plan.skillId,
        plan.workflowId,
        JSON.stringify(plan),
        plan.createdAt,
        expiresAt,
      ],
    );
    await this.sql.query(
      "DELETE FROM plans WHERE tenant_id = $1 AND expires_at <= NOW()",
      [plan.tenantId],
    );
  }

  async getPlan(tenantId: string, planId: string): Promise<Plan | null> {
    const rows = await this.sql.query<{ payload: Plan }>(
      "SELECT payload FROM plans WHERE tenant_id = $1 AND id = $2 AND expires_at > NOW()",
      [tenantId, planId],
    );
    const row = rows[0];
    return row ? row.payload : null;
  }

  /* ---------------- graph ---------------- */

  async upsertNode(tenantId: string, kind: string, refId: string, label: string): Promise<string> {
    const id = randomUUID();
    await this.sql.query(
      `INSERT INTO graph_nodes (id, tenant_id, kind, ref_id, label, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id, kind, ref_id) DO UPDATE SET label = EXCLUDED.label`,
      [id, tenantId, kind, refId, label, now()],
    );
    const rows = await this.sql.query<{ id: string }>(
      "SELECT id FROM graph_nodes WHERE tenant_id = $1 AND kind = $2 AND ref_id = $3",
      [tenantId, kind, refId],
    );
    return rows[0]?.id ?? id;
  }

  async addEdge(
    tenantId: string,
    fromKind: string,
    fromRef: string,
    toKind: string,
    toRef: string,
    relation: string,
  ): Promise<void> {
    const fromId = await this.upsertNode(tenantId, fromKind, fromRef, fromRef);
    const toId = await this.upsertNode(tenantId, toKind, toRef, toRef);
    await this.sql.query(
      `INSERT INTO graph_edges (id, tenant_id, from_node_id, to_node_id, relation, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id, from_node_id, to_node_id, relation) DO NOTHING`,
      [randomUUID(), tenantId, fromId, toId, relation, now()],
    );
  }

  async listEdges(tenantId: string, relation?: string) {
    return this.sql.query<Record<string, unknown>>(
      relation
        ? "SELECT * FROM graph_edges WHERE tenant_id = $1 AND relation = $2"
        : "SELECT * FROM graph_edges WHERE tenant_id = $1",
      relation ? [tenantId, relation] : [tenantId],
    );
  }

  /* ---------------- executions ---------------- */

  async createExecution(input: {
    tenantId: string;
    skillId: string;
    workflowId: string;
    intent: string;
    inputs: Record<string, string>;
    requestedBy: string;
  }): Promise<ExecutionRow> {
    const row: ExecutionRow = {
      id: randomUUID(),
      tenantId: input.tenantId,
      skillId: input.skillId,
      workflowId: input.workflowId,
      intent: input.intent,
      inputs: input.inputs,
      status: "queued",
      outcome: null,
      engineOutcome: null,
      engineReportPath: null,
      steps: [],
      verification: null,
      message: null,
      modelCalls: 0,
      requestedBy: input.requestedBy,
      failure: null,
      timings: null,
      recovery: null,
      memory: null,
      startedAt: now(),
      finishedAt: null,
    };
    await this.sql.query(
      `INSERT INTO executions (id, tenant_id, skill_id, workflow_id, intent, inputs, status, requested_by, started_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)`,
      [
        row.id,
        row.tenantId,
        row.skillId,
        row.workflowId,
        row.intent,
        JSON.stringify(row.inputs),
        row.status,
        row.requestedBy,
        row.startedAt,
      ],
    );
    this.log({ event: "execution.created", executionId: row.id, skillId: row.skillId });
    return row;
  }

  async updateExecution(
    tenantId: string,
    executionId: string,
    patch: Partial<
      Pick<
        ExecutionRow,
        | "status"
        | "outcome"
        | "engineOutcome"
        | "engineReportPath"
        | "message"
        | "modelCalls"
        | "finishedAt"
        | "failure"
        | "timings"
        | "recovery"
        | "memory"
      >
    >,
  ): Promise<void> {
    await this.sql.query(
      `UPDATE executions SET
         status = COALESCE($3, status),
         outcome = COALESCE($4, outcome),
         engine_outcome = COALESCE($5, engine_outcome),
         engine_report_path = COALESCE($6, engine_report_path),
         message = COALESCE($7, message),
         model_calls = COALESCE($8, model_calls),
         finished_at = COALESCE($9, finished_at),
         failure = COALESCE($10::jsonb, failure),
         timings = COALESCE($11::jsonb, timings),
         recovery = COALESCE($12::jsonb, recovery),
         memory = COALESCE($13::jsonb, memory)
       WHERE tenant_id = $1 AND id = $2`,
      [
        tenantId,
        executionId,
        patch.status ?? null,
        patch.outcome ?? null,
        patch.engineOutcome ?? null,
        patch.engineReportPath ?? null,
        patch.message ?? null,
        patch.modelCalls ?? null,
        patch.finishedAt ?? null,
        patch.failure ? JSON.stringify(patch.failure) : null,
        patch.timings ? JSON.stringify(patch.timings) : null,
        patch.recovery ? JSON.stringify(patch.recovery) : null,
        patch.memory ? JSON.stringify(patch.memory) : null,
      ],
    );
  }

  async replaceExecutionSteps(
    tenantId: string,
    executionId: string,
    steps: ExecutionStepResult[],
  ): Promise<void> {
    await this.sql.query(
      "DELETE FROM execution_steps WHERE tenant_id = $1 AND execution_id = $2",
      [tenantId, executionId],
    );
    for (const step of steps) {
      await this.sql.query(
        `INSERT INTO execution_steps
           (id, tenant_id, execution_id, idx, step_id, intent, status, rung, detail, duration_ms,
            input_verified, resolved_selector, resolution_source, repair_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          randomUUID(),
          tenantId,
          executionId,
          step.index,
          step.stepId,
          step.intent,
          step.status,
          step.rung,
          step.detail,
          step.durationMs,
          step.inputVerified,
          step.resolvedSelector,
          step.resolutionSource,
          step.repairId ?? null,
        ],
      );
    }
  }

  async addVerification(
    tenantId: string,
    executionId: string,
    result: VerificationResult,
  ): Promise<void> {
    await this.sql.query(
      `INSERT INTO verification_results (id, tenant_id, execution_id, tier, passed, source, expected, observed, detail, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10)`,
      [
        randomUUID(),
        tenantId,
        executionId,
        result.tier,
        result.passed,
        result.source,
        JSON.stringify(result.expected),
        result.observed ? JSON.stringify(result.observed) : null,
        result.detail,
        result.createdAt,
      ],
    );
  }

  async getExecution(tenantId: string, executionId: string): Promise<ExecutionRow | null> {
    const rows = await this.sql.query<Record<string, unknown>>(
      "SELECT * FROM executions WHERE tenant_id = $1 AND id = $2",
      [tenantId, executionId],
    );
    const row = rows[0];
    if (!row) return null;
    const stepRows = await this.sql.query<Record<string, unknown>>(
      "SELECT * FROM execution_steps WHERE tenant_id = $1 AND execution_id = $2 ORDER BY idx",
      [tenantId, executionId],
    );
    const verifyRows = await this.sql.query<Record<string, unknown>>(
      `SELECT * FROM verification_results WHERE tenant_id = $1 AND execution_id = $2
        ORDER BY created_at DESC LIMIT 1`,
      [tenantId, executionId],
    );
    const verify = verifyRows[0];
    return {
      id: String(row["id"]),
      tenantId: String(row["tenant_id"]),
      skillId: String(row["skill_id"]),
      workflowId: String(row["workflow_id"]),
      intent: String(row["intent"]),
      inputs: (row["inputs"] as Record<string, string>) ?? {},
      status: String(row["status"]) as ExecutionRow["status"],
      outcome: (row["outcome"] as ExecutionOutcome | null) ?? null,
      engineOutcome: (row["engine_outcome"] as string | null) ?? null,
      engineReportPath: (row["engine_report_path"] as string | null) ?? null,
      steps: stepRows.map((s) => ({
        index: Number(s["idx"]),
        stepId: (s["step_id"] as string | null) ?? null,
        intent: String(s["intent"]),
        status: String(s["status"]) as ExecutionStepResult["status"],
        rung: (s["rung"] as string | null) ?? null,
        detail: (s["detail"] as string | null) ?? null,
        durationMs:
          s["duration_ms"] === null || s["duration_ms"] === undefined
            ? null
            : Number(s["duration_ms"]),
        inputVerified:
          s["input_verified"] === null || s["input_verified"] === undefined
            ? null
            : Boolean(s["input_verified"]),
        resolvedSelector: (s["resolved_selector"] as string | null) ?? null,
        resolutionSource: (String(
          s["resolution_source"] ?? "none",
        ) as ExecutionStepResult["resolutionSource"]),
        repairId: (s["repair_id"] as string | null) ?? null,
      })),
      verification: verify
        ? {
            tier: String(verify["tier"]) as VerificationResult["tier"],
            passed: Boolean(verify["passed"]),
            source: String(verify["source"]),
            expected: (verify["expected"] as Record<string, unknown>) ?? {},
            observed: (verify["observed"] as Record<string, unknown> | null) ?? null,
            detail: String(verify["detail"]),
            createdAt: new Date(String(verify["created_at"])).toISOString(),
          }
        : null,
      message: (row["message"] as string | null) ?? null,
      modelCalls: Number(row["model_calls"]),
      requestedBy: (row["requested_by"] as string | null) ?? null,
      failure: asJson<FailureResult>(row["failure"]),
      timings: asJson<ExecutionTimings>(row["timings"]),
      recovery: asJson<RecoverySummary>(row["recovery"]),
      memory: asJson<MemoryAudit>(row["memory"]),
      startedAt: new Date(String(row["started_at"])).toISOString(),
      finishedAt: row["finished_at"]
        ? new Date(String(row["finished_at"])).toISOString()
        : null,
    };
  }

  async listExecutions(tenantId: string, limit = 20): Promise<ExecutionRow[]> {
    const rows = await this.sql.query<{ id: string }>(
      "SELECT id FROM executions WHERE tenant_id = $1 ORDER BY started_at DESC LIMIT $2",
      [tenantId, limit],
    );
    const out: ExecutionRow[] = [];
    for (const row of rows) {
      const execution = await this.getExecution(tenantId, row.id);
      if (execution) out.push(execution);
    }
    return out;
  }

  /** Every execution for a workflow, used by the approval-risk heuristic. */
  async countExecutionsForSkill(tenantId: string, skillId: string): Promise<number> {
    const rows = await this.sql.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM executions WHERE tenant_id = $1 AND skill_id = $2",
      [tenantId, skillId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  /* ---------------- episodic memory ---------------- */

  /** One row per execution: outcome, failure, recovery attempt and trace ref. */
  async addEpisode(
    tenantId: string,
    input: {
      executionId: string;
      skillId: string;
      workflowId: string;
      applicationId: string;
      intent: string;
      outcome: ExecutionOutcome | null;
      failure: FailureResult | null;
      recovery: RecoverySummary | null;
      traceRef: string | null;
      context: Record<string, unknown>;
    },
  ): Promise<string> {
    const id = randomUUID();
    await this.sql.query(
      `INSERT INTO execution_memory
         (id, tenant_id, execution_id, skill_id, workflow_id, application_id, intent, outcome,
          failure, recovery, trace_ref, context, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12::jsonb,$13)`,
      [
        id,
        tenantId,
        input.executionId,
        input.skillId,
        input.workflowId,
        input.applicationId,
        input.intent,
        input.outcome,
        input.failure ? JSON.stringify(input.failure) : null,
        input.recovery ? JSON.stringify(input.recovery) : null,
        input.traceRef,
        JSON.stringify(input.context),
        now(),
      ],
    );
    return id;
  }

  async listEpisodes(
    tenantId: string,
    options: { skillId?: string; executionId?: string; limit?: number } = {},
  ): Promise<Episode[]> {
    const params: unknown[] = [tenantId];
    let where = "tenant_id = $1";
    if (options.skillId) {
      params.push(options.skillId);
      where += ` AND skill_id = $${params.length}`;
    }
    if (options.executionId) {
      params.push(options.executionId);
      where += ` AND execution_id = $${params.length}`;
    }
    params.push(options.limit ?? 50);
    const rows = await this.sql.query<Record<string, unknown>>(
      `SELECT * FROM execution_memory WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map(mapEpisode);
  }

  /* ---------------- procedural memory (repairs) ---------------- */

  /**
   * Store a verified repair. Idempotent for the same workflow, step, selector
   * and failure code: a repeated recovery must not accumulate duplicate rows.
   */
  async createRepair(
    tenantId: string,
    input: {
      applicationId: string;
      workflowId: string;
      skillId: string;
      workflowVersion: number;
      failureOrigin: FailureOrigin;
      failureCode: string;
      action: RepairAction;
      conditions?: Record<string, unknown>;
      createdBy?: string | null;
    },
  ): Promise<Repair> {
    const existing = await this.findRepairs(tenantId, {
      workflowId: input.workflowId,
      failureCode: input.failureCode,
    });
    const same = existing.find(
      (repair) =>
        repair.action.stepIndex === input.action.stepIndex &&
        repair.action.toSelector === input.action.toSelector &&
        repair.action.fromSelector === input.action.fromSelector,
    );
    if (same) return same;

    const id = randomUUID();
    const createdAt = now();
    const conditions = input.conditions ?? {};
    await this.sql.query(
      `INSERT INTO repairs
         (id, tenant_id, application_id, workflow_id, skill_id, workflow_version,
          failure_origin, failure_code, action, conditions, status,
          success_count, failure_count, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,'candidate',0,0,$11,$12)`,
      [
        id,
        tenantId,
        input.applicationId,
        input.workflowId,
        input.skillId,
        input.workflowVersion,
        input.failureOrigin,
        input.failureCode,
        JSON.stringify(input.action),
        JSON.stringify(conditions),
        input.createdBy ?? null,
        createdAt,
      ],
    );
    return {
      id,
      tenantId,
      applicationId: input.applicationId,
      workflowId: input.workflowId,
      skillId: input.skillId,
      workflowVersion: input.workflowVersion,
      failureOrigin: input.failureOrigin,
      failureCode: input.failureCode,
      action: input.action,
      conditions,
      status: "candidate",
      successCount: 0,
      failureCount: 0,
      createdBy: input.createdBy ?? null,
      reviewedBy: null,
      createdAt,
      reviewedAt: null,
      lastUsedAt: null,
    };
  }

  async findRepairs(
    tenantId: string,
    filter: {
      applicationId?: string;
      workflowId?: string;
      failureOrigin?: FailureOrigin;
      failureCode?: string;
      stepIndex?: number;
      status?: RepairStatus;
    } = {},
  ): Promise<Repair[]> {
    const params: unknown[] = [tenantId];
    const clauses = ["tenant_id = $1"];
    const add = (sql: string, value: unknown): void => {
      params.push(value);
      clauses.push(sql.replace("?", `$${params.length}`));
    };
    if (filter.applicationId) add("application_id = ?", filter.applicationId);
    if (filter.workflowId) add("workflow_id = ?", filter.workflowId);
    if (filter.failureOrigin) add("failure_origin = ?", filter.failureOrigin);
    if (filter.failureCode) add("failure_code = ?", filter.failureCode);
    if (filter.status) add("status = ?", filter.status);
    if (filter.stepIndex !== undefined) {
      add("(action->>'stepIndex')::int = ?", filter.stepIndex);
    }
    const rows = await this.sql.query<Record<string, unknown>>(
      `SELECT * FROM repairs WHERE ${clauses.join(" AND ")}
        ORDER BY success_count DESC, created_at ASC`,
      params,
    );
    return rows.map(mapRepair);
  }

  async getRepair(tenantId: string, repairId: string): Promise<Repair | null> {
    const rows = await this.sql.query<Record<string, unknown>>(
      "SELECT * FROM repairs WHERE tenant_id = $1 AND id = $2",
      [tenantId, repairId],
    );
    const row = rows[0];
    return row ? mapRepair(row) : null;
  }

  /** Count a reuse attempt. A failure here is evidence against the repair. */
  async recordRepairUse(
    tenantId: string,
    repairId: string,
    ok: boolean,
  ): Promise<Repair | null> {
    await this.sql.query(
      `UPDATE repairs SET
         success_count = success_count + CASE WHEN $3 THEN 1 ELSE 0 END,
         failure_count = failure_count + CASE WHEN $3 THEN 0 ELSE 1 END,
         last_used_at = NOW()
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, repairId, ok],
    );
    return this.getRepair(tenantId, repairId);
  }

  /** Promotion happens here and only here: review is an explicit act. */
  async reviewRepair(
    tenantId: string,
    repairId: string,
    status: "approved" | "rejected" | "retired",
    reviewedBy: string,
  ): Promise<Repair | null> {
    await this.sql.query(
      `UPDATE repairs SET status = $3, reviewed_by = $4, reviewed_at = NOW()
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, repairId, status, reviewedBy],
    );
    return this.getRepair(tenantId, repairId);
  }
}
