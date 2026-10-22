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
 * FAILED, not success. That is the exact failure mode Scenario C exercises.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  ExecutionOutcome,
  ExecutionStepResult,
  Plan,
  Skill,
  VerificationResult,
  Workflow,
} from "@copilot/shared";
import type { Store, ExecutionRow } from "@copilot/knowledge";
import { verifyAgainstContract, type WorkflowEngine } from "@copilot/workflow";

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
  log?: (event: Record<string, unknown>) => void;
}

function mapSteps(
  workflow: Workflow,
  engineSteps: { index: number; stepId: string | null; intent: string; ok: boolean; skipped: boolean; rung: string | null; error: string | null }[],
): ExecutionStepResult[] {
  const byIndex = new Map(engineSteps.map((s) => [s.index, s]));
  return workflow.steps.map((step) => {
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
      };
    }
    return {
      index: step.index,
      stepId: step.id,
      intent: step.intent,
      status: result.skipped ? "skipped" : result.ok ? "ok" : "failed",
      rung: result.rung,
      detail: result.error ?? (result.rung ? `resolved via ${result.rung}` : null),
      durationMs: null,
    };
  });
}

export async function executeSkill(options: ExecuteOptions): Promise<ExecutionRow> {
  const { store, engine, tenantId, plan, skill, workflow, inputs } = options;
  const log = options.log ?? (() => {});

  const missing = skill.requiredInputs.filter((p) => !inputs[p.name]);
  const execution = await store.createExecution({
    tenantId,
    skillId: skill.id,
    workflowId: workflow.id,
    intent: plan.intent,
    inputs,
    requestedBy: options.userId,
  });

  if (missing.length > 0) {
    await store.updateExecution(tenantId, execution.id, {
      status: "failed",
      outcome: "REJECTED",
      message: `Missing required inputs: ${missing.map((m) => m.name).join(", ")}. The agent will not guess values.`,
      finishedAt: new Date().toISOString(),
    });
    const refused = await store.getExecution(tenantId, execution.id);
    return refused ?? execution;
  }

  const irreversible = workflow.steps.filter((s) => s.risk === "irreversible");
  if (irreversible.length > 0 && !options.approved) {
    await store.updateExecution(tenantId, execution.id, {
      status: "failed",
      outcome: "REJECTED_POLICY",
      message: `Refused: ${irreversible.length} irreversible step(s) require explicit approval before execution.`,
      finishedAt: new Date().toISOString(),
    });
    log({ event: "execution.rejected_policy", executionId: execution.id });
    const refused = await store.getExecution(tenantId, execution.id);
    return refused ?? execution;
  }

  const contract = skill.verification;
  // 1. Pre-run oracle read: refuse to re-create something that already exists.
  if (contract) {
    const pre = await verifyAgainstContract(contract, inputs);
    if (pre.passed) {
      await store.addVerification(tenantId, execution.id, {
        ...pre,
        passed: false,
        detail: `A matching record already exists in the system of record before this run: ${pre.detail}`,
        createdAt: new Date().toISOString(),
      });
      await store.updateExecution(tenantId, execution.id, {
        status: "failed",
        outcome: "REJECTED",
        message:
          "Refused: a matching record already exists in the system of record, so a success here could not be attributed to this run.",
        finishedAt: new Date().toISOString(),
      });
      log({ event: "execution.precheck_conflict", executionId: execution.id });
      const refused = await store.getExecution(tenantId, execution.id);
      return refused ?? execution;
    }
  }

  if (!workflow.bundlePath) {
    await store.updateExecution(tenantId, execution.id, {
      status: "failed",
      outcome: "FAILED",
      message: "The workflow has no compiled bundle to replay.",
      finishedAt: new Date().toISOString(),
    });
    const failed = await store.getExecution(tenantId, execution.id);
    return failed ?? execution;
  }

  const runDir = path.join(options.artifactRoot, "runs", execution.id);
  await store.updateExecution(tenantId, execution.id, { status: "running" });

  const replayInputs: Record<string, string> = {};
  for (const param of skill.requiredInputs) {
    const value = inputs[param.name];
    if (value !== undefined && !param.secret) replayInputs[param.name] = value;
  }
  // Secret values are injected through the environment by the engine, never
  // through argv: see openadapt_flow.replayer.secret_env_var.

  const replay = await engine.replay({
    bundleDir: workflow.bundlePath,
    url: options.applicationUrl,
    runDir,
    params: replayInputs,
    timeoutMs: Number(process.env.ENGINE_TIMEOUT_MS ?? 5 * 60_000),
  });

  const steps = mapSteps(workflow, replay.steps);
  await store.replaceExecutionSteps(tenantId, execution.id, steps);

  // 2 + 3. Independent verification decides success.
  let verification: VerificationResult | null = null;
  if (contract) {
    const post = await verifyAgainstContract(contract, inputs);
    verification = { ...post, createdAt: new Date().toISOString() };
    await store.addVerification(tenantId, execution.id, verification);
  }

  let outcome: ExecutionOutcome;
  let message: string;
  const engineSucceeded = replay.success && replay.executionOutcome !== "HALTED";

  if (!replay.ok && replay.error) {
    outcome = "FAILED";
    message = `The workflow engine failed: ${replay.error}`;
    if (verification?.passed) {
      outcome = "VERIFIED";
      message = `The engine failed (${replay.error}) but the system of record contains the record, so the business effect was achieved.`;
    }
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

  await store.updateExecution(tenantId, execution.id, {
    status: outcome === "VERIFIED" || outcome === "COMPLETED_UNVERIFIED" ? "succeeded" : outcome === "HALTED" ? "halted" : "failed",
    outcome,
    engineOutcome: replay.executionOutcome ?? replay.transactionOutcome ?? null,
    engineReportPath: replay.reportPath,
    message,
    modelCalls: replay.modelCalls,
    finishedAt: new Date().toISOString(),
  });

  log({
    event: "execution.finished",
    executionId: execution.id,
    outcome,
    engineOutcome: replay.executionOutcome,
    rungCounts: replay.rungCounts,
    healCount: replay.healCount,
    modelCalls: replay.modelCalls,
    verified: Boolean(verification?.passed),
    durationMs: replay.totalMs,
  });

  const finished = await store.getExecution(tenantId, execution.id);
  if (finished) return finished;
  return { ...execution, status: "failed", outcome, message };
}

/** The replay URL is the application's base URL, resolved by the API layer. */
export function newId(): string {
  return randomUUID();
}
