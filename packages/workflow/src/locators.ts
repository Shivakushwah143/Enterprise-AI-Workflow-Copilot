/**
 * Stable locator preference.
 *
 * Coordinates are the last resort, never the identity of a control. For each
 * step we prefer, in order:
 *
 *   1. the structural selector captured at record time (DOM identity);
 *   2. role + accessible name (semantic identity, survives markup changes);
 *   3. the field label;
 *   4. the visible text of the control.
 *
 * This module is pure: it only proposes candidates. Resolving them against a
 * live page happens in `apps/api/src/targets.ts`, and a candidate that does not
 * resolve is dropped — never guessed at.
 */
import type { WorkflowStep } from "@copilot/shared";

export type LocatorKind = "recorded" | "role" | "label" | "text";

export interface LocatorCandidate {
  kind: LocatorKind;
  priority: number;
  note: string;
  /** Playwright selector string, for audit and simple fallbacks. */
  value: string;
  role?: string;
  name?: string;
  label?: string;
  text?: string;
}

/** Public, flatter shape used by callers that only need to display a ladder. */
export interface StableLocator {
  kind: LocatorKind;
  value: string;
  priority: number;
  note: string;
}

const QUOTED = /'([^']{2,80})'|"([^"]{2,80})"/;

function quotedLabelFromIntent(intent: string): string | null {
  const match = QUOTED.exec(intent);
  return (match?.[1] ?? match?.[2] ?? null)?.trim() || null;
}

function cssString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Ordered candidates for one step, with their structured identity. A step with
 * no target (key press, wait) yields an empty list, which the caller treats as
 * "nothing to resolve".
 */
export function locatorCandidates(
  step: Pick<
    WorkflowStep,
    "action" | "selector" | "elementRole" | "elementName" | "fieldLabel" | "intent"
  >,
): LocatorCandidate[] {
  const candidates: LocatorCandidate[] = [];
  const seen = new Set<string>();
  const add = (candidate: LocatorCandidate): void => {
    const key = candidate.value.trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  };

  if (!["click", "type", "select", "hover", "submit"].includes(step.action)) {
    return candidates;
  }

  if (step.selector?.trim()) {
    add({
      kind: "recorded",
      priority: 0,
      note: "selector captured at record time",
      value: step.selector.trim(),
    });
  }

  const role = step.elementRole?.trim();
  const name = step.elementName?.trim();
  if (role && name) {
    add({
      kind: "role",
      priority: 1,
      note: "accessible role and name",
      value: `role=${role}[name=${cssString(name)}]`,
      role,
      name,
    });
  }
  if (step.fieldLabel?.trim()) {
    const label = step.fieldLabel.trim();
    add({
      kind: "label",
      priority: 2,
      note: "field label",
      value: `label=${cssString(label)}`,
      label,
    });
  }
  const text = name ?? quotedLabelFromIntent(step.intent);
  if (text) {
    add({
      kind: "text",
      priority: 3,
      note: name ? "visible control text" : "visible text named in the step",
      value: `text=${cssString(text)}`,
      text,
    });
  }

  return candidates.sort((a, b) => a.priority - b.priority);
}

/** Ordered Playwright selector strings for one step. */
export function locatorLadder(
  step: Parameters<typeof locatorCandidates>[0],
): StableLocator[] {
  return locatorCandidates(step).map(({ kind, value, priority, note }) => ({
    kind,
    value,
    priority,
    note,
  }));
}

/** True when the ladder offers any semantic (non-recorded) fallback. */
export function hasSemanticFallback(step: Parameters<typeof locatorCandidates>[0]): boolean {
  return locatorCandidates(step).some((candidate) => candidate.kind !== "recorded");
}
