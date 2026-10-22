import { describe, expect, it } from "vitest";
import { inspectWorkflow, type RawWorkflow } from "@copilot/workflow";

const raw: RawWorkflow = {
  name: "Create customer",
  schema_version: 1,
  param_specs: [
    { name: "company_name", required: true },
    { name: "password", required: true },
  ],
  secret_params: ["password"],
  steps: [
    {
      id: "s1",
      intent: "Open the new customer form",
      action: "click",
      risk: "reversible",
      anchor: {
        structural: { selector: "#new-customer", role: "button", name: "New customer" },
      },
    },
    {
      id: "s2",
      intent: "Type the company name",
      action: "type",
      param: "company_name",
      field_label: "Company name",
      anchor: { ocr_text: "Company name" },
    },
    {
      id: "s3",
      intent: "Save the customer",
      action: "click",
      risk: "irreversible",
      anchor: { structural: { selector: "#save-customer" } },
    },
    {
      id: "s4",
      intent: "Something with no anchor",
      action: "click",
      risk: "reversible",
      anchor: null,
    },
  ],
};

describe("inspectWorkflow", () => {
  const inspected = inspectWorkflow(raw);

  it("keeps structural identity and full confidence for localized targets", () => {
    const step = inspected.steps[0]!;
    expect(step.anchorKind).toBe("structural");
    expect(step.confidence).toBe("identified");
    expect(step.elementRole).toBe("button");
    expect(step.elementName).toBe("New customer");
    expect(step.selector).toBe("#new-customer");
  });

  it("marks OCR-only targets probable and records why", () => {
    const step = inspected.steps[1]!;
    expect(step.anchorKind).toBe("ocr");
    expect(step.confidence).toBe("probable");
    expect(step.uncertaintyNote).toContain("ocr");
    expect(inspected.uncertainty.some((u) => u.includes("step 2"))).toBe(true);
  });

  it("marks a step with no anchor as unknown", () => {
    const step = inspected.steps[3]!;
    expect(step.anchorKind).toBe("none");
    expect(step.confidence).toBe("unknown");
  });

  it("preserves the recorded risk class", () => {
    expect(inspected.steps[2]!.risk).toBe("irreversible");
    expect(inspected.hasIrreversibleStep).toBe(true);
  });

  it("derives parameters from param_specs and secret_params only", () => {
    expect(inspected.params.map((p) => p.name)).toEqual([
      "company_name",
      "password",
    ]);
    expect(inspected.params.find((p) => p.name === "password")?.secret).toBe(true);
    expect(inspected.params.find((p) => p.name === "company_name")?.secret).toBe(
      false,
    );
  });

  it("falls back to step parameters when the bundle declares none", () => {
    const fallback = inspectWorkflow({
      name: "typed only",
      steps: [
        {
          intent: "type sku",
          action: "type",
          param: "sku",
          field_label: "SKU",
          anchor: { structural: { selector: "#item-sku" } },
        },
      ],
    });
    expect(fallback.params).toEqual([
      { name: "sku", label: "SKU", required: true, secret: false },
    ]);
  });
});
