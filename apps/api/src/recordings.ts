/**
 * Recording lifecycle: record -> compile -> ingest into the knowledge layer.
 *
 * A recording is always explicit, always attributed to a user, and always
 * leaves a row behind (including failures) so "Start Recording" can never look
 * like it silently did nothing. Compilation produces a DRAFT workflow: nothing
 * becomes executable until an admin approves it.
 */
import path from "node:path";
import { CopilotError, type RecordingMode, type Workflow } from "@copilot/shared";
import type { RecordingRow, Store } from "@copilot/knowledge";
import { demoAppByUrl, inspectBundle, type WorkflowEngine } from "@copilot/workflow";
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
}

export function interactiveCommand(applicationUrl: string): string {
  return [
    "openadapt-flow record",
    "--backend web",
    `--url ${applicationUrl}`,
    "--out .copilot-data/interactive-recording",
  ].join(" ");
}

export async function startRecording(
  deps: RecordingDeps,
  input: StartRecordingInput,
): Promise<RecordingRow> {
  const application = await deps.store.getApplication(input.tenantId, input.applicationId);
  if (!application) {
    throw new CopilotError("not_found", "Application not found in this tenant.", 404);
  }

  if (input.mode === "interactive") {
    // We do not fake a human: the interactive recorder needs someone to drive a
    // headed browser. The command is returned so the operator can run it.
    throw new CopilotError(
      "capability_unavailable",
      `Interactive recording requires a human at a headed browser. Run: ${interactiveCommand(
        application.baseUrl,
      )} (OpenAdapt's interactive recorder writes the same recording directory this API ingests).`,
      501,
      { command: interactiveCommand(application.baseUrl) },
    );
  }

  const demo = demoAppByUrl(application.baseUrl);
  if (!demo) {
    throw new CopilotError(
      "capability_unavailable",
      "No demonstration script exists for this application. Add one to packages/workflow/python/copilot_bridge.py, or record it interactively.",
      501,
    );
  }

  const recording = await deps.store.createRecording({
    tenantId: input.tenantId,
    applicationId: application.id,
    mode: "scripted",
    directory: path.join(deps.artifactRoot, "recordings", "pending"),
    createdBy: input.userId,
  });
  // Point the row at its real directory as soon as the id exists.
  const recordingDir = path.join(deps.artifactRoot, "recordings", recording.id);
  await deps.store.sql.query(
    "UPDATE recordings SET directory = $3 WHERE tenant_id = $1 AND id = $2",
    [input.tenantId, recording.id, recordingDir],
  );

  void run(deps, {
    recording,
    recordingDir,
    applicationUrl: application.baseUrl,
    applicationId: application.id,
    appKey: demo.key,
    workflowName: input.workflowName ?? demo.workflowName,
    tenantId: input.tenantId,
  });

  return { ...recording, directory: recordingDir };
}

async function run(
  deps: RecordingDeps,
  job: {
    recording: RecordingRow;
    recordingDir: string;
    applicationUrl: string;
    applicationId: string;
    appKey: string;
    workflowName: string;
    tenantId: string;
  },
): Promise<void> {
  const { store, engine, log } = deps;
  const { recording, recordingDir, tenantId } = job;
  try {
    const recorded = await engine.recordScripted({
      appKey: job.appKey,
      url: job.applicationUrl,
      outDir: recordingDir,
    });
    if (!recorded.ok) {
      throw new Error(recorded.error ?? "recording failed");
    }
    log({
      event: "recording.captured",
      recordingId: recording.id,
      events: recorded.events,
      frames: recorded.frames,
    });

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
      steps: workflow.steps.length,
      uncertain: inspected.uncertainty.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown recording error";
    await store.updateRecording(tenantId, recording.id, {
      status: "failed",
      error: message.slice(0, 2000),
      finishedAt: new Date().toISOString(),
    });
    log({ event: "recording.failed", recordingId: recording.id, error: message });
  }
}
