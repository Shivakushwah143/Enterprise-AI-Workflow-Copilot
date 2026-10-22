/**
 * Stagehand: AI-assisted browser interaction for the cases deterministic replay
 * cannot encode (a one-off read, an application we have not demonstrated yet).
 *
 * Honest boundary, stated in the API and the UI: Stagehand drives its OWN
 * controlled browser session. It cannot take over the browser tab the extension
 * is attached to. The two sessions are not interchangeable, and this module
 * never pretends otherwise.
 */
import { CopilotError, type CapabilityStatus } from "@copilot/shared";

export interface StagehandStatus {
  status: CapabilityStatus;
  detail: string;
}

interface StagehandModule {
  Stagehand: new (options: Record<string, unknown>) => {
    init(): Promise<void>;
    page: unknown;
    act(options: { action: string }): Promise<unknown>;
    close(): Promise<void>;
  };
}

/**
 * The specifier is a runtime value on purpose: the package is optional, so it
 * must not become a compile-time dependency of the API bundle. A missing
 * install is a reported capability gap, not a build failure.
 */
const STAGEHAND_PACKAGE = "@browserbasehq/stagehand";

async function loadStagehand(): Promise<StagehandModule | null> {
  try {
    const specifier: string = STAGEHAND_PACKAGE;
    const mod = (await import(specifier)) as unknown as StagehandModule;
    return mod;
  } catch {
    return null;
  }
}

function llmKey(): { provider: "openai" | "anthropic"; apiKey: string; model: string } | null {
  if (process.env.OPENAI_API_KEY) {
    return {
      provider: "openai",
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.STAGEHAND_MODEL ?? "gpt-4o-mini",
    };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      provider: "anthropic",
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.STAGEHAND_MODEL ?? "claude-3-5-sonnet-latest",
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
        "The @browserbasehq/stagehand package is not installed. Install it (pnpm add @browserbasehq/stagehand) to enable the AI browser path; deterministic replay is unaffected.",
    };
  }
  const key = llmKey();
  if (!key) {
    return {
      status: "unconfigured",
      detail:
        "Stagehand is installed but no model credentials are configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY. Stagehand drives its own controlled browser, not the extension's tab.",
    };
  }
  return {
    status: "configured",
    detail: `Stagehand ready via ${key.provider} (${key.model}). It drives a separate controlled Chromium session; it cannot attach to the extension's tab.`,
  };
}

export interface StagehandTaskResult {
  ok: boolean;
  summary: string;
  actions: string[];
}

/**
 * Run one natural-language browser task in a controlled session.
 * Throws `capability_unavailable` (503) when the prerequisites are missing, so
 * callers can report BLOCKED rather than inventing a result.
 */
export async function runStagehandTask(input: {
  url: string;
  instruction: string;
  maxSteps?: number;
}): Promise<StagehandTaskResult> {
  const mod = await loadStagehand();
  if (!mod) {
    throw new CopilotError(
      "capability_unavailable",
      "Stagehand is not installed. Exact prerequisite: pnpm add @browserbasehq/stagehand.",
      503,
    );
  }
  const key = llmKey();
  if (!key) {
    throw new CopilotError(
      "capability_unavailable",
      "Stagehand needs model credentials. Exact prerequisite: set OPENAI_API_KEY or ANTHROPIC_API_KEY (and optionally STAGEHAND_MODEL).",
      503,
    );
  }

  const stagehand = new mod.Stagehand({
    env: "LOCAL",
    headless: process.env.STAGEHAND_HEADLESS !== "false",
    modelName: key.model,
    modelClientOptions: { apiKey: key.apiKey },
  });
  await stagehand.init();
  try {
    // `page` is Stagehand's own Playwright page in its controlled browser.
    const page = stagehand.page as { goto?: (url: string) => Promise<unknown> };
    if (page.goto) await page.goto(input.url);
    const actions: string[] = [];
    let summary = "";
    for (let i = 0; i < (input.maxSteps ?? 6); i += 1) {
      // Stagehand's act() is the single action primitive used here; the loop is
      // bounded so a wrong plan cannot wander the application.
      const result = (await stagehand.act({ action: input.instruction })) as {
        message?: string;
        success?: boolean;
      };
      actions.push(`${i + 1}. ${input.instruction}`);
      summary = result?.message ?? summary;
      if (result?.success !== false) break;
    }
    return { ok: true, summary, actions };
  } finally {
    await stagehand.close();
  }
}
