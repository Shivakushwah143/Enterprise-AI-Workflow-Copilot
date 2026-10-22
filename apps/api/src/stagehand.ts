/**
 * Stagehand: AI-assisted browser interaction for the cases deterministic replay
 * cannot encode (a one-off read, an application we have not demonstrated yet).
 *
 * The split is deliberate and stated everywhere it matters:
 *   - an approved, compiled workflow is executed by the deterministic engine;
 *   - Stagehand is used only when no approved skill applies, it drives its OWN
 *     local browser session (it cannot attach to the extension's tab), and its
 *     writes still obey the approval policy.
 *
 * Stagehand v4 (verified against 4.3.0) is used through `Stagehand.create` and
 * `localBrowser.launch`. The package is an optional dependency, so a missing
 * install is a reported capability gap instead of a build failure.
 */
import { CopilotError, type CapabilityStatus } from "@copilot/shared";
import { isRiskyIntent } from "@copilot/agent";

export interface StagehandStatus {
  status: CapabilityStatus;
  detail: string;
}

interface StagehandPage {
  goto(url: string): Promise<unknown>;
}

interface StagehandBrowserHandle {
  context: {
    pages(): Promise<StagehandPage[]>;
    newPage(url?: string): Promise<StagehandPage>;
  };
  close(): Promise<void>;
}

interface StagehandInstance {
  observe?(instruction: string): Promise<unknown>;
  act(instruction: string): Promise<unknown>;
  close(): Promise<void>;
}

interface StagehandModule {
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

async function loadStagehand(): Promise<StagehandModule | null> {
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
  provider: "openai" | "anthropic";
  apiKey: string;
  modelName: string;
}

function llmCredentials(): LlmCredentials | null {
  const configured = (process.env.STAGEHAND_MODEL ?? "").trim();
  if (process.env.OPENAI_API_KEY) {
    return {
      provider: "openai",
      apiKey: process.env.OPENAI_API_KEY,
      modelName: configured || "openai/gpt-4o-mini",
    };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      provider: "anthropic",
      apiKey: process.env.ANTHROPIC_API_KEY,
      modelName: configured || "anthropic/claude-3-5-sonnet-latest",
    };
  }
  return null;
}

export async function stagehandStatus(): Promise<StagehandStatus> {
  const mod = await loadStagehand();
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
        "Stagehand v4 is installed but no model credentials are configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY (and optionally STAGEHAND_MODEL as provider/model). Stagehand drives its own controlled browser, not the extension's tab.",
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

/**
 * Run one natural-language browser task in a controlled local session.
 *
 * Throws `capability_unavailable` (503) when prerequisites are missing and
 * `conflict` (409) when a consequential instruction was not approved, so
 * callers can report BLOCKED/REJECTED instead of inventing a result.
 */
export async function runStagehandTask(input: {
  url: string;
  instruction: string;
  approved?: boolean;
  maxSteps?: number;
}): Promise<StagehandTaskResult> {
  const mod = await loadStagehand();
  if (!mod) {
    throw new CopilotError(
      "capability_unavailable",
      "Stagehand is not installed (or is not v4). Exact prerequisite: pnpm add @browserbasehq/stagehand@^4.",
      503,
    );
  }
  // The policy gate runs before any provider check: an unapproved
  // consequential action is refused even when the AI path could not run.
  if (isRiskyIntent(input.instruction) && !input.approved) {
    throw new CopilotError(
      "conflict",
      "This instruction is consequential. Re-send with approved: true after a human has approved it; the AI path does not self-approve.",
      409,
    );
  }
  const credentials = llmCredentials();
  if (!credentials) {
    throw new CopilotError(
      "capability_unavailable",
      "Stagehand needs model credentials. Exact prerequisite: set OPENAI_API_KEY or ANTHROPIC_API_KEY (and optionally STAGEHAND_MODEL).",
      503,
    );
  }

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
      for (let i = 0; i < (input.maxSteps ?? 4); i += 1) {
        const result = (await stagehand.act(input.instruction)) as {
          message?: string;
          success?: boolean;
        };
        actions.push(input.instruction);
        summary = result?.message ?? summary;
        if (result?.success !== false) break;
      }
      return { ok: true, summary, actions, observed };
    } finally {
      await stagehand.close();
    }
  } finally {
    await browser.close();
  }
}
