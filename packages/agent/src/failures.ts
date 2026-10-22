/**
 * Failure classification.
 *
 * `FAILED` is not an answer. The operator needs to know whose fault it was: the
 * planner chose the wrong skill, a control moved, the app refused the write, the
 * browser died, the oracle could not be read, or the record is simply absent.
 *
 * This module produces that verdict from evidence the execution already holds
 * (engine report, per-step results, verification outcome) and keeps the raw
 * evidence it looked at. When the evidence does not support a cause it returns
 * `unknown` rather than a plausible guess.
 *
 * Detection source is recorded separately from origin on purpose: an application
 * rejection is *detected* by the oracle but *originated* in the application.
 */
import type {
  ExecutionStepResult,
  FailureOrigin,
  FailureResult,
} from "@copilot/shared";
import type { EngineReplayResult, VerifyOutcome } from "@copilot/workflow";

export interface BlockedReason {
  origin: FailureOrigin;
  code: string;
  detail: string;
  detectedBy?: FailureResult["detectedBy"];
}

export interface FailureSignals {
  replay?: EngineReplayResult | null;
  verification?: VerifyOutcome | null;
  steps?: ExecutionStepResult[];
  /** A refusal raised before the engine ran (missing input, policy, duplicate). */
  blocked?: BlockedReason | null;
  /** An exception thrown by the engine adapter itself. */
  thrown?: unknown;
  /**
   * Values the run typed. They are removed from any application text kept as
   * evidence: an error banner often echoes what was submitted, and a trace must
   * not become a copy of the customer data.
   */
  redact?: string[];
}

/**
 * Application-level evidence of a rejected write, kept from the engine's
 * observed text. Never a response body and never a typed value.
 */
export interface ApplicationEvidence {
  /** `engine_observed_text`: the app's own on-screen message. */
  source: "engine_observed_text";
  /** Lines, sanitized (emails and long numbers redacted, inputs removed). */
  messages: string[];
  /**
   * HTTP status when a response was actually observed. The engine does not
   * expose one today, so this is null rather than invented.
   */
  httpStatus: number | null;
}

/** App-level language that means "this write was refused", not "policy said no". */
const APPLICATION_REJECTION =
  /(save|create|submit|update|add|register|checkout|payment)\s*(failed|rejected|refused|error|not allowed)|validation (rejected|failed|error)|invalid (email|value|field|input)|required field|already exists|duplicate (record|email|entry)|unauthori[sz]ed|permission denied|forbidden|cannot be (saved|created|empty)|is required/i;

function redactText(text: string, secrets: string[]): string {
  let out = text.replace(/\s+/g, " ").trim();
  for (const secret of secrets) {
    const value = secret.trim();
    if (value.length < 3) continue;
    out = out.split(value).join("<redacted>");
  }
  return out
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>")
    .replace(/\b\d{6,}\b/g, "<number>")
    .slice(0, 160);
}

/**
 * Sanitized application evidence from the engine's observed screen text.
 *
 * P0: an application that rejected a write shows it on screen ("Save failed:
 * validation rejected this customer"). Before this, the run only carried the
 * engine's `safety_halt`, so a refusal by the application was reported as a
 * policy stop. The text is the evidence we actually have; we say so, and we do
 * not pretend to have an HTTP status.
 */
export function applicationEvidence(
  texts: string[],
  secrets: string[] = [],
): ApplicationEvidence | null {
  const messages: string[] = [];
  for (const raw of texts) {
    if (typeof raw !== "string") continue;
    const text = redactText(raw, secrets);
    if (!text || !APPLICATION_REJECTION.test(text)) continue;
    if (!messages.includes(text)) messages.push(text);
    if (messages.length >= 4) break;
  }
  return messages.length > 0
    ? { source: "engine_observed_text", messages, httpStatus: null }
    : null;
}

const TEXT_RULES: { pattern: RegExp; origin: FailureOrigin; code: string }[] = [
  { pattern: /timed out|timeout|deadline exceeded/i, origin: "timing", code: "ENGINE_TIMEOUT" },
  {
    pattern: /targetclosed|browser.*closed|context was destroyed|net::err|launch|crash/i,
    origin: "browser_session",
    code: "BROWSER_SESSION_LOST",
  },
  {
    pattern: /geometry rung|human confirmation|only resolved via/i,
    origin: "selector",
    code: "AMBIGUOUS_TARGET",
  },
  {
    pattern: /not found|no bounding box|not visible|selector|locator/i,
    origin: "selector",
    code: "CONTROL_NOT_RESOLVED",
  },
  {
    pattern: /econnrefused|connection refused|database|fetch failed|dns/i,
    origin: "infrastructure",
    code: "DEPENDENCY_UNREACHABLE",
  },
  {
    pattern: /postconditions failed|semantic drift|screen state not reached/i,
    origin: "application",
    code: "APP_STATE_NOT_REACHED",
  },
];

/** Vendor `failure_category` values mapped onto our vocabulary. */
function mapCategory(category: string): { origin: FailureOrigin; code: string } {
  const text = category.toLowerCase();
  if (/input|field|type/.test(text)) return { origin: "input_verification", code: "INPUT_VALUE_MISMATCH" };
  if (/selector|locator|target|resolve|geometry|drift/.test(text)) {
    return { origin: "selector", code: "CONTROL_NOT_RESOLVED" };
  }
  if (/timeout|timing|slow/.test(text)) return { origin: "timing", code: "ENGINE_TIMEOUT" };
  if (/browser|session|page/.test(text)) return { origin: "browser_session", code: "BROWSER_SESSION_LOST" };
  if (/safety_halt|safety/.test(text)) return { origin: "policy", code: "SAFETY_HALT" };
  if (/policy|approval|risk|refus/.test(text)) return { origin: "policy", code: "RISK_POLICY_REFUSAL" };
  if (/app|server|http|network|validat/.test(text)) {
    return { origin: "application", code: "APPLICATION_REJECTED" };
  }
  return { origin: "unknown", code: "UNKNOWN_ENGINE_FAILURE" };
}

export function classifyFailure(signals: FailureSignals): FailureResult {
  const steps = signals.steps ?? [];
  const replay = signals.replay ?? null;
  const verification = signals.verification ?? null;

  const failedSteps = replay?.steps.filter((step) => !step.ok && !step.skipped) ?? [];
  const secrets = signals.redact ?? [];
  const observed = replay?.haltObservedTexts ?? [];
  const appEvidence = applicationEvidence(observed, secrets);
  const evidence: Record<string, unknown> = {
    engineOutcome: replay?.executionOutcome ?? null,
    haltReason: replay?.haltReason ?? null,
    haltIntent: replay?.haltIntent ?? null,
    engineError: replay?.error ?? null,
    rungs: replay?.rungCounts ?? {},
    healCount: replay?.healCount ?? 0,
    stepErrors: failedSteps
      .map((step) => ({
        index: step.index,
        intent: step.intent,
        error: step.error,
        category: step.failureCategory,
        rung: step.rung,
      }))
      .slice(0, 5),
    verificationPassed: verification?.passed ?? null,
    verificationDetail: verification?.detail ?? null,
    applicationEvidence: appEvidence,
    safetyHalt: failedSteps.some((step) => step.safetyHalt) || false,
  };

  // 1. Refusals raised before the engine ran.
  if (signals.blocked) {
    return {
      origin: signals.blocked.origin,
      code: signals.blocked.code,
      detectedBy: signals.blocked.detectedBy ?? "copilot",
      detail: signals.blocked.detail,
      stepIndex: null,
      evidence,
    };
  }

  // 2. A typed value that the engine itself could not confirm is the earliest
  //    attributable cause: everything after it is a consequence.
  const mismatch = steps.find((step) => step.inputVerified === false);
  if (mismatch) {
    return {
      origin: "input_verification",
      code: "INPUT_VALUE_MISMATCH",
      detectedBy: "engine",
      detail: `Step ${mismatch.index + 1} (${mismatch.intent}): the field did not contain the requested value after typing.`,
      stepIndex: mismatch.index,
      evidence,
    };
  }

  // 3. The adapter failed outright (no report, spawn error, timeout).
  const thrown = signals.thrown;
  const thrownText =
    thrown instanceof Error ? thrown.message : thrown === undefined ? null : String(thrown);
  if (thrownText) evidence["thrown"] = thrownText;

  if (replay?.error) {
    const rule = TEXT_RULES.find((candidate) => candidate.pattern.test(replay.error ?? ""));
    return {
      origin: rule?.origin ?? "unknown",
      code: rule?.code ?? "ENGINE_ERROR",
      detectedBy: "engine",
      detail: replay.error,
      stepIndex: failedSteps[0]?.index ?? null,
      evidence,
    };
  }
  if (!replay) {
    return {
      origin: thrownText ? "infrastructure" : "unknown",
      code: thrownText ? "ENGINE_ADAPTER_FAILED" : "ENGINE_NO_REPORT",
      detectedBy: "engine",
      detail: thrownText ?? "The engine returned no replay result and no report.",
      stepIndex: null,
      evidence,
    };
  }

  // 4. The engine stopped a step for safety. Ask what evidence it kept, and
  //    what the application showed: a real policy refusal and a rejected write
  //    both look like `safety_halt` until those two are read.
  const haltStep = failedSteps.find((step) => step.safetyHalt === true);
  if (haltStep) {
    const refusal = failedSteps.find((step) => step.safetyRefusalEvidence != null);
    if (refusal) {
      return {
        origin: "policy",
        code: "SAFETY_HALT",
        detectedBy: "engine",
        detail:
          replay.haltReason ??
          `The engine refused step ${refusal.index + 1} on policy grounds.`,
        stepIndex: refusal.index,
        evidence: { ...evidence, safetyRefusalEvidence: refusal.safetyRefusalEvidence },
      };
    }
    if (appEvidence) {
      return {
        origin: "application",
        code: "APPLICATION_REJECTED",
        detectedBy: "engine",
        detail: `The application rejected the write at step ${haltStep.index + 1}: ${appEvidence.messages[0]!}`,
        stepIndex: haltStep.index,
        evidence,
      };
    }
    // A halt with no refusal record and no application message is a stop we
    // cannot explain. Say so instead of choosing policy.
    return {
      origin: "unknown",
      code: "SAFETY_HALT_UNEXPLAINED",
      detectedBy: "engine",
      detail:
        replay.haltReason ??
        `The engine refused step ${haltStep.index + 1} without recording why.`,
      stepIndex: haltStep.index,
      evidence,
    };
  }

  // 5. The engine reported a structured category for the step that failed.
  const categorised = failedSteps.find((step) => step.failureCategory);
  if (categorised?.failureCategory) {
    const mapped = mapCategory(categorised.failureCategory);
    return {
      origin: mapped.origin,
      code: mapped.code,
      detectedBy: "engine",
      detail: `Step ${categorised.index + 1} (${categorised.intent}) failed as ${categorised.failureCategory}.`,
      stepIndex: categorised.index,
      evidence,
    };
  }

  // 5. The oracle itself being unreadable is infrastructure, whatever the
  //    engine did: the outcome is unknown, not a business failure.
  if (verification && !verification.passed) {
    const detail = verification.detail;
    if (/could not read|unreachable/i.test(detail)) {
      return {
        origin: "infrastructure",
        code: "ORACLE_UNREACHABLE",
        detectedBy: "oracle",
        detail,
        stepIndex: null,
        evidence,
      };
    }
    if (/returned http/i.test(detail)) {
      return {
        origin: "infrastructure",
        code: "ORACLE_HTTP_ERROR",
        detectedBy: "oracle",
        detail,
        stepIndex: null,
        evidence,
      };
    }
  }

  // 6. The engine's own halt text is more specific about the cause than
  //    "the record is absent", which is only the consequence.
  const haltText = [replay.haltReason ?? "", ...failedSteps.map((step) => step.error ?? "")].join(" | ");
  const rule = TEXT_RULES.find((candidate) => candidate.pattern.test(haltText));
  if (rule) {
    return {
      origin: rule.origin,
      code: rule.code,
      detectedBy: "engine",
      detail: replay.haltReason ?? "The engine stopped without a machine-readable category.",
      stepIndex: failedSteps[0]?.index ?? null,
      evidence,
    };
  }

  // 7. Engine quiet, oracle says the record is absent: the dangerous case.
  if (verification && !verification.passed) {
    return {
      origin: "verification",
      code: "ORACLE_RECORD_ABSENT",
      detectedBy: "oracle",
      detail: verification.detail,
      stepIndex: failedSteps[0]?.index ?? null,
      evidence,
    };
  }

  return {
    origin: "unknown",
    code: "UNKNOWN",
    detectedBy: "engine",
    detail:
      replay.haltReason ??
      "The run did not verify and the available evidence does not establish a cause.",
    stepIndex: failedSteps[0]?.index ?? null,
    evidence,
  };
}
