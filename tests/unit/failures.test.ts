import { describe, expect, it } from "vitest";
import type { ExecutionStepResult } from "@copilot/shared";
import { classifyFailure } from "@copilot/agent";
import type { EngineReplayResult, EngineStepResult } from "@copilot/workflow";

function step(overrides: Partial<ExecutionStepResult> = {}): ExecutionStepResult {
  return {
    index: 0,
    stepId: "step_000",
    intent: "click 'Save customer'",
    status: "failed",
    rung: "structural",
    detail: null,
    durationMs: 120,
    inputVerified: null,
    resolvedSelector: "#save-customer",
    resolutionSource: "recorded",
    repairId: null,
    ...overrides,
  };
}

function engineStep(overrides: Partial<EngineStepResult> = {}): EngineStepResult {
  return {
    index: 0,
    stepId: "step_000",
    intent: "click 'Save customer'",
    ok: false,
    skipped: false,
    rung: "structural",
    postconditionsOk: false,
    identityOk: null,
    risk: "irreversible",
    error: null,
    durationMs: 120,
    inputVerified: null,
    fieldRead: null,
    failureCategory: null,
    ...overrides,
  };
}

function replay(overrides: Partial<EngineReplayResult> = {}): EngineReplayResult {
  return {
    ok: true,
    reportPath: "/tmp/report.json",
    success: false,
    executionOutcome: "HALTED",
    transactionOutcome: null,
    haltReason: null,
    haltIntent: null,
    rungCounts: { structural: 1 },
    healCount: 0,
    modelCalls: 0,
    totalMs: 500,
    stepsTotalMs: 400,
    engineOverheadMs: 100,
    steps: [engineStep()],
    ...overrides,
  };
}

const failedOracle = {
  tier: "system_of_record" as const,
  passed: false,
  source: "http://app/api/customers?name=X",
  expected: { name: "X" },
  observed: null,
  detail: "No record in the system of record matched {\"name\":\"X\"} (0 record(s) inspected).",
};

describe("failure classification", () => {
  it("records a refusal raised before the engine as reasoning", () => {
    const failure = classifyFailure({
      blocked: { origin: "reasoning", code: "INPUT_MISSING", detail: "Missing required inputs: email." },
    });
    expect(failure.origin).toBe("reasoning");
    expect(failure.code).toBe("INPUT_MISSING");
    expect(failure.detectedBy).toBe("copilot");
  });

  it("blames the typed value before anything downstream when the engine says it did not land", () => {
    const failure = classifyFailure({
      replay: replay({ steps: [engineStep({ index: 2, intent: "type <email>", inputVerified: false })] }),
      steps: [step({ index: 2, intent: "type <email>", inputVerified: false })],
      verification: failedOracle,
    });
    expect(failure.origin).toBe("input_verification");
    expect(failure.code).toBe("INPUT_VALUE_MISMATCH");
    expect(failure.stepIndex).toBe(2);
  });

  it("separates a timeout from a browser-session loss", () => {
    expect(classifyFailure({ replay: replay({ error: "replay timed out after 120000 ms" }) }).origin).toBe(
      "timing",
    );
    expect(
      classifyFailure({ replay: replay({ error: "Target page, context or browser has been closed" }) })
        .origin,
    ).toBe("browser_session");
  });

  it("uses the engine's structured category when it exists", () => {
    const failure = classifyFailure({
      replay: replay({ steps: [engineStep({ failureCategory: "selector_not_found" })] }),
    });
    expect(failure.origin).toBe("selector");
    expect(failure.code).toBe("CONTROL_NOT_RESOLVED");
  });

  it("reads a vanished control reported as a geometry-rung refusal as a selector failure", () => {
    const failure = classifyFailure({
      replay: replay({
        haltReason:
          "Step 'step_005' is irreversible but only resolved via the 'geometry' rung — needs human confirmation; refusing to act",
        steps: [engineStep({ error: "only resolved via the 'geometry' rung" })],
      }),
      verification: failedOracle,
    });
    expect(failure.origin).toBe("selector");
    expect(failure.code).toBe("AMBIGUOUS_TARGET");
  });

  it("distinguishes an application rejection from an absent record", () => {
    const failure = classifyFailure({
      replay: replay({
        haltReason:
          "Postconditions failed for step 'step_005': expected screen state not reached (semantic drift)",
        steps: [engineStep({ error: "expected screen state not reached (semantic drift)" })],
      }),
      verification: failedOracle,
    });
    expect(failure.origin).toBe("application");
    expect(failure.code).toBe("APP_STATE_NOT_REACHED");
  });

  it("reports an unreachable oracle as infrastructure, not as a verification failure", () => {
    const failure = classifyFailure({
      replay: replay({ success: true, executionOutcome: "COMPLETED", steps: [engineStep({ ok: true })] }),
      verification: { ...failedOracle, detail: "Could not read the system of record: ECONNREFUSED." },
    });
    expect(failure.origin).toBe("infrastructure");
    expect(failure.code).toBe("ORACLE_UNREACHABLE");
  });

  it("says unknown when the evidence does not establish a cause", () => {
    const failure = classifyFailure({
      replay: replay({ steps: [engineStep({ error: null, failureCategory: null })], haltReason: null }),
    });
    expect(failure.origin).toBe("unknown");
    expect(failure.code).toBe("UNKNOWN");
  });

  it("keeps the raw evidence it used", () => {
    const failure = classifyFailure({
      replay: replay({ haltReason: "engine stopped", stepsTotalMs: 400 }),
      verification: failedOracle,
    });
    expect(failure.evidence["haltReason"]).toBe("engine stopped");
    expect(failure.evidence["verificationDetail"]).toContain("No record in the system of record");
  });

  /* ---------------- P0: safety_halt is not automatically policy --------- */

  it("classifies a write the application rejected as application evidence", () => {
    const failure = classifyFailure({
      replay: replay({
        haltReason:
          "Postconditions failed for step 'step_005' (click 'Save customer'): expected screen state not reached",
        haltObservedTexts: [
          "AcmeDesk CRM",
          "Save failed:Downstreamvalidation rejected this customer",
        ],
        steps: [engineStep({ safetyHalt: true, failureCategory: "safety_halt" })],
      }),
      verification: failedOracle,
    });
    expect(failure.origin).toBe("application");
    expect(failure.code).toBe("APPLICATION_REJECTED");
    expect(failure.detectedBy).toBe("engine");
    expect(failure.stepIndex).toBe(0);
    const evidence = failure.evidence["applicationEvidence"] as any;
    expect(evidence.source).toBe("engine_observed_text");
    expect(evidence.messages[0]).toContain("Save failed");
    // No HTTP status was observed, so none is claimed.
    expect(evidence.httpStatus).toBeNull();
  });

  it("keeps a genuine policy refusal as policy", () => {
    const failure = classifyFailure({
      replay: replay({
        haltReason: "refusing to act: irreversible step without human confirmation",
        haltObservedTexts: ["Save failed: validation rejected"],
        steps: [
          engineStep({
            safetyHalt: true,
            safetyRefusalEvidence: { reason: "risk_review_required", step_id: "step_005" },
          }),
        ],
      }),
    });
    expect(failure.origin).toBe("policy");
    expect(failure.code).toBe("SAFETY_HALT");
    expect(failure.evidence["safetyRefusalEvidence"]).toEqual({
      reason: "risk_review_required",
      step_id: "step_005",
    });
  });

  it("does not sanitize away the verdict but removes the typed values from evidence", () => {
    const failure = classifyFailure({
      replay: replay({
        haltObservedTexts: [
          "Save failed: \"Tailspin Refused\" with ops@tailspin-refused.test already exists",
        ],
        steps: [engineStep({ safetyHalt: true, failureCategory: "safety_halt" })],
      }),
      redact: ["Tailspin Refused", "ops@tailspin-refused.test"],
    });
    expect(failure.origin).toBe("application");
    const messages = (failure.evidence["applicationEvidence"] as any).messages as string[];
    expect(messages.join(" ")).not.toContain("Tailspin Refused");
    expect(messages.join(" ")).not.toContain("ops@tailspin-refused.test");
  });

  it("says unknown when a safety halt carries no evidence at all", () => {
    const failure = classifyFailure({
      replay: replay({ haltObservedTexts: [], steps: [engineStep({ safetyHalt: true })] }),
    });
    expect(failure.origin).toBe("unknown");
    expect(failure.code).toBe("SAFETY_HALT_UNEXPLAINED");
  });
});
