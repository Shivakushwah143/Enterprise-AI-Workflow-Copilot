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
  rungCounts: Record<string, number>;
  healCount: number;
  modelCalls: number;
  totalMs: number;
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
  compile(request: CompileRequest): Promise<EngineCompileResult>;
  replay(request: ReplayRequest): Promise<EngineReplayResult>;
}
