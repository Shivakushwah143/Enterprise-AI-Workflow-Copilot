import { describe, expect, it } from "vitest";
import type { Skill, Workflow, WorkflowStep } from "@copilot/shared";
import { bindParameters, missingRequired, replayValues } from "@copilot/agent";

function step(overrides: Partial<WorkflowStep> & { index: number }): WorkflowStep {
  return {
    id: `step-${overrides.index}`,
    intent: "type <param>",
    action: "type",
    risk: "reversible",
    anchorKind: "structural",
    elementRole: "textbox",
    elementName: null,
    selector: "#field",
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

const workflow = {
  id: "wf-1",
  tenantId: "tenant-1",
  applicationId: "app-1",
  applicationName: "AcmeDesk CRM",
  name: "Create customer",
  description: null,
  status: "approved",
  bundlePath: "/tmp/bundle",
  recordingId: null,
  steps: [
    step({ index: 0, intent: "click 'New customer'", action: "click", paramName: null }),
    step({ index: 1, intent: "type <company_name>", paramName: "company_name", fieldLabel: "Company name" }),
    step({ index: 2, intent: "type <email>", paramName: "email", fieldLabel: "Contact email" }),
    step({ index: 3, intent: "click 'Save customer'", action: "click", risk: "irreversible", paramName: null }),
  ],
  uncertainty: [],
  createdAt: "2026-10-22T00:00:00.000Z",
} as Workflow;

const skill = {
  id: "skill-1",
  tenantId: "tenant-1",
  workflowId: "wf-1",
  workflowName: "Create customer",
  applicationId: "app-1",
  name: "Create customer",
  description: "Create a customer",
  status: "active",
  requiredInputs: [
    { name: "company_name", label: "Company name", required: true, secret: false },
    { name: "email", label: "Contact email", required: false, secret: false },
    { name: "notes", label: "Notes", required: false, secret: false },
    { name: "api_token", label: "API token", required: false, secret: true },
  ],
  triggeredBy: ["customer"],
  verification: null,
  approvedBy: "admin",
  approvedAt: "2026-10-22T00:00:00.000Z",
  version: 3,
} as Skill;

describe("parameter binding", () => {
  it("maps a parameter to the steps that consume it", () => {
    const bindings = bindParameters(workflow, skill);
    const company = bindings.find((row) => row.name === "company_name");
    expect(company?.steps).toEqual([1]);
    expect(company?.fieldLabels).toEqual(["Company name"]);
    expect(company?.inferredFromSteps).toBe(false);
  });

  it("treats a parameter a step consumes as required even when the skill says optional", () => {
    const bindings = bindParameters(workflow, skill);
    expect(bindings.find((row) => row.name === "email")?.required).toBe(true);
  });

  it("keeps a declared-optional, unused parameter optional", () => {
    const bindings = bindParameters(workflow, skill);
    expect(bindings.find((row) => row.name === "notes")?.required).toBe(false);
  });

  it("carries secrecy from the skill spec", () => {
    const bindings = bindParameters(workflow, skill);
    expect(bindings.find((row) => row.name === "api_token")?.secret).toBe(true);
  });

  it("discovers a parameter that only the steps declare", () => {
    const legacy = {
      ...workflow,
      steps: [...workflow.steps, step({ index: 4, intent: "type <reference>", paramName: "reference" })],
    } as Workflow;
    const bindings = bindParameters(legacy, { ...skill, requiredInputs: [] } as Skill);
    const reference = bindings.find((row) => row.name === "reference");
    expect(reference?.required).toBe(true);
    expect(reference?.inferredFromSteps).toBe(true);
  });

  it("reports only required bindings with no value", () => {
    const bindings = bindParameters(workflow, skill);
    const missing = missingRequired(bindings, { company_name: "Northwind Freight" });
    expect(missing.map((row) => row.name)).toEqual(["email"]);
  });

  it("never hands a secret value to the engine", () => {
    const bindings = bindParameters(workflow, skill);
    const values = replayValues(bindings, {
      company_name: "Northwind Freight",
      email: "ops@northwind.test",
      api_token: "secret-value",
    });
    expect(values).toEqual({ company_name: "Northwind Freight", email: "ops@northwind.test" });
    expect(JSON.stringify(values)).not.toContain("secret-value");
  });
});
