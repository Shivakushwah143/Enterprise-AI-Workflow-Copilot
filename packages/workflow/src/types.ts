/**
 * The seam between the copilot and whatever executes workflows.
 *
 * `OpenAdaptEngine` is today's implementation (a subprocess bridge to
 * `openadapt_flow`). Nothing above this interface imports OpenAdapt, so the
 * engine can be swapped, upgraded, or run on another host.
 */

export interface EngineProbe {
  ok: boolean;
  python?: string;
  engine?: { name: string; version: string; path: string };
  chromiumInstalled?: boolean;
  modules?: Record<string, boolean>;
  error?: string;
}

export interface EngineRecordingResult {
  ok: boolean;
  recordingDir: string;
  title?: string;
  events: number;
  frames: number;
  error?: string;
}

export interface EngineCompileResult {
  ok: boolean;
  bundleDir: string;
  workflowJson: string | null;
  error?: string;
}

export interface EngineStepResult {
  index: number;
  stepId: string | null;
  intent: string;
  ok: boolean;
  skipped: boolean;
  rung: string | null;
  postconditionsOk: boolean | null;
  identityOk: boolean | null;
  risk: string | null;
  error: string | null;
  /** Engine-measured step time, when the report carries it. */
  durationMs: number | null;
  /** Engine's own check that a typed value landed in the field. */
  inputVerified: boolean | null;
  /** Value the engine read back from the field, when it reports one. */
  fieldRead: string | null;
  /** Engine's structured failure category for this step, if any. */
  failureCategory: string | null;
  /** The engine stopped this step for safety rather than clocking a failure. */
  safetyHalt?: boolean | undefined;
  /** The engine's own evidence for that refusal, when it recorded any. */
  safetyRefusalEvidence?: unknown;
  /** Engine's own effect check, when the step was expected to have an effect. */
  effectVerified?: boolean | null | undefined;
}

export interface EngineReplayResult {
  ok: boolean;
  reportPath: string | null;
  /** Engine's own verdict. One witness — never the only one. */
  success: boolean;
  executionOutcome: string | null;
  transactionOutcome: string | null;
  haltReason: string | null;
  haltIntent: string | null;
  /**
   * Text the application displayed when the run stopped. Application-level
   * evidence only (never a response body), used to tell "the app rejected this"
   * apart from "policy refused this".
   */
  haltObservedTexts?: string[] | undefined;
  rungCounts: Record<string, number>;
  healCount: number;
  modelCalls: number;
  totalMs: number;
  /** Sum of the engine's own per-step times. */
  stepsTotalMs: number;
  /** total_ms minus the step times: launch, teardown, engine bookkeeping. */
  engineOverheadMs: number;
  steps: EngineStepResult[];
  error?: string;
}

export interface RecordRequest {
  appKey: string;
  url: string;
  outDir: string;
  params?: Record<string, string>;
  headed?: boolean;
}

/**
 * A human-driven recording. The engine opens a headed browser and keeps
 * recording until `stop()` is called; the browser is the one the person uses.
 */
export interface InteractiveRecordRequest {
  url: string;
  outDir: string;
  /** Field names whose typed values become replay parameters. */
  paramFields?: string[];
  /** Field names whose values must never be persisted. */
  secretFields?: string[];
  /**
   * Optional built-in demonstration. When set, the engine drives its own
   * browser for testing the pipeline; this is NOT a human recording and the
   * result says so.
   */
  demoKey?: string;
  timeoutMs?: number;
}

export interface InteractiveRecordingSession {
  /** Resolves when the recorder has flushed and written the recording. */
  result: Promise<EngineRecordingResult>;
  /** Ask the recorder to finish now. Idempotent. */
  stop(): Promise<void>;
}

export interface CompileRequest {
  recordingDir: string;
  bundleDir: string;
  name: string;
  acceptParams?: string[];
}

export interface ReplayRequest {
  bundleDir: string;
  url: string;
  runDir: string;
  params: Record<string, string>;
  headed?: boolean;
  timeoutMs?: number;
}

export interface WorkflowEngine {
  readonly kind: string;
  probe(): Promise<EngineProbe>;
  recordScripted(request: RecordRequest): Promise<EngineRecordingResult>;
  recordInteractive(
    request: InteractiveRecordRequest,
  ): Promise<InteractiveRecordingSession>;
  compile(request: CompileRequest): Promise<EngineCompileResult>;
  replay(request: ReplayRequest): Promise<EngineReplayResult>;
}
