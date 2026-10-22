/**
 * Procedural memory: does a stored repair apply to *this* run?
 *
 * A repair is not a fact about an application in general; it is a fact about
 * one tenant's workflow, at one version, on one application. Reuse is therefore
 * gated on every one of those, and the decision is recorded rather than assumed:
 * the execution carries what was retrieved, why it did or did not apply, and
 * whether it was actually used.
 *
 * Two rules this module exists to enforce:
 *
 *   - `memory: "disabled"` performs no read at all. A run cannot benefit from
 *     memory it never asked the store for.
 *   - a repair learned on another application (or another workflow version) is
 *     never applicable, even inside the same tenant. Cross-application reuse
 *     would need its own validation and approval, which this does not provide.
 */
import type { MemoryAudit, MemoryMode, Repair, Workflow, WorkflowStep } from "@copilot/shared";
import type { Store } from "@copilot/knowledge";

export interface RepairContext {
  tenantId: string;
  applicationId: string;
  workflowId: string;
  workflowVersion: number;
  applicationUrl: string;
  steps: WorkflowStep[];
}

export interface RepairDecision {
  repair: Repair;
  applicable: boolean;
  reason: string;
}

/** What the pre-flight resolver may use, and the repair each entry came from. */
export interface KnownTarget {
  stepIndex: number;
  selector: string;
  repairId: string;
}

function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Conditions under which a stored repair may be used again. Every clause is a
 * separate answer, because "not applicable" is useful evidence too.
 */
export function assessRepair(repair: Repair, context: RepairContext): RepairDecision {
  const not = (reason: string): RepairDecision => ({ repair, applicable: false, reason });

  if (repair.applicationId !== context.applicationId) {
    return not("learned on a different application");
  }
  if (repair.workflowId !== context.workflowId) {
    return not("learned on a different workflow");
  }
  if (repair.workflowVersion !== context.workflowVersion) {
    return not(
      `learned for workflow version ${repair.workflowVersion}; this run uses version ${context.workflowVersion}`,
    );
  }

  const learnedOn = typeof repair.conditions["applicationUrl"] === "string"
    ? originOf(repair.conditions["applicationUrl"] as string)
    : null;
  const runningOn = originOf(context.applicationUrl);
  if (learnedOn && runningOn && learnedOn !== runningOn) {
    return not(`learned against ${learnedOn}, this run targets ${runningOn}`);
  }

  const step = context.steps.find((candidate) => candidate.index === repair.action.stepIndex);
  if (!step) return not(`step ${repair.action.stepIndex + 1} no longer exists in this workflow`);

  // The repair describes a control that moved. If the workflow's recorded
  // selector changed since, the premise of the repair is gone.
  if (repair.action.fromSelector && step.selector && repair.action.fromSelector !== step.selector) {
    return not(
      `the recorded control changed since the repair was learned (${repair.action.fromSelector} → ${step.selector})`,
    );
  }

  return {
    repair,
    applicable: true,
    reason: `reviewed repair for step ${repair.action.stepIndex + 1} on this workflow version`,
  };
}

/**
 * Retryable failures are not repairs; a repair that does not name a step cannot
 * be applied to one.
 */
export function loadRepairDecisions(
  store: Store,
  context: RepairContext,
  mode: MemoryMode,
): Promise<RepairDecision[]> {
  if (mode === "disabled") return Promise.resolve([]);

  return store
    .findRepairs(context.tenantId, {
      applicationId: context.applicationId,
      workflowId: context.workflowId,
      status: "approved",
    })
    .then((repairs) => repairs.map((repair) => assessRepair(repair, context)))
    .catch(() => []);
}

export function knownTargets(decisions: RepairDecision[]): KnownTarget[] {
  return decisions
    .filter((decision) => decision.applicable)
    .map((decision) => ({
      stepIndex: decision.repair.action.stepIndex,
      selector: decision.repair.action.toSelector,
      repairId: decision.repair.id,
    }));
}

export function memoryAudit(
  mode: MemoryMode,
  decisions: RepairDecision[],
  applied: { repairId: string; stepIndex: number }[],
  confirmed: string[] = [],
): MemoryAudit {
  return {
    mode,
    retrieved: decisions.map((decision) => ({
      repairId: decision.repair.id,
      stepIndex: decision.repair.action.stepIndex,
      applicable: decision.applicable,
      reason: decision.reason,
      applied: applied.some((row) => row.repairId === decision.repair.id),
    })),
    appliedRepairIds: applied.map((row) => row.repairId),
    confirmedRepairIds: confirmed,
  };
}

/** The workflow as memory sees it; kept here so callers cannot disagree. */
export function repairContext(
  input: Omit<RepairContext, "steps"> & { workflow: Workflow },
): RepairContext {
  return {
    tenantId: input.tenantId,
    applicationId: input.applicationId,
    workflowId: input.workflowId,
    workflowVersion: input.workflowVersion,
    applicationUrl: input.applicationUrl,
    steps: input.workflow.steps,
  };
}
