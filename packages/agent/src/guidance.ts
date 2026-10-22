/**
 * Interactive guidance for the extension (Driver.js).
 *
 * Guidance is derived from the recorded workflow, never invented. If the
 * recorded step has no structural selector there is nothing safe to point at,
 * so `highlightable` is false and the UI must fall back to a text instruction:
 * highlighting arbitrary coordinates would be a lie about what we know.
 */
import type { Guidance, Workflow } from "@copilot/shared";

export function guidanceFor(workflow: Workflow, stepIndex: number): Guidance | null {
  const step = workflow.steps.find((s) => s.index === stepIndex);
  if (!step) return null;
  const instruction = step.intent || `${step.action} the highlighted element`;
  const elementName = step.elementName ?? step.fieldLabel ?? step.ocrText ?? null;
  const selector = step.selector;
  return {
    skillId: "",
    stepIndex: step.index,
    totalSteps: workflow.steps.length,
    action: step.action,
    instruction,
    selector,
    elementName,
    risk: step.risk,
    highlightable: Boolean(selector),
  };
}
