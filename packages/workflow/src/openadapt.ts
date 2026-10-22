/**
 * OpenAdapt adapter (subprocess bridge).
 *
 * The bridge (`packages/workflow/python/copilot_bridge.py`) is the only place
 * that imports `openadapt_flow`. It prints one JSON line, prefixed so engine
 * logging can never be mistaken for our result.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CompileRequest,
  EngineCompileResult,
  EngineProbe,
  EngineRecordingResult,
  EngineReplayResult,
  RecordRequest,
  ReplayRequest,
  WorkflowEngine,
} from "./types.js";

const MARKER = "__COPILOT_JSON__";
const HERE = path.dirname(fileURLToPath(import.meta.url));

export function defaultPythonBin(): string {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  const root = process.cwd();
  const candidates =
    process.platform === "win32"
      ? [".venv-flow/Scripts/python.exe", ".venv/Scripts/python.exe"]
      : [".venv-flow/bin/python", ".venv/bin/python"];
  for (const candidate of candidates) {
    const full = path.resolve(root, candidate);
    if (existsSync(full)) return full;
  }
  return process.platform === "win32" ? "python" : "python3";
}

export function bridgePath(): string {
  if (process.env.OPENADAPT_BRIDGE) return process.env.OPENADAPT_BRIDGE;
  // packages/workflow/src -> packages/workflow/python
  return path.resolve(HERE, "..", "python", "copilot_bridge.py");
}

interface BridgeOutput {
  payload: Record<string, unknown> | null;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

function runBridge(
  args: string[],
  timeoutMs: number,
): Promise<BridgeOutput> {
  return new Promise((resolve) => {
    const python = defaultPythonBin();
    const child = spawn(python, [bridgePath(), ...args], {
      cwd: process.cwd(),
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        payload: null,
        stdout,
        stderr: `${stderr}\n${error.message}`,
        exitCode: null,
        timedOut,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const line = stdout
        .split(/\r?\n/)
        .reverse()
        .find((l) => l.startsWith(MARKER));
      let payload: Record<string, unknown> | null = null;
      if (line) {
        try {
          payload = JSON.parse(line.slice(MARKER.length)) as Record<string, unknown>;
        } catch {
          payload = null;
        }
      }
      resolve({ payload, stdout, stderr, exitCode: code, timedOut });
    });
  });
}

/** Last few lines of engine output, for an honest error message. */
function tail(output: BridgeOutput, lines = 6): string {
  const text = `${output.stderr}\n${output.stdout}`.trim();
  return text.split(/\r?\n/).slice(-lines).join(" | ");
}

export class OpenAdaptEngine implements WorkflowEngine {
  readonly kind = "openadapt-flow";

  async probe(): Promise<EngineProbe> {
    const out = await runBridge(["probe"], 120_000);
    const payload = out.payload ?? {};
    const modules = Object.fromEntries(
      Object.entries(payload).filter(([, value]) => typeof value === "boolean"),
    ) as Record<string, boolean>;
    return {
      ok: Boolean(payload["ok"]),
      python: payload["python"] as string | undefined,
      engine: payload["engine"] as EngineProbe["engine"],
      chromiumInstalled: payload["chromium_installed"] as boolean | undefined,
      modules,
      error: payload["error"] as string | undefined,
    };
  }

  async recordScripted(request: RecordRequest): Promise<EngineRecordingResult> {
    const args = [
      "record-scripted",
      "--url",
      request.url,
      "--out",
      request.outDir,
      "--app",
      request.appKey,
    ];
    for (const [key, value] of Object.entries(request.params ?? {})) {
      args.push("--param", `${key}=${value}`);
    }
    if (request.headed) args.push("--headed");

    const out = await runBridge(args, 10 * 60_000);
    const payload = out.payload ?? {};
    return {
      ok: Boolean(payload["ok"]),
      recordingDir: String(payload["recording_dir"] ?? request.outDir),
      title: payload["title"] as string | undefined,
      events: Number(payload["events"] ?? 0),
      frames: Number(payload["frames"] ?? 0),
      error:
        (payload["error"] as string | undefined) ??
        (payload["ok"] ? undefined : `bridge failed: ${tail(out)}`),
    };
  }

  async compile(request: CompileRequest): Promise<EngineCompileResult> {
    const args = [
      "compile",
      "--recording",
      request.recordingDir,
      "--out",
      request.bundleDir,
      "--name",
      request.name,
    ];
    if (request.acceptParams && request.acceptParams.length > 0) {
      args.push("--accept-params", request.acceptParams.join(","));
    }
    const out = await runBridge(args, 10 * 60_000);
    const payload = out.payload ?? {};
    return {
      ok: Boolean(payload["ok"]),
      bundleDir: String(payload["bundle_dir"] ?? request.bundleDir),
      workflowJson: (payload["workflow_json"] as string | null) ?? null,
      error: payload["ok"] ? undefined : `compile failed: ${tail(out)}`,
    };
  }

  async replay(request: ReplayRequest): Promise<EngineReplayResult> {
    const args = [
      "replay",
      "--bundle",
      request.bundleDir,
      "--url",
      request.url,
      "--run-dir",
      request.runDir,
    ];
    for (const [key, value] of Object.entries(request.params)) {
      args.push("--param", `${key}=${value}`);
    }
    if (request.headed) args.push("--headed");

    const out = await runBridge(args, request.timeoutMs ?? 5 * 60_000);
    const payload = out.payload ?? {};
    const steps = Array.isArray(payload["results"])
      ? (payload["results"] as Record<string, unknown>[]).map((r) => ({
          index: Number(r["index"] ?? 0),
          stepId: (r["step_id"] as string | null) ?? null,
          intent: String(r["intent"] ?? ""),
          ok: Boolean(r["ok"]),
          skipped: Boolean(r["skipped"]),
          rung: (r["rung"] as string | null) ?? null,
          postconditionsOk: (r["postconditions_ok"] as boolean | null) ?? null,
          identityOk: (r["identity_ok"] as boolean | null) ?? null,
          risk: (r["risk"] as string | null) ?? null,
          error: (r["error"] as string | null) ?? null,
        }))
      : [];

    return {
      ok: Boolean(payload["ok"]),
      reportPath: (payload["report_path"] as string | null) ?? null,
      success: Boolean(payload["success"]),
      executionOutcome: (payload["execution_outcome"] as string | null) ?? null,
      transactionOutcome: (payload["transaction_outcome"] as string | null) ?? null,
      haltReason: (payload["halt_reason"] as string | null) ?? null,
      haltIntent: (payload["halt_intent"] as string | null) ?? null,
      rungCounts: (payload["rung_counts"] as Record<string, number>) ?? {},
      healCount: Number(payload["heal_count"] ?? 0),
      modelCalls: Number(payload["model_calls"] ?? 0),
      totalMs: Number(payload["total_ms"] ?? 0),
      steps,
      error: payload["ok"]
        ? undefined
        : ((payload["error"] as string | undefined) ??
          (out.timedOut ? "engine timed out" : `replay failed: ${tail(out)}`)),
    };
  }
}
