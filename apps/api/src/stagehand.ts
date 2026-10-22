/**
 * Stagehand: AI-assisted browser interaction for the cases deterministic replay
 * cannot encode (a one-off read, an application we have not demonstrated yet).
 *
 * The split is deliberate and stated everywhere it matters:
 *   - an approved, compiled workflow is executed by the deterministic engine;
 *   - Stagehand is used when no approved skill applies, it drives its OWN local
 *     browser session (it cannot attach to the extension's tab), and its writes
 *     still obey the approval policy.
 *
 * Session boundary (Phase 6): every AI browser operation is a first-class
 * `BrowserSession` record with an id, the tenant and user that started it, the
 * registered application it targets, and its progress. Sessions are readable
 * only by their tenant, expire after a short TTL, are never reused across
 * tenants, and always close the browser they opened.
 *
 * Stagehand v4 (verified against 4.3.0) is used through `Stagehand.create` and
 * `localBrowser.launch`. The package is an optional dependency, so a missing
 * install is a reported capability gap instead of a build failure.
 */
import { randomUUID } from "node:crypto";
import {
  CopilotError,
  envValue,
  type BrowserSession,
  type CapabilityStatus,
} from "@copilot/shared";
import { isRiskyIntent } from "@copilot/agent";

export interface StagehandStatus {
  status: CapabilityStatus;
  detail: string;
}

export interface StagehandPage {
  goto(url: string): Promise<unknown>;
  /** Present on the Playwright page Stagehand hands back; used for evidence. */
  evaluate?<T>(fn: () => T): Promise<T>;
  url?(): string;
}

export interface StagehandBrowserHandle {
  context: {
    pages(): Promise<StagehandPage[]>;
    newPage(url?: string): Promise<StagehandPage>;
  };
  close(): Promise<void>;
}

export interface StagehandInstance {
  observe?(instruction: string): Promise<unknown>;
  act(instruction: string): Promise<unknown>;
  close(): Promise<void>;
}

export interface StagehandModule {
  Stagehand: {
    create(options: Record<string, unknown>): Promise<StagehandInstance>;
  };
  localBrowser: {
    launch(options?: Record<string, unknown>): Promise<StagehandBrowserHandle>;
  };
}

/**
 * The specifier is a runtime value on purpose: the package is optional, so it
 * must not become a compile-time dependency of the API bundle.
 */
const STAGEHAND_PACKAGE = "@browserbasehq/stagehand";

export async function loadStagehandModule(): Promise<StagehandModule | null> {
  try {
    const specifier: string = STAGEHAND_PACKAGE;
    const mod = (await import(specifier)) as unknown as StagehandModule;
    // A different major version has a different entry surface; report that
    // instead of failing at the first call.
    if (typeof mod.Stagehand?.create !== "function" || !mod.localBrowser?.launch) {
      return null;
    }
    return mod;
  } catch {
    return null;
  }
}

interface LlmCredentials {
  provider: "groq" | "openai" | "anthropic";
  apiKey: string;
  modelName: string;
}

/**
 * Stagehand v4 accepts `groq/<model>` as a first-class provider (its wire
 * schema lists openai, anthropic, google, groq and cerebras). That matters
 * here: the project already ships Groq, so live AI browsing needs no second
 * paid provider.
 */
const DEFAULT_STAGEHAND_MODEL = "groq/openai/gpt-oss-120b";

/** `groq/llama-x` is used as given; a bare model id gets its provider prefix. */
function stagehandModel(provider: string): string {
  const configured = envValue("STAGEHAND_MODEL");
  if (!configured) return provider === "groq" ? DEFAULT_STAGEHAND_MODEL : `${provider}/gpt-4o-mini`;
  if (configured.includes("/")) return configured;
  return `${provider}/${configured}`;
}

function llmCredentials(): LlmCredentials | null {
  if (envValue("GROQ_API_KEY")) {
    return {
      provider: "groq",
      apiKey: envValue("GROQ_API_KEY")!,
      modelName: stagehandModel("groq"),
    };
  }
  if (envValue("OPENAI_API_KEY")) {
    return {
      provider: "openai",
      apiKey: envValue("OPENAI_API_KEY")!,
      modelName: stagehandModel("openai"),
    };
  }
  if (envValue("ANTHROPIC_API_KEY")) {
    return {
      provider: "anthropic",
      apiKey: envValue("ANTHROPIC_API_KEY")!,
      modelName: stagehandModel("anthropic"),
    };
  }
  return null;
}

export async function stagehandStatus(): Promise<StagehandStatus> {
  const mod = await loadStagehandModule();
  if (!mod) {
    return {
      status: "blocked",
      detail:
        "The @browserbasehq/stagehand package is not installed (or is not v4). Install it with: pnpm add @browserbasehq/stagehand@^4. Deterministic replay is unaffected.",
    };
  }
  const credentials = llmCredentials();
  if (!credentials) {
    return {
      status: "unconfigured",
      detail:
        "Stagehand v4 is installed but no model credentials are configured. Set GROQ_API_KEY (preferred) or OPENAI_API_KEY / ANTHROPIC_API_KEY, and optionally STAGEHAND_MODEL as provider/model. Stagehand drives its own controlled browser, not the extension's tab.",
    };
  }
  return {
    status: "configured",
    detail: `Stagehand ready via ${credentials.provider} (${credentials.modelName}). It drives a separate local browser session; it cannot attach to the extension's tab.`,
  };
}

export interface StagehandTaskResult {
  ok: boolean;
  summary: string;
  actions: string[];
  observed: unknown;
}

export interface StagehandProgress {
  step: number;
  action: string;
  ok: boolean;
  detail: string;
}

/**
 * Prerequisites and the policy gate, checked *before* a browser is opened.
 *
 * The approval check runs first on purpose: an unapproved consequential
 * instruction is refused even when the provider could not run, so the answer is
 * always "needs a human", never "provider missing".
 */
async function assertStagehandReady(input: {
  instruction: string;
  approved?: boolean;
}): Promise<StagehandModule> {
  const mod = await loadStagehandModule();
  if (!mod) {
    throw new CopilotError(
      "capability_unavailable",
      "Stagehand is not installed (or is not v4). Exact prerequisite: pnpm add @browserbasehq/stagehand@^4.",
      503,
    );
  }
  if (isRiskyIntent(input.instruction) && !input.approved) {
    throw new CopilotError(
      "conflict",
      "This instruction is consequential. Re-send with approved: true after a human has approved it; the AI path does not self-approve.",
      409,
    );
  }
  if (!llmCredentials()) {
    throw new CopilotError(
      "capability_unavailable",
      "Stagehand needs model credentials. Exact prerequisite: set GROQ_API_KEY, OPENAI_API_KEY or ANTHROPIC_API_KEY (and optionally STAGEHAND_MODEL as provider/model).",
      503,
    );
  }
  return mod;
}

/**
 * Run one natural-language browser task in a controlled local session.
 *
 * Throws `capability_unavailable` (503) when prerequisites are missing and
 * `conflict` (409) when a consequential instruction was not approved, so
 * callers can report BLOCKED/REJECTED instead of inventing a result. The
 * browser is always closed, whatever happens inside it.
 */
export async function runStagehandTask(input: {
  url: string;
  instruction: string;
  approved?: boolean;
  maxSteps?: number;
  onProgress?: (event: StagehandProgress) => void;
}): Promise<StagehandTaskResult> {
  const mod = await assertStagehandReady(input);
  const credentials = llmCredentials()!;

  const browser = await mod.localBrowser.launch({
    headless: process.env.STAGEHAND_HEADLESS !== "false",
  });
  try {
    const stagehand = await mod.Stagehand.create({
      browser,
      model: { modelName: credentials.modelName, apiKey: credentials.apiKey },
    });
    try {
      const pages = await browser.context.pages();
      const page = pages[0] ?? (await browser.context.newPage());
      await page.goto(input.url);

      // Observe first: the selectors Stagehand proposes are returned as
      // evidence, and the action loop is bounded so a wrong plan cannot wander.
      let observed: unknown = null;
      if (stagehand.observe) {
        try {
          observed = await stagehand.observe(input.instruction);
        } catch {
          observed = null; // observation is evidence, not a prerequisite
        }
      }
      const actions: string[] = [];
      let summary = "";
      const maxSteps = input.maxSteps ?? 4;
      for (let i = 0; i < maxSteps; i += 1) {
        const raw = (await stagehand.act(input.instruction)) as {
          message?: string;
          success?: boolean;
          data?: { message?: string; success?: boolean };
        };
        // v4 wraps the result as `{ data: { success, message } }`; older shapes
        // put the fields at the top level. Read both rather than guessing.
        const result = raw?.data ?? raw;
        const ok = result?.success !== false;
        actions.push(input.instruction);
        summary = result?.message ?? summary;
        input.onProgress?.({
          step: i + 1,
          action: input.instruction,
          ok,
          detail: result?.message ?? (ok ? "Action reported success." : "No action found."),
        });
        if (ok) break;
      }
      return { ok: true, summary, actions, observed };
    } finally {
      await stagehand.close();
    }
  } finally {
    await browser.close();
  }
}

/* ------------------------------------------------------------------ */
/* Controlled browser sessions (autonomous mode)                       */
/* ------------------------------------------------------------------ */

const SESSION_TTL_MS = 15 * 60_000;
const RUNNING_LIMIT_MS = 10 * 60_000;
const MAX_SESSIONS = 50;

interface StoredSession {
  session: BrowserSession;
  expiresAt: number;
}

const sessions = new Map<string, StoredSession>();

function copy(session: BrowserSession): BrowserSession {
  return { ...session, actions: [...session.actions] };
}

/**
 * Drop finished sessions after their TTL and bound memory. A session still
 * marked running past its limit is reported as failed rather than silently
 * hanging: the API cannot keep a browser open forever and should not pretend
 * otherwise.
 */
function prune(now = Date.now()): void {
  for (const [id, entry] of sessions) {
    const { session } = entry;
    if (session.status === "running") {
      const started = Date.parse(session.startedAt);
      if (Number.isFinite(started) && now - started > RUNNING_LIMIT_MS) {
        session.status = "failed";
        session.error =
          "The controlled browser session did not report a result in time. Start a new session.";
        session.finishedAt = new Date().toISOString();
        entry.expiresAt = now + SESSION_TTL_MS;
      }
      continue;
    }
    if (entry.expiresAt <= now) sessions.delete(id);
  }
  if (sessions.size <= MAX_SESSIONS) return;
  const finished = [...sessions.entries()]
    .filter(([, entry]) => entry.session.status !== "running")
    .sort((a, b) => a[1].session.startedAt.localeCompare(b[1].session.startedAt));
  for (const [id] of finished) {
    if (sessions.size <= MAX_SESSIONS) break;
    sessions.delete(id);
  }
}

export interface StartAutonomousInput {
  tenantId: string;
  userId: string;
  applicationId: string;
  applicationName: string;
  targetUrl: string;
  instruction: string;
  approved: boolean;
  planId?: string | null;
  skillId?: string | null;
  log?: (event: Record<string, unknown>) => void;
}

/**
 * Start an AI browser operation and return its session record immediately.
 *
 * The caller gets an operation id to poll; the work continues in this process
 * and the record is updated as it runs. The session is scoped to the tenant
 * that started it and the target application that tenant registered.
 */
export async function startAutonomousSession(
  input: StartAutonomousInput,
): Promise<BrowserSession> {
  // Refuse before allocating anything: missing package, missing credentials, or
  // an unapproved consequential instruction.
  await assertStagehandReady({ instruction: input.instruction, approved: input.approved });
  prune();

  const session: BrowserSession = {
    id: randomUUID(),
    tenantId: input.tenantId,
    userId: input.userId,
    mode: "autonomous",
    sessionType: "controlled_browser_session",
    applicationId: input.applicationId,
    applicationName: input.applicationName,
    targetUrl: input.targetUrl,
    instruction: input.instruction,
    approved: input.approved,
    planId: input.planId ?? null,
    skillId: input.skillId ?? null,
    status: "running",
    summary: null,
    actions: [],
    observed: null,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  const entry: StoredSession = { session, expiresAt: Number.POSITIVE_INFINITY };
  sessions.set(session.id, entry);
  input.log?.({
    event: "stagehand.session.started",
    sessionId: session.id,
    tenantId: session.tenantId,
    applicationId: session.applicationId,
    targetUrl: session.targetUrl,
    approved: session.approved,
  });

  void runStagehandTask({
    url: session.targetUrl,
    instruction: session.instruction,
    approved: session.approved,
    onProgress: (event) => {
      if (session.status !== "running") return;
      session.actions = [...session.actions, `${event.action}${event.ok ? "" : " (not performed)"}`];
      session.summary = event.detail;
    },
  })
    .then((result) => {
      session.status = "completed";
      session.summary = result.summary || "The controlled browser session finished.";
      session.actions = result.actions;
      session.observed = result.observed;
    })
    .catch((error: unknown) => {
      session.status = "failed";
      session.error = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
      session.summary = null;
    })
    .finally(() => {
      session.finishedAt = new Date().toISOString();
      entry.expiresAt = Date.now() + SESSION_TTL_MS;
      input.log?.({
        event: "stagehand.session.finished",
        sessionId: session.id,
        tenantId: session.tenantId,
        status: session.status,
        actions: session.actions.length,
      });
    });

  return copy(session);
}

/** Tenant-scoped read. A foreign id is `null` (and maps to 404, not 403). */
export function getBrowserSession(tenantId: string, sessionId: string): BrowserSession | null {
  prune();
  const entry = sessions.get(sessionId);
  if (!entry || entry.session.tenantId !== tenantId) return null;
  return copy(entry.session);
}

/** Recent sessions for this tenant, newest first, for reopening the panel. */
export function listBrowserSessions(tenantId: string, limit = 10): BrowserSession[] {
  prune();
  return [...sessions.values()]
    .filter((entry) => entry.session.tenantId === tenantId)
    .sort((a, b) => b.session.startedAt.localeCompare(a.session.startedAt))
    .slice(0, limit)
    .map((entry) => copy(entry.session));
}

/** Test/reset helper: forget every in-memory session. */
export function resetBrowserSessions(): void {
  sessions.clear();
}
