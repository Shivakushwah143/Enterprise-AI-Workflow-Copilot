/**
 * Bounded recovery.
 *
 *   classify -> decide eligibility -> validate business state -> recover
 *            -> verify -> store the result
 *
 * What recovery can honestly do here is bounded by the engine: an approved
 * workflow bundle is sealed, and a modified copy is rejected outright
 * (`BundleIntegrityError`). So recovery never rewrites a control; it retries a
 * run that failed for a *transient* reason (the bridge timed out, the browser
 * session was lost, the engine reported an adapter failure), exactly once.
 *
 * Rules enforced here, not documented and hoped for:
 *
 *   - one attempt per execution: one replay, no loop;
 *   - the system of record is read again first, so a consequential write is
 *     never silently repeated — if the record already exists, recovery refuses;
 *   - if the oracle cannot be read, the outcome is unknown and recovery refuses
 *     rather than risking a duplicate;
 *   - a locator drift is *not* retried: the engine already resolves it through
 *     its own rungs, and replaying the same sealed bundle would add nothing;
 *   - approval, tenancy and the verification contract are inherited from the
 *     approved execution; recovery never widens them.
 */
import type {
  FailureOrigin,
  FailureResult,
  RecoveryAttempt,
  RecoverySummary,
  Skill,
  VerificationContract,
  Workflow,
} from "@copilot/shared";
import type { Store } from "@copilot/knowledge";
import {
  verifyAgainstContract,
  type EngineReplayResult,
  type VerifyOutcome,
  type WorkflowEngine,
} from "@copilot/workflow";

const RETRY_TIMEOUT_MS = Number(process.env.ENGINE_TIMEOUT_MS ?? 5 * 60_000);

/** Only failures that say nothing about the application's state are retryable. */
const RETRYABLE: ReadonlySet<FailureOrigin> = new Set<FailureOrigin>([
  "timing",
  "browser_session",
]);

export interface RecoveryRequest {
  store: Store;
  engine: WorkflowEngine;
  tenantId: string;
  userId: string;
  skill: Skill;
  workflow: Workflow;
  inputs: Record<string, string>;
  applicationUrl: string;
  /** Directory of the failed attempt; the retry gets a sibling. */
  runDir: string;
  contract: VerificationContract | null;
  failure: FailureResult;
  /** Non-secret replay values, already bound. */
  replayValues: Record<string, string>;
  log?: (event: Record<string, unknown>) => void;
}

export interface RecoveryResult {
  summary: RecoverySummary;
  replay: EngineReplayResult | null;
  verification: VerifyOutcome | null;
}

function notAttempted(reason: string): RecoveryResult {
  return { summary: { attempted: false, reason, attempts: [] }, replay: null, verification: null };
}

function refused(reason: string, detail: string, verification: VerifyOutcome | null): RecoveryResult {
  const attempt: RecoveryAttempt = {
    source: "rediscovery",
    repairId: null,
    stepIndex: null,
    fromSelector: null,
    toSelector: null,
    outcome: "refused",
    detail,
    verifyPassed: false,
  };
  return {
    summary: { attempted: true, reason, attempts: [attempt] },
    replay: null,
    verification,
  };
}

export async function recoverOnce(request: RecoveryRequest): Promise<RecoveryResult> {
  const log = request.log ?? (() => {});

  if (!RETRYABLE.has(request.failure.origin)) {
    return notAttempted(
      `${request.failure.origin} failures are not repaired by replaying the same sealed workflow`,
    );
  }

  // 1. Never repeat a consequential write. Read the business state again.
  if (request.contract) {
    const pre = await verifyAgainstContract(request.contract, request.inputs);
    if (pre.passed) {
      return refused(
        "business state already contains the record",
        "A matching record already exists in the system of record, so a retry could duplicate the write. The run stopped instead.",
        pre,
      );
    }
    if (/could not read|unreachable|returned http/i.test(pre.detail)) {
      return refused(
        "business state could not be read",
        `The system of record could not be read before the retry (${pre.detail}), so the outcome is unknown. Refusing to retry.`,
        pre,
      );
    }
  }

  // 2. One replay of the approved bundle, unchanged.
  let replay: EngineReplayResult | null = null;
  let verification: VerifyOutcome | null = null;
  let detail = "";
  try {
    replay = await request.engine.replay({
      bundleDir: request.workflow.bundlePath ?? "",
      url: request.applicationUrl,
      runDir: `${request.runDir}-retry`,
      params: request.replayValues,
      timeoutMs: RETRY_TIMEOUT_MS,
    });
    verification = request.contract
      ? await verifyAgainstContract(request.contract, request.inputs)
      : null;
    detail = verification?.detail ?? replay.error ?? replay.haltReason ?? "replayed once";
  } catch (error) {
    detail = `retry failed: ${error instanceof Error ? error.message : String(error)}`;
  }

  const verified = verification?.passed === true;
  const attempt: RecoveryAttempt = {
    source: "rediscovery",
    repairId: null,
    stepIndex: null,
    fromSelector: null,
    toSelector: null,
    outcome: verified ? "recovered" : "not_recovered",
    detail,
    verifyPassed: verified,
  };

  log({
    event: "recovery.finished",
    recovered: verified,
    origin: request.failure.origin,
    code: request.failure.code,
  });

  return {
    summary: { attempted: true, reason: `one retry after a ${request.failure.origin} failure`, attempts: [attempt] },
    replay,
    verification,
  };
}
