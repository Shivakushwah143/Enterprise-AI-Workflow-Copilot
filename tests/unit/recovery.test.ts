import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FailureResult, Skill, VerificationContract, Workflow } from "@copilot/shared";
import type { Store } from "@copilot/knowledge";
import type { EngineReplayResult, WorkflowEngine } from "@copilot/workflow";
import { recoverOnce } from "@copilot/agent";

const state = { written: false, replays: 0, unreachable: false };
let server: Server;
let contract: VerificationContract;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (state.unreachable) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "down" }));
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const name = url.searchParams.get("name") ?? "";
    const items = state.written ? [{ name, email: "ops@northwind.test" }] : [];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ items }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  contract = {
    kind: "http",
    tier: "system_of_record",
    url: `http://127.0.0.1:${port}/api/customers?name={company_name}`,
    recordPath: "items",
    expect: { name: "company_name", email: "email" },
    match: "equals",
  };
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  state.written = false;
  state.replays = 0;
  state.unreachable = false;
});

function failure(overrides: Partial<FailureResult> = {}): FailureResult {
  return {
    origin: "timing",
    code: "ENGINE_TIMEOUT",
    detectedBy: "engine",
    detail: "the engine timed out",
    stepIndex: null,
    evidence: {},
    ...overrides,
  };
}

function engine(): WorkflowEngine {
  return {
    kind: "stub",
    probe: async () => ({ ok: true }),
    recordScripted: async () => ({ ok: false, recordingDir: "", events: 0, frames: 0 }),
    recordInteractive: async () => {
      throw new Error("not used");
    },
    compile: async () => ({ ok: false, bundleDir: "", workflowJson: null }),
    replay: async (): Promise<EngineReplayResult> => {
      state.replays += 1;
      state.written = true;
      return {
        ok: true,
        reportPath: "/tmp/report.json",
        success: true,
        executionOutcome: "COMPLETED",
        transactionOutcome: "COMMITTED",
        haltReason: null,
        haltIntent: null,
        rungCounts: { structural: 2 },
        healCount: 0,
        modelCalls: 0,
        totalMs: 10,
        stepsTotalMs: 10,
        engineOverheadMs: 0,
        steps: [],
      };
    },
  } as WorkflowEngine;
}

const store = { findRepairs: async () => [] } as unknown as Store;

const workflow = {
  id: "wf-1",
  tenantId: "tenant-1",
  applicationId: "app-1",
  applicationName: "AcmeDesk CRM",
  name: "Create customer",
  description: null,
  status: "approved",
  bundlePath: "/tmp/sealed-bundle",
  recordingId: null,
  steps: [],
  uncertainty: [],
  createdAt: "2026-10-22T00:00:00.000Z",
} as Workflow;

const skill = { id: "skill-1", workflowId: "wf-1", applicationId: "app-1", version: 2 } as Skill;

function request(over: Partial<Parameters<typeof recoverOnce>[0]> = {}): Parameters<typeof recoverOnce>[0] {
  return {
    store,
    engine: engine(),
    tenantId: "tenant-1",
    userId: "user-1",
    skill,
    workflow,
    inputs: { company_name: "Northwind Freight", email: "ops@northwind.test" },
    applicationUrl: "http://127.0.0.1:4300",
    runDir: "/tmp/copilot-run",
    contract,
    failure: failure(),
    replayValues: { company_name: "Northwind Freight", email: "ops@northwind.test" },
    ...over,
  };
}

describe("bounded recovery", () => {
  it("does not retry an application rejection", async () => {
    const result = await recoverOnce(request({ failure: failure({ origin: "application" }) }));
    expect(result.summary.attempted).toBe(false);
    expect(state.replays).toBe(0);
  });

  it("does not retry a locator failure: the engine owns resolution of a sealed bundle", async () => {
    const result = await recoverOnce(
      request({ failure: failure({ origin: "selector", stepIndex: 5, code: "AMBIGUOUS_TARGET" }) }),
    );
    expect(result.summary.attempted).toBe(false);
    expect(result.summary.reason).toContain("sealed workflow");
    expect(state.replays).toBe(0);
  });

  it("refuses when the record already exists, so a write is never repeated", async () => {
    state.written = true;
    const result = await recoverOnce(request());
    expect(state.replays).toBe(0);
    expect(result.summary.attempts[0]?.outcome).toBe("refused");
    expect(result.summary.attempts[0]?.detail).toContain("duplicate");
  });

  it("refuses when the business state cannot be read before retrying", async () => {
    state.unreachable = true;
    const result = await recoverOnce(request());
    expect(state.replays).toBe(0);
    expect(result.summary.attempts[0]?.outcome).toBe("refused");
    expect(result.summary.attempts[0]?.detail).toContain("could not be read");
  });

  it("replays a transient failure exactly once and verifies the result", async () => {
    const result = await recoverOnce(request());
    expect(state.replays).toBe(1);
    expect(result.summary.attempts).toHaveLength(1);
    expect(result.summary.attempts[0]?.outcome).toBe("recovered");
    expect(result.verification?.passed).toBe(true);
  });

  it("stops safely when the retry does not verify", async () => {
    const result = await recoverOnce(
      request({
        engine: {
          ...engine(),
          replay: async (): Promise<EngineReplayResult> => {
            state.replays += 1;
            return {
              ok: true,
              reportPath: "/tmp/report.json",
              success: false,
              executionOutcome: "HALTED",
              transactionOutcome: null,
              haltReason: "still broken",
              haltIntent: null,
              rungCounts: {},
              healCount: 0,
              modelCalls: 0,
              totalMs: 5,
              stepsTotalMs: 0,
              engineOverheadMs: 5,
              steps: [],
            };
          },
        } as WorkflowEngine,
      }),
    );
    expect(state.replays).toBe(1);
    expect(result.summary.attempts[0]?.outcome).toBe("not_recovered");
  });
});
