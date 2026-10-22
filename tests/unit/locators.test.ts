import { describe, expect, it } from "vitest";
import { hasSemanticFallback, locatorLadder } from "@copilot/workflow";
import type { WorkflowStep } from "@copilot/shared";

function step(overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    id: "step-1",
    index: 0,
    intent: "click 'Save customer'",
    action: "click",
    risk: "irreversible",
    anchorKind: "structural",
    elementRole: "button",
    elementName: "Save customer",
    selector: "#save-customer",
    ocrText: null,
    fieldLabel: null,
    paramName: null,
    isSecret: false,
    postconditions: [],
    confidence: "identified",
    uncertaintyNote: null,
    ...overrides,
  };
}

describe("locator preference", () => {
  it("tries the recorded selector first, then semantic identity", () => {
    const ladder = locatorLadder(step());
    expect(ladder[0]).toMatchObject({ kind: "recorded", value: "#save-customer", priority: 0 });
    expect(ladder[1]?.kind).toBe("role");
    expect(ladder[1]?.value).toBe('role=button[name="Save customer"]');
    expect(ladder.at(-1)?.kind).toBe("text");
    expect(ladder.map((row) => row.priority)).toEqual([...ladder.map((row) => row.priority)].sort((a, b) => a - b));
  });

  it("offers semantic fallbacks when the recorded selector is gone", () => {
    const ladder = locatorLadder(step({ selector: null }));
    expect(ladder.map((row) => row.kind)).toEqual(["role", "text"]);
    expect(hasSemanticFallback(step({ selector: null }))).toBe(true);
  });

  it("uses the field label for a typing step", () => {
    const ladder = locatorLadder(
      step({
        action: "type",
        selector: null,
        elementRole: null,
        elementName: null,
        fieldLabel: "Contact email",
        intent: "type <email>",
      }),
    );
    expect(ladder[0]).toMatchObject({ kind: "label", value: 'label="Contact email"' });
  });

  it("falls back to the label quoted in the intent", () => {
    const ladder = locatorLadder(
      step({
        selector: null,
        elementRole: null,
        elementName: null,
        fieldLabel: null,
        intent: "click 'New customer'",
      }),
    );
    expect(ladder).toHaveLength(1);
    expect(ladder[0]).toMatchObject({ kind: "text", value: 'text="New customer"' });
  });

  it("proposes nothing for a keyboard-only step", () => {
    expect(locatorLadder(step({ action: "key", selector: null }))).toEqual([]);
  });

  it("escapes quotes in accessible names", () => {
    const ladder = locatorLadder(step({ elementName: 'Say "hi"' }));
    expect(ladder[1]?.value).toBe('role=button[name="Say \\"hi\\""]');
  });
});
