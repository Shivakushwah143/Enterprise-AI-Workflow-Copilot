import { describe, expect, it } from "vitest";
import type { Skill, Workflow, WorkflowStep } from "@copilot/shared";
import { buildPlan, extractInputs, scoreSkills, type SkillContext } from "@copilot/agent";

function step(index: number, overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    id: `step-${index}`,
    index,
    intent: `step ${index}`,
    action: "click",
    risk: "reversible",
    anchorKind: "structural",
    elementRole: "button",
    elementName: null,
    selector: `#s${index}`,
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

const workflow: Workflow = {
  id: "wf-1",
  tenantId: "t-1",
  applicationId: "app-1",
  applicationName: "AcmeDesk CRM",
  name: "Create customer",
  description: "Creates a customer",
  status: "approved",
  bundlePath: "/tmp/bundle",
  recordingId: null,
  steps: [
    step(0, { intent: "Open the new customer form", elementName: "New customer" }),
    step(1, { intent: "Type the company name", fieldLabel: "Company name" }),
  ],
  uncertainty: [],
  createdAt: new Date().toISOString(),
};

const skill: Skill = {
  id: "skill-1",
  tenantId: "t-1",
  workflowId: "wf-1",
  workflowName: "Create customer",
  applicationId: "app-1",
  name: "Create customer",
  description: "Creates a customer in AcmeDesk CRM",
  status: "active",
  requiredInputs: [
    { name: "company_name", label: "Company name", required: true, secret: false },
    { name: "email", label: "Contact email", required: true, secret: false },
  ],
  triggeredBy: ["customer"],
  verification: null,
  approvedBy: "admin@acme.test",
  approvedAt: new Date().toISOString(),
  version: 1,
};

function resolution(mutate: Partial<Parameters<typeof buildPlan>[0]["resolution"]> = {}) {
  return {
    skillId: skill.id,
    confidence: 0.8,
    scores: [],
    inputs: { company_name: "Globex Ltd", email: "ops@globex.test" },
    missing: [],
    method: "deterministic" as const,
    modelCalls: 0,
    notes: [],
    ...mutate,
  };
}

describe("extractInputs", () => {
  it("extracts typed values and never guesses a secret", () => {
    const { inputs, missing } = extractInputs(
      'Create a customer named "Globex Ltd" with contact ops@globex.test',
      [
        { name: "company_name", label: "Company name", required: true, secret: false },
        { name: "email", label: "Email", required: true, secret: false },
        { name: "api_token", label: "Token", required: true, secret: true },
      ],
    );
    expect(inputs["company_name"]).toBe("Globex Ltd");
    expect(inputs["email"]).toBe("ops@globex.test");
    expect(inputs["api_token"]).toBeUndefined();
    expect(missing.map((m) => m.name)).toContain("api_token");
  });

  it("does not read a quantity out of a SKU", () => {
    const { inputs } = extractInputs('Register stock item "SKU-8842" with quantity 40', [
      { name: "sku", label: "SKU", required: true, secret: false },
      { name: "quantity", label: "Quantity", required: true, secret: false },
    ]);
    expect(inputs["sku"]).toBe("SKU-8842");
    expect(inputs["quantity"]).toBe("40");
  });

  it("honours explicit key: value pairs", () => {
    const { inputs } = extractInputs("do it with quantity: 42", [
      { name: "quantity", label: "Quantity", required: true, secret: false },
    ]);
    expect(inputs["quantity"]).toBe("42");
  });
});

describe("scoreSkills", () => {
  it("explains which intent tokens matched", () => {
    const contexts: SkillContext[] = [{ skill, workflow }];
    const [best] = scoreSkills(contexts, "create a customer for Globex");
    expect(best?.skillId).toBe(skill.id);
    expect(best?.score).toBeGreaterThan(0);
    expect(best?.reason).toContain("matched");
  });
});

describe("buildPlan", () => {
  it("blocks when no approved skill exists", () => {
    const plan = buildPlan({
      tenantId: "t-1",
      intent: "create a customer",
      resolution: resolution({ skillId: null, inputs: {}, scores: [] }),
      contexts: [],
    });
    expect(plan.skillId).toBeNull();
    expect(plan.blockers).toHaveLength(1);
    expect(plan.blockers[0]).toContain("No approved skills");
  });

  it("carries the resolved inputs into the plan and exposes resolved values", () => {
    const plan = buildPlan({
      tenantId: "t-1",
      intent: "create a customer",
      resolution: resolution(),
      contexts: [{ skill, workflow }],
    });
    expect(plan.blockers).toEqual([]);
    expect(plan.resolvedInputs).toEqual([
      { name: "company_name", label: "Company name", secret: false, value: "Globex Ltd" },
      { name: "email", label: "Contact email", secret: false, value: "ops@globex.test" },
    ]);
    expect(plan.requiresApproval).toBe(false);
  });

  it("requires approval for consequential language even on a reversible workflow", () => {
    const plan = buildPlan({
      tenantId: "t-1",
      intent: "delete the customer record",
      resolution: resolution(),
      contexts: [{ skill, workflow }],
    });
    expect(plan.requiresApproval).toBe(true);
    expect(plan.approvalReason).toContain("consequential");
  });

  it("requires approval and names the steps when the workflow is irreversible", () => {
    const irreversible: Workflow = {
      ...workflow,
      steps: [step(0), step(1, { action: "submit", risk: "irreversible" })],
    };
    const plan = buildPlan({
      tenantId: "t-1",
      intent: "create a customer",
      resolution: resolution(),
      contexts: [{ skill, workflow: irreversible }],
    });
    expect(plan.requiresApproval).toBe(true);
    expect(plan.approvalReason).toContain("irreversible");
  });

  it("blocks when the workflow behind the skill is no longer approved", () => {
    const plan = buildPlan({
      tenantId: "t-1",
      intent: "create a customer",
      resolution: resolution(),
      contexts: [{ skill, workflow: { ...workflow, status: "draft" } }],
    });
    expect(plan.blockers.some((b) => b.includes("no longer approved"))).toBe(true);
  });

  it("never records a secret value in the plan", () => {
    const withSecret: Skill = {
      ...skill,
      requiredInputs: [
        ...skill.requiredInputs,
        { name: "api_token", label: "Token", required: true, secret: true },
      ],
    };
    const plan = buildPlan({
      tenantId: "t-1",
      intent: "create a customer",
      resolution: resolution({
        inputs: { company_name: "Globex Ltd", email: "ops@globex.test", api_token: "s3cret" },
      }),
      contexts: [{ skill: withSecret, workflow }],
    });
    const token = plan.resolvedInputs.find((i) => i.name === "api_token");
    expect(token?.value).toBeNull();
    expect(plan.requiresApproval).toBe(true);
  });
});
