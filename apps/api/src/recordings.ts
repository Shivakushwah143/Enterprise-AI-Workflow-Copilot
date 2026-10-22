/**
 * Recording lifecycle: record -> compile -> ingest into the knowledge layer.
 *
 * Two drivers, same artifacts:
 *   - `interactive`: a headed browser is opened for the admin, who performs the
 *     workflow; recording stops when the admin asks it to. This is the real
 *     "learn my app" path.
 *   - `scripted`: the application's built-in demonstration runs unattended
 *     (useful for the demo apps and for CI).
 *
 * A recording is always explicit, always attributed to a user, and always
 * leaves a row behind (including failures) so "Start Recording" can never look
 * like it silently did nothing. Compilation produces a DRAFT workflow: nothing
 * becomes executable until an admin approves it.
 */
import path from "node:path";
import { CopilotError, type RecordingMode, type Workflow } from "@copilot/shared";
import type { RecordingRow, Store } from "@copilot/knowledge";
import {
  demoAppByUrl,
  inspectBundle,
  type InteractiveRecordingSession,
  type WorkflowEngine,
} from "@copilot/workflow";
import type { Logger } from "./log.js";

export interface RecordingDeps {
  store: Store;
  engine: WorkflowEngine;
  artifactRoot: string;
  log: Logger;
}

export interface StartRecordingInput {
  tenantId: string;
  userId: string;
  applicationId: string;
  mode: RecordingMode;
  workflowName?: string | undefined;
  paramFields?: string[] | undefined;
  secretFields?: string[] | undefined;
}

/**
 * Interactive sessions that are currently recording. In-process on purpose:
 * the browser process belongs to this API process, so a restart cannot resume
 * it. A stop request for an unknown id is reported as a conflict, not success.
 */
const interactiveSessions = new Map<string, InteractiveRecordingSession>();

/**
 * Recordings the admin cancelled. The recorder may still flush a partial
 * artifact when its browser closes; this set makes the lifecycle verdict
 * "cancelled" instead of letting a cancelled session compile into a skill.
 */
const cancelledRecordings = new Set<string>();

export function isRecordingInProgress(recordingId: string): boolean {
  return interactiveSessions.has(recordingId);
}

export function interactiveCommand(applicationUrl: string): string {
  return [
    "openadapt-flow record",
    "--backend web",
    `--url ${applicationUrl}`,
    "--out .copilot-data/interactive-recording",
  ].join(" ");
}

interface Job {
  recording: RecordingRow;
  recordingDir: string;
  applicationUrl: string;
  applicationId: string;
  workflowName: string;
  tenantId: string;
}

export async function startRecording(
  deps: RecordingDeps,
  input: StartRecordingInput,
): Promise<RecordingRow> {
  const application = await deps.store.getApplication(input.tenantId, input.applicationId);
  if (!application) {
    throw new CopilotError("not_found", "Application not found in this tenant.", 404);
  }
  const demo = demoAppByUrl(application.baseUrl);

  if (input.mode === "scripted" && !demo) {
    throw new CopilotError(
      "capability_unavailable",
      "No demonstration script exists for this application. Record it interactively instead.",
      501,
    );
  }
  if (input.mode === "interactive" && application.kind !== "browser") {
    throw new CopilotError(
      "capability_unavailable",
      "Interactive browser recording needs a browser application.",
      501,
    );
  }

  const recording = await deps.store.createRecording({
    tenantId: input.tenantId,
    applicationId: application.id,
    mode: input.mode,
    directory: path.join(deps.artifactRoot, "recordings", "pending"),
    createdBy: input.userId,
  });
  const recordingDir = path.join(deps.artifactRoot, "recordings", recording.id);
  await deps.store.sql.query(
    "UPDATE recordings SET directory = $3 WHERE tenant_id = $1 AND id = $2",
    [input.tenantId, recording.id, recordingDir],
  );

  const job: Job = {
    recording: { ...recording, directory: recordingDir },
    recordingDir,
    applicationUrl: application.baseUrl,
    applicationId: application.id,
    workflowName: input.workflowName ?? demo?.workflowName ?? `${application.name} workflow`,
    tenantId: input.tenantId,
  };

  if (input.mode === "interactive") {
    // Defaults come from the demonstration fixture when the admin did not name
    // the fields: those are the fields the bundled demo types into.
    const paramFields = input.paramFields?.length
      ? input.paramFields
      : (demo?.params.filter((p) => !p.secret).map((p) => p.name) ?? []);
    const secretFields = input.secretFields?.length
      ? input.secretFields
      : (demo?.params.filter((p) => p.secret).map((p) => p.name) ?? []);

    const session = await deps.engine.recordInteractive({
      url: application.baseUrl,
      outDir: recordingDir,
      paramFields,
      secretFields,
    });
    interactiveSessions.set(recording.id, session);
    deps.log({
      event: "recording.interactive_started",
      recordingId: recording.id,
      applicationId: application.id,
      paramFields,
      secretFields,
    });
    void finishInteractive(deps, job, session);
    return job.recording;
  }

  void runScripted(deps, job, demo!.key);
  return job.recording;
}

/**
 * Abandon an interactive recording. The browser is closed, nothing is compiled,
 * and the row records the cancellation so a half-demonstration cannot become a
 * skill. Only a live session can be cancelled; anything else is a conflict.
 */
export async function cancelInteractiveRecording(
  deps: RecordingDeps,
  tenantId: string,
  recordingId: string,
): Promise<RecordingRow> {
  const recording = await deps.store.getRecording(tenantId, recordingId);
  if (!recording) throw new CopilotError("not_found", "Recording not found.", 404);
  if (recording.status !== "recording") {
    throw new CopilotError("conflict", `Recording is already ${recording.status}.`, 409);
  }
  const session = interactiveSessions.get(recordingId);
  if (!session) {
    throw new CopilotError(
      "conflict",
      "This recording is no longer attached to a live browser session, so it cannot be cancelled.",
      409,
    );
  }
  cancelledRecordings.add(recordingId);
  await session.stop();
  await deps.store.updateRecording(tenantId, recordingId, {
    status: "cancelled",
    error: "Cancelled by the administrator. Nothing was compiled.",
    finishedAt: new Date().toISOString(),
  });
  deps.log({ event: "recording.cancelled", recordingId });
  return (await deps.store.getRecording(tenantId, recordingId))!;
}

/**
 * Ask an in-progress interactive recording to finish. The browser flushes its
 * events and the recording is compiled; the caller polls `/recordings/:id`.
 */
export async function stopInteractiveRecording(
  deps: RecordingDeps,
  tenantId: string,
  recordingId: string,
): Promise<RecordingRow> {
  const recording = await deps.store.getRecording(tenantId, recordingId);
  if (!recording) throw new CopilotError("not_found", "Recording not found.", 404);
  const session = interactiveSessions.get(recordingId);
  if (!session) {
    throw new CopilotError(
      "conflict",
      recording.status === "recording"
        ? "This recording is no longer attached to a live browser session."
        : `Recording is already ${recording.status}.`,
      409,
    );
  }
  await session.stop();
  deps.log({ event: "recording.interactive_stop_requested", recordingId });
  return recording;
}

async function finishInteractive(
  deps: RecordingDeps,
  job: Job,
  session: InteractiveRecordingSession,
): Promise<void> {
  try {
    const recorded = await session.result;
    // Cancellation is decided by the admin's request, not by whether the
    // recorder happened to flush something on its way out.
    if (cancelledRecordings.has(job.recording.id)) return;
    if (!recorded.ok) {
      throw new Error(recorded.error ?? "the interactive recording failed");
    }
    deps.log({
      event: "recording.captured",
      recordingId: job.recording.id,
      mode: "interactive",
      events: recorded.events,
      frames: recorded.frames,
    });
    if (recorded.events === 0) {
      throw new Error(
        "The demonstration contained no recorded actions. Nothing was compiled; record again and perform the workflow in the browser.",
      );
    }
    await compileAndIngest(deps, {
      ...job,
      workflowName: job.workflowName,
    });
  } catch (error) {
    await fail(deps, job, error);
  } finally {
    interactiveSessions.delete(job.recording.id);
    cancelledRecordings.delete(job.recording.id);
  }
}

async function runScripted(deps: RecordingDeps, job: Job, appKey: string): Promise<void> {
  try {
    const recorded = await deps.engine.recordScripted({
      appKey,
      url: job.applicationUrl,
      outDir: job.recordingDir,
    });
    if (!recorded.ok) {
      throw new Error(recorded.error ?? "recording failed");
    }
    deps.log({
      event: "recording.captured",
      recordingId: job.recording.id,
      mode: "scripted",
      events: recorded.events,
      frames: recorded.frames,
    });
    await compileAndIngest(deps, job);
  } catch (error) {
    await fail(deps, job, error);
  }
}

/** Compile a finished recording and ingest the resulting draft workflow. */
async function compileAndIngest(deps: RecordingDeps, job: Job): Promise<void> {
  const { store, engine, log } = deps;
  const { recording, recordingDir, tenantId } = job;

  const bundleDir = path.join(path.dirname(recordingDir), `${recording.id}-bundle`);
  const compiled = await engine.compile({
    recordingDir,
    bundleDir,
    name: job.workflowName,
  });
  if (!compiled.ok) {
    throw new Error(compiled.error ?? "compile failed");
  }

  const inspected = await inspectBundle(bundleDir);
  const workflow: Workflow = await store.createWorkflow({
    tenantId,
    applicationId: job.applicationId,
    name: inspected.name || job.workflowName,
    description: `Learned from a demonstration of ${job.applicationUrl}.`,
    bundlePath: bundleDir,
    recordingId: recording.id,
    steps: inspected.steps,
    uncertainty: inspected.uncertainty,
  });

  // Populate the semantic model: page + identified elements.
  const pageId = await store.upsertPage(tenantId, job.applicationId, "/", job.workflowName);
  for (const step of inspected.steps) {
    if (!step.selector && !step.elementName) continue;
    await store.upsertElement({
      tenantId,
      applicationId: job.applicationId,
      pageId,
      semanticName:
        step.elementName ?? step.fieldLabel ?? step.intent ?? `element-${step.index}`,
      elementRole: step.elementRole,
      selector: step.selector,
      label: step.fieldLabel ?? step.ocrText,
      state: { action: step.action, risk: step.risk },
      confidence: step.confidence,
    });
  }

  await store.updateRecording(tenantId, recording.id, {
    status: "compiled",
    workflowId: workflow.id,
    finishedAt: new Date().toISOString(),
  });
  log({
    event: "workflow.draft_created",
    workflowId: workflow.id,
    recordingId: recording.id,
    mode: recording.mode,
    steps: workflow.steps.length,
    uncertain: inspected.uncertainty.length,
  });
}

async function fail(deps: RecordingDeps, job: Job, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : "unknown recording error";
  await deps.store.updateRecording(job.tenantId, job.recording.id, {
    status: "failed",
    error: message.slice(0, 2000),
    finishedAt: new Date().toISOString(),
  });
  deps.log({
    event: "recording.failed",
    recordingId: job.recording.id,
    mode: job.recording.mode,
    error: message,
  });
}
