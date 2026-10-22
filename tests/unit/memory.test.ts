import { describe, expect, it } from "vitest";
import type { Repair, WorkflowStep } from "@copilot/shared";
import type { Store } from "@copilot/knowledge";
import {
  assessRepair,
  knownTargets,
  loadRepairDecisions,
  memoryAudit,
  type RepairContext,
} from "@copilot/agent";

const SAVE_STEP: WorkflowStep = {
  id: "step_005",
  index: 5,
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
};

function repair(overrides: Partial<Repair> = {}): Repair {
  return {
    id: "repair-1",
    tenantId: "tenant-1",
    applicationId: "app-crm",
    workflowId: "workflow-1",
    skillId: "skill-1",
    workflowVersion: 1,
    failureOrigin: "selector",
    failureCode: "RECORDED_SELECTOR_MISSING",
    action: {
      kind: "selector_override",
      stepIndex: 5,
      fromSelector: "#save-customer",
      toSelector: "#save-customer-v2",
    },
    conditions: { applicationUrl: "http://127.0.0.1:4300" },
    status: "approved",
    successCount: 1,
    failureCount: 0,
    createdBy: "user-admin",
    reviewedBy: "user-admin",
    createdAt: "2026-10-22T00:00:00.000Z",
    reviewedAt: "2026-10-22T00:05:00.000Z",
    lastUsedAt: null,
    ...overrides,
  };
}

function context(overrides: Partial<RepairContext> = {}): RepairContext {
  return {
    tenantId: "tenant-1",
    applicationId: "app-crm",
    workflowId: "workflow-1",
    workflowVersion: 1,
    applicationUrl: "http://127.0.0.1:4300",
    steps: [SAVE_STEP],
    ...overrides,
  };
}

function fakeStore(rows: Repair[], calls: unknown[] = []): Store {
  return {
    findRepairs: async (tenantId: string, filter: unknown) => {
      calls.push({ tenantId, filter });
      return rows;
    },
  } as unknown as Store;
}

describe("procedural memory applicability", () => {
  it("accepts a reviewed repair for the same tenant, application, workflow and version", () => {
    const decision = assessRepair(repair(), context());
    expect(decision.applicable).toBe(true);
    expect(knownTargets([decision])).toEqual([
      { stepIndex: 5, selector: "#save-customer-v2", repairId: "repair-1" },
    ]);
  });

  it("refuses a repair learned on another application, even in the same tenant", () => {
    const decision = assessRepair(repair(), context({ applicationId: "app-hr" }));
    expect(decision.applicable).toBe(false);
    expect(decision.reason).toContain("different application");
    expect(knownTargets([decision])).toEqual([]);
  });

  it("refuses a repair from an older workflow version", () => {
    const decision = assessRepair(repair(), context({ workflowVersion: 2 }));
    expect(decision.applicable).toBe(false);
    expect(decision.reason).toContain("version 1");
  });

  it("refuses a repair learned against a different origin", () => {
    const decision = assessRepair(repair(), context({ applicationUrl: "http://127.0.0.1:4400" }));
    expect(decision.applicable).toBe(false);
    expect(decision.reason).toContain("127.0.0.1:4400");
  });

  it("refuses a repair whose premise no longer holds", () => {
    const moved = { ...SAVE_STEP, selector: "#other-save" };
    const decision = assessRepair(repair(), context({ steps: [moved] }));
    expect(decision.applicable).toBe(false);
    expect(decision.reason).toContain("recorded control changed");
  });
});

describe("memory mode", () => {
  it("does not read the store at all when memory is disabled", async () => {
    const calls: unknown[] = [];
    const decisions = await loadRepairDecisions(
      fakeStore([repair()], calls),
      context(),
      "disabled",
    );
    expect(decisions).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("queries by application, workflow and approved status when enabled", async () => {
    const calls: { filter: Record<string, unknown> }[] = [];
    const decisions = await loadRepairDecisions(
      fakeStore([repair()], calls),
      context(),
      "enabled",
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.applicable).toBe(true);
    expect(calls[0]!.filter).toEqual({
      applicationId: "app-crm",
      workflowId: "workflow-1",
      status: "approved",
    });
  });

  it("records retrieved, not-applicable and applied repairs in the audit", () => {
    const decisions = [
      { repair: repair(), applicable: true, reason: "ok" },
      { repair: repair({ id: "repair-2", applicationId: "app-hr" }), applicable: false, reason: "different application" },
    ];
    const audit = memoryAudit("enabled", decisions, [{ repairId: "repair-1", stepIndex: 5 }]);
    expect(audit.mode).toBe("enabled");
    expect(audit.appliedRepairIds).toEqual(["repair-1"]);
    expect(audit.retrieved).toEqual([
      expect.objectContaining({ repairId: "repair-1", applicable: true, applied: true }),
      expect.objectContaining({ repairId: "repair-2", applicable: false, applied: false }),
    ]);
  });
});
