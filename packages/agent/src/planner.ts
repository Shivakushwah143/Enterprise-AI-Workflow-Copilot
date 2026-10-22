/**
 * Plan assembly.
 *
 * The plan is a reviewable artifact, not an action: it states which skill was
 * chosen, why, what is missing, and whether a human must approve. Execution
 * only proceeds from a plan.
 */
import { randomUUID } from "node:crypto";
import type { Plan, Skill, Workflow } from "@copilot/shared";
import type { IntentResolution, SkillContext } from "./intent.js";

/** Words that mark a request as consequential even when the workflow is not. */
const RISKY_INTENT = /\b(delete|remove|refund|transfer|pay|payment|wire|approve|terminate|void|close account)\b/i;

export interface BuildPlanInput {
  tenantId: string;
  intent: string;
  resolution: IntentResolution;
  contexts: SkillContext[];
}

export function buildPlan(input: BuildPlanInput): Plan {
  const chosen = input.contexts.find((c) => c.skill.id === input.resolution.skillId);
  const blockers: string[] = [];
  let approvalReason: string | null = null;

  if (!chosen) {
    blockers.push(
      input.contexts.length === 0
        ? "No approved skills exist in this tenant. An admin must record and approve a workflow first."
        : "No approved skill matches this request. Record and approve a workflow for this task first.",
    );
  }

  if (chosen) {
    const irreversible = chosen.workflow.steps.filter((s) => s.risk === "irreversible");
    if (irreversible.length > 0) {
      approvalReason = `${irreversible.length} step(s) are classified irreversible (${irreversible
        .map((s) => s.intent)
        .join("; ")}).`;
    }
    if (RISKY_INTENT.test(input.intent)) {
      approvalReason = approvalReason
        ? `${approvalReason} The request also uses consequential language.`
        : "The request uses consequential language.";
    }
    if (chosen.skill.requiredInputs.some((p) => p.secret)) {
      approvalReason = approvalReason
        ? `${approvalReason} It needs a secret input.`
        : "The workflow needs a secret input.";
    }
    if (chosen.workflow.status !== "approved") {
      blockers.push("The workflow behind this skill is no longer approved.");
    }
  }

  const resolvedInputs = chosen
    ? chosen.skill.requiredInputs
        .filter((p) => input.resolution.inputs[p.name] !== undefined)
        .map((p) => ({
          name: p.name,
          label: p.label,
          secret: p.secret,
          value: p.secret ? null : (input.resolution.inputs[p.name] ?? null),
        }))
    : [];

  return {
    id: randomUUID(),
    tenantId: input.tenantId,
    intent: input.intent,
    skillId: chosen?.skill.id ?? null,
    skillName: chosen?.skill.name ?? null,
    workflowId: chosen?.workflow.id ?? null,
    applicationId: chosen?.skill.applicationId ?? null,
    confidence: input.resolution.confidence,
    candidates: input.resolution.scores.slice(0, 5),
    missingInputs: chosen ? input.resolution.missing : [],
    resolvedInputs,
    requiresApproval: approvalReason !== null,
    approvalReason,
    blockers,
    createdAt: new Date().toISOString(),
  };
}

export function isRiskyIntent(intent: string): boolean {
  return RISKY_INTENT.test(intent);
}

export type { Skill, Workflow };
