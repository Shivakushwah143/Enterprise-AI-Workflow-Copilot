/**
 * Execution: deterministic replay + independent verification.
 *
 * The outcome is decided by EVIDENCE, in this order:
 *   1. a pre-run read of the system of record (a record that already exists is
 *      refused, so a "success" can never be a record left by an earlier run);
 *   2. the engine's replay report (one witness, never the only one);
 *   3. a post-run read of the system of record (the deciding witness).
 *
 * The rule the copilot must never break: engine success + oracle miss is
 * FAILED, not success.
 *
 * Around that decision this module does three things the M0 baseline showed
 * were missing:
 *   - it records where each failure originated, with the evidence it used;
 *   - it records real timings (per step from the engine, per phase here);
 *   - it proves the engine actually placed each typed value, and localises a
 *     mismatch to its step instead of reporting "record absent".
 *
 * When a *locator* failure occurs, one bounded repair attempt is allowed
 * (`recoverOnce`). Approval, tenancy and the verification contract are not
 * widened by recovery: it re-uses the approval the run already carried.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  ExecutionOutcome,
  ExecutionPhaseTimings,
  ExecutionStepResult,
  ExecutionTimings,
  FailureResult,
  MemoryMode,
  Plan,
  RecoverySummary,
  Skill,
  VerificationResult,
  Workflow,
} from "@copilot/shared";
import type { Store, ExecutionRow } from "@copilot/knowledge";
import {
  verifyAgainstContract,
  type EngineReplayResult,
  type EngineStepResult,
  type WorkflowEngine,
  type VerifyOutcome,
} from "@copilot/workflow";
import { classifyFailure, type BlockedReason } from "./failures.js";
import {
  knownTargets,
  loadRepairDecisions,
  memoryAudit,
  type RepairDecision,
} from "./memory.js";
import { bindParameters, missingRequired, replayValues } from "./parameters.js";
import { recoverOnce } from "./recovery.js";
import type { TargetResolution, TargetResolver } from "./targets.js";

export interface ExecuteOptions {
  store: Store;
  engine: WorkflowEngine;
  tenantId: string;
  userId: string;
  plan: Plan;
  skill: Skill;
  workflow: Workflow;
  inputs: Record<string, string>;
  approved: boolean;
  /** Base URL the recorded workflow was demonstrated against. */
  applicationUrl: string;
  artifactRoot: string;
  /** Optional live locator resolution; omitted in unit tests. */
  resolveTargets?: TargetResolver | undefined;
  /** Reviewed procedural memory; `disabled` means "do not even read it". */
  memoryMode?: MemoryMode | undefined;
  log?: (event: Record<string, unknown>) => void;
}

/**
 * Attribute the run to procedural memory, and decide what actually applied.
 *
 * Three outcomes are possible per applicable repair:
 *   - it supplied the selector the pre-flight resolver used (`source: repair`);
 *   - the ladder rediscovered the same control, so the repair is confirmed as
 *     still correct (it did not change what ran, and is not counted as used);
 *   - nothing used it, which is recorded with a reason rather than dropped.
 */
function matchRepairs(
  decisions: RepairDecision[],
  resolutions: TargetResolution[],
): {
  applied: { repairId: string; stepIndex: number }[];
  confirmed: string[];
} {
  const applied: { repairId: string; stepIndex: number }[] = [];
  const confirmed: string[] = [];

  for (const resolution of resolutions) {
    if (resolution.source === "repair" && resolution.repairId) {
      const decision = decisions.find((row) => row.repair.id === resolution.repairId);
      if (!decision?.applicable) continue;
      applied.push({ repairId: decision.repair.id, stepIndex: resolution.stepIndex });
      resolution.detail = `reviewed repair ${decision.repair.id} supplied ${resolution.selector} for step ${resolution.stepIndex + 1}`;
      continue;
    }
    if (resolution.source !== "rediscovered" || !resolution.selector) continue;
    const decision = decisions.find(
      (row) => row.applicable && row.repair.action.stepIndex === resolution.stepIndex,
    );
    if (!decision) continue;
    if (decision.repair.action.toSelector !== resolution.selector) {
      decision.reason = `reviewed repair ${decision.repair.id} expects ${decision.repair.action.toSelector}, the live control is ${resolution.selector}`;
      continue;
    }
    confirmed.push(decision.repair.id);
    resolution.detail = `approved repair ${decision.repair.id} confirmed the live control`;
  }

  return { applied, confirmed };
}

function mapSteps(
  workflow: Workflow,
  engineSteps: EngineStepResult[],
  resolutions: TargetResolution[],
): ExecutionStepResult[] {
  const byIndex = new Map(engineSteps.map((step) => [step.index, step]));
  const resolutionByIndex = new Map(resolutions.map((row) => [row.stepIndex, row]));

  return workflow.steps.map((step) => {
    const resolution = resolutionByIndex.get(step.index);
    const resolvedSelector = resolution?.selector ?? step.selector;
    const resolutionSource = resolution?.source ?? (step.selector ? "recorded" : "none");
    const repairId = resolution?.repairId ?? null;
    const result = byIndex.get(step.index);

    if (!result) {
      return {
        index: step.index,
        stepId: step.id,
        intent: step.intent,
        status: "not_run",
        rung: null,
        detail: "The engine stopped before this step.",
        durationMs: null,
        inputVerified: null,
        resolvedSelector,
        resolutionSource,
        repairId,
      };
    }

    // The engine's own field check is authoritative about whether the value
    // landed; a step that typed the wrong value is a failed step, not a
    // successful one with a bad outcome later.
    const inputMismatch = result.inputVerified === false;
    const status = result.skipped
      ? "skipped"
      : result.ok && !inputMismatch
        ? "ok"
        : "failed";

    // Keep both witnesses: how the engine resolved the step, and what our own
    // live resolution saw (especially when a reviewed repair confirmed it).
    const engineNote = result.error ?? (result.rung ? `resolved via ${result.rung}` : null);
    const resolutionNote =
      resolution && resolution.source !== "recorded" ? resolution.detail : null;

    return {
      index: step.index,
      stepId: step.id,
      intent: step.intent,
      status,
      rung: result.rung,
      detail: inputMismatch
        ? "The field did not contain the requested value after typing."
        : [engineNote, resolutionNote].filter(Boolean).join(" · ") || null,
      // INTEGER column: the engine reports fractional milliseconds.
      durationMs:
        result.durationMs === null || result.durationMs === undefined
          ? null
          : Math.round(result.durationMs),
      inputVerified: result.inputVerified ?? null,
      resolvedSelector,
      resolutionSource,
      repairId,
    };
  });
}

export async function executeSkill(options: ExecuteOptions): Promise<ExecutionRow> {
  const { store, engine, tenantId, plan, skill, workflow, inputs } = options;
  const log = options.log ?? (() => {});
  const startedAt = Date.now();

  const execution = await store.createExecution({
    tenantId,
    skillId: skill.id,
    workflowId: workflow.id,
    intent: plan.intent,
    inputs,
    requestedBy: options.userId,
  });

  const bindings = bindParameters(workflow, skill);
  const requiredValues = replayValues(bindings, inputs);
  const missing = missingRequired(bindings, inputs);
  const memoryMode: MemoryMode = options.memoryMode ?? "enabled";

  // M4: procedural memory is consulted once, before anything is acted on. With
  // `disabled`, the store is never asked: no repair can influence this run.
  const decisions = await loadRepairDecisions(
    store,
    {
      tenantId,
      applicationId: workflow.applicationId,
      workflowId: workflow.id,
      workflowVersion: skill.version,
      applicationUrl: options.applicationUrl,
      steps: workflow.steps,
    },
    memoryMode,
  );
  let appliedRepairs: { repairId: string; stepIndex: number }[] = [];
  let confirmedRepairs: string[] = [];
  const redactValues = [...Object.values(requiredValues), ...Object.values(inputs)];

  const phases: ExecutionPhaseTimings = {
    bridgeStartupMs: null,
    replayMs: null,
    engineOverheadMs: null,
    verificationMs: 0,
    persistenceMs: null,
  };
  const phaseBudget = (): ExecutionTimings => ({
    totalMs: Date.now() - startedAt,
    phases: { ...phases },
    engineReportedMs: phases.replayMs,
  });

  const finalize = async (args: {
    outcome: ExecutionOutcome;
    message: string;
    failure: FailureResult | null;
    steps: ExecutionStepResult[];
    verification: VerificationResult | null;
    recovery: RecoverySummary | null;
    engineOutcome: string | null;
    engineReportPath: string | null;
    modelCalls: number;
  }): Promise<ExecutionRow> => {
    const persistStarted = Date.now();
    if (args.steps.length > 0) {
      await store.replaceExecutionSteps(tenantId, execution.id, args.steps);
    }
    if (args.verification) {
      await store.addVerification(tenantId, execution.id, args.verification);
    }
    phases.persistenceMs = Date.now() - persistStarted;

    const status =
      args.outcome === "VERIFIED" || args.outcome === "COMPLETED_UNVERIFIED"
        ? "succeeded"
        : args.outcome === "HALTED"
          ? "halted"
          : "failed";

    await store.updateExecution(tenantId, execution.id, {
      status,
      outcome: args.outcome,
      engineOutcome: args.engineOutcome,
      engineReportPath: args.engineReportPath,
      message: args.message,
      modelCalls: args.modelCalls,
      finishedAt: new Date().toISOString(),
      failure: args.failure,
      timings: phaseBudget(),
      recovery: args.recovery,
      memory: memoryAudit(memoryMode, decisions, appliedRepairs, confirmedRepairs),
    });

    // Episodic memory is best-effort: losing it must never change the verdict.
    await store
      .addEpisode(tenantId, {
        executionId: execution.id,
        skillId: skill.id,
        workflowId: workflow.id,
        applicationId: workflow.applicationId,
        intent: plan.intent,
        outcome: args.outcome,
        failure: args.failure,
        recovery: args.recovery,
        traceRef: args.engineReportPath,
        context: {
          applicationUrl: options.applicationUrl,
          approved: options.approved,
          inputs: Object.fromEntries(
            bindings.filter((binding) => !binding.secret).map((binding) => [binding.name, inputs[binding.name] ?? null]),
          ),
        },
      })
      .catch(() => undefined);

    log({
      event: "execution.finished",
      executionId: execution.id,
      outcome: args.outcome,
      failureOrigin: args.failure?.origin ?? null,
      failureCode: args.failure?.code ?? null,
      recovery: args.recovery?.attempts.at(0)?.outcome ?? null,
      timings: phaseBudget(),
      verified: args.outcome === "VERIFIED",
    });

    const finished = await store.getExecution(tenantId, execution.id);
    return finished ?? { ...execution, outcome: args.outcome, message: args.message };
  };

  const refuse = async (outcome: ExecutionOutcome, blocked: BlockedReason): Promise<ExecutionRow> =>
    finalize({
      outcome,
      message: blocked.detail,
      failure: classifyFailure({ blocked }),
      steps: [],
      verification: null,
      recovery: null,
      engineOutcome: null,
      engineReportPath: null,
      modelCalls: 0,
    });

  if (missing.length > 0) {
    return refuse("REJECTED", {
      origin: "reasoning",
      code: "INPUT_MISSING",
      detail: `Missing required inputs: ${missing.map((m) => m.name).join(", ")}. The agent will not guess values.`,
    });
  }

  const irreversible = workflow.steps.filter((step) => step.risk === "irreversible");
  if (irreversible.length > 0 && !options.approved) {
    return refuse("REJECTED_POLICY", {
      origin: "policy",
      code: "APPROVAL_REQUIRED",
      detail: `Refused: ${irreversible.length} irreversible step(s) require explicit approval before execution.`,
      detectedBy: "policy",
    });
  }

  const contract = skill.verification;

  // 1. Pre-run oracle read: refuse to re-create what already exists.
  if (contract) {
    const verificationStarted = Date.now();
    const pre = await verifyAgainstContract(contract, inputs);
    phases.verificationMs = (phases.verificationMs ?? 0) + (Date.now() - verificationStarted);
    if (pre.passed) {
      return finalize({
        outcome: "REJECTED",
        message:
          "Refused: a matching record already exists in the system of record, so a success here could not be attributed to this run.",
        failure: classifyFailure({
          verification: pre,
          blocked: {
            origin: "verification",
            code: "ORACLE_PRE_EXISTING_RECORD",
            detail: `A matching record already exists before this run: ${pre.detail}`,
            detectedBy: "oracle",
          },
        }),
        steps: [],
        verification: {
          ...pre,
          passed: false,
          detail: `A matching record already exists in the system of record before this run: ${pre.detail}`,
          createdAt: new Date().toISOString(),
        },
        recovery: null,
        engineOutcome: null,
        engineReportPath: null,
        modelCalls: 0,
      });
    }
  }

  if (!workflow.bundlePath) {
    return refuse("FAILED", {
      origin: "infrastructure",
      code: "BUNDLE_MISSING",
      detail: "The workflow has no compiled bundle to replay.",
      detectedBy: "copilot",
    });
  }

  const runDir = path.join(options.artifactRoot, "runs", execution.id);
  await store.updateExecution(tenantId, execution.id, { status: "running" });

  // 2. Locate the targets before acting. A consequential control that cannot be
  //    identified is a refusal, not a hopeful click.
  let resolutions: TargetResolution[] = [];
  if (options.resolveTargets) {
    try {
      resolutions = await options.resolveTargets(workflow.steps, knownTargets(decisions));
    } catch (error) {
      log({
        event: "execution.target_resolution_failed",
        executionId: execution.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const matched = matchRepairs(decisions, resolutions);
  appliedRepairs = matched.applied;
  confirmedRepairs = matched.confirmed;

  const unresolvedConsequential = resolutions.filter(
    (row) =>
      row.source === "none" &&
      workflow.steps.some((step) => step.index === row.stepIndex && step.risk === "irreversible"),
  );
  if (unresolvedConsequential.length > 0) {
    return finalize({
      outcome: "FAILED",
      message: `Refused: could not safely identify ${unresolvedConsequential.length} consequential control(s): step ${unresolvedConsequential
        .map((row) => row.stepIndex + 1)
        .join(", ")}. Nothing was clicked or typed.`,
      failure: classifyFailure({
        steps: [],
        blocked: {
          origin: "selector",
          code: "CONTROL_NOT_RESOLVED",
          detail: unresolvedConsequential.map((row) => row.detail).join(" | "),
        },
      }),
      steps: [],
      verification: null,
      recovery: null,
      engineOutcome: null,
      engineReportPath: null,
      modelCalls: 0,
    });
  }

  // The approved bundle is sealed by the engine and must not be edited: a
  // modified copy is rejected (`BundleIntegrityError`). Re-discovery therefore
  // only *observes* drift; the engine's own resolution rungs decide how to act.
  const bundleDir = workflow.bundlePath;

  // 3. Replay, one attempt.
  const replayStarted = Date.now();
  let replay: EngineReplayResult | null = null;
  let thrown: unknown;
  try {
    replay = await engine.replay({
      bundleDir,
      url: options.applicationUrl,
      runDir,
      params: requiredValues,
      timeoutMs: Number(process.env.ENGINE_TIMEOUT_MS ?? 5 * 60_000),
    });
  } catch (error) {
    thrown = error;
  }
  const replayWallMs = Date.now() - replayStarted;
  if (replay) {
    phases.replayMs = replay.totalMs;
    phases.bridgeStartupMs = Math.max(0, replayWallMs - replay.totalMs);
    phases.engineOverheadMs = replay.engineOverheadMs;
  } else {
    phases.bridgeStartupMs = replayWallMs;
  }

  const steps = mapSteps(workflow, replay?.steps ?? [], resolutions);
  await store.replaceExecutionSteps(tenantId, execution.id, steps);

  // 4. Independent verification decides success.
  let verification: VerificationResult | null = null;
  if (contract) {
    const verificationStarted = Date.now();
    const post = await verifyAgainstContract(contract, inputs);
    phases.verificationMs = (phases.verificationMs ?? 0) + (Date.now() - verificationStarted);
    verification = { ...post, createdAt: new Date().toISOString() };
  }

  let outcome: ExecutionOutcome;
  let message: string;
  const engineSucceeded = Boolean(replay?.success) && replay?.executionOutcome !== "HALTED";

  if (replay?.error) {
    outcome = "FAILED";
    message = `The workflow engine failed: ${replay.error}`;
    if (verification?.passed) {
      outcome = "VERIFIED";
      message = `The engine failed (${replay.error}) but the system of record contains the record, so the business effect was achieved.`;
    }
  } else if (!replay) {
    outcome = "FAILED";
    message = `The workflow engine did not return a result: ${
      thrown instanceof Error ? thrown.message : "unknown adapter failure"
    }`;
  } else if (verification) {
    if (verification.passed && engineSucceeded) {
      outcome = "VERIFIED";
      message = "Execution completed and the record was confirmed in the system of record.";
    } else if (verification.passed && !engineSucceeded) {
      outcome = "VERIFIED";
      message = `The engine stopped (${replay.haltReason ?? replay.executionOutcome ?? "halted"}) but the record exists in the system of record.`;
    } else if (!verification.passed && engineSucceeded) {
      outcome = "FAILED";
      message = `The engine reported success but the system of record does not contain the record. ${verification.detail}`;
    } else {
      outcome = "FAILED";
      message = `Execution did not complete (${replay.haltReason ?? replay.executionOutcome ?? "halted"}) and the record is absent. ${verification.detail}`;
    }
  } else {
    outcome = engineSucceeded ? "COMPLETED_UNVERIFIED" : "HALTED";
    message = engineSucceeded
      ? "Execution finished, but no verification contract is bound to this skill, so completion cannot be proven."
      : `Execution stopped: ${replay.haltReason ?? replay.executionOutcome ?? "halted"}.`;
  }

  // 5. Procedural memory. A verified run that needed a re-discovered control
  //    is exactly the evidence a repair is made of, and an applied repair's
  //    history is updated either way. Neither promotes a repair by itself.
  if (outcome === "VERIFIED") {
    for (const applied of appliedRepairs) {
      await store
        .recordRepairUse(tenantId, applied.repairId, true)
        .catch(() => null);
    }
    // A confirmation is evidence the repair still holds, so it is history too.
    for (const repairId of confirmedRepairs) {
      await store.recordRepairUse(tenantId, repairId, true).catch(() => null);
    }
    for (const resolution of resolutions) {
      if (resolution.source !== "rediscovered" || !resolution.selector) continue;
      if (appliedRepairs.some((applied) => applied.stepIndex === resolution.stepIndex)) continue;
      const step = workflow.steps.find((candidate) => candidate.index === resolution.stepIndex);
      // Only a *drift* is a repair. A step that never had a recorded selector
      // (a typed field located by its label) is normal parameter binding.
      if (!step?.selector || step.selector === resolution.selector) continue;
      await store
        .createRepair(tenantId, {
          applicationId: workflow.applicationId,
          workflowId: workflow.id,
          skillId: skill.id,
          workflowVersion: skill.version,
          failureOrigin: "selector",
          failureCode: "RECORDED_SELECTOR_MISSING",
          action: {
            kind: "selector_override",
            stepIndex: resolution.stepIndex,
            fromSelector: step?.selector ?? null,
            toSelector: resolution.selector,
          },
          conditions: { applicationUrl: options.applicationUrl },
          createdBy: options.userId,
        })
        .catch(() => null);
    }
  } else {
    for (const repairId of [...appliedRepairs.map((row) => row.repairId), ...confirmedRepairs]) {
      await store.recordRepairUse(tenantId, repairId, false).catch(() => null);
    }
  }

  let failure = classifyFailure({ replay, verification, steps, thrown, redact: redactValues });
  let recoverySummary: RecoverySummary | null = null;
  let finalSteps = steps;
  let recoveredVerification: VerificationResult | null = null;
  let finalReplay = replay;

  // 5. One bounded repair for locator failures. Never for application
  //    rejections or a missing oracle: those are answers, not obstacles.
  if (outcome !== "VERIFIED" && replay) {
    const recovery = await recoverOnce({
      store,
      engine,
      tenantId,
      userId: options.userId,
      skill,
      workflow,
      inputs,
      applicationUrl: options.applicationUrl,
      runDir,
      contract,
      failure,
      replayValues: requiredValues,
      log,
    });
    recoverySummary = recovery.summary;

    const recoveredNow =
      recovery.verification?.passed === true &&
      recovery.summary.attempts.some((attempt) => attempt.outcome === "recovered");

    if (recoveredNow && recovery.replay) {
      finalReplay = recovery.replay;
      finalSteps = mapSteps(workflow, recovery.replay.steps, resolutions);
      recoveredVerification = {
        ...recovery.verification!,
        createdAt: new Date().toISOString(),
      };
      outcome = "VERIFIED";
      message = `Recovered from a ${failure.origin} failure (${failure.code}) with one repair attempt; the record was confirmed in the system of record.`;
    } else if (recovery.summary.attempts.length > 0) {
      failure = {
        ...failure,
        evidence: { ...failure.evidence, recovery: recovery.summary },
        detail: `${failure.detail} Recovery did not produce a verified outcome.`,
      };
    }
  }

  return finalize({
    outcome,
    message,
    failure: outcome === "VERIFIED" ? null : failure,
    steps: recoverySummary ? finalSteps : steps,
    verification: recoverySummary
      ? (recoveredVerification ?? verification)
      : verification,
    recovery: recoverySummary,
    engineOutcome: finalReplay?.executionOutcome ?? finalReplay?.transactionOutcome ?? null,
    engineReportPath: finalReplay?.reportPath ?? null,
    modelCalls: finalReplay?.modelCalls ?? 0,
  });
}

/** The replay URL is the application's base URL, resolved by the API layer. */
export function newId(): string {
  return randomUUID();
}

export type { VerifyOutcome };
