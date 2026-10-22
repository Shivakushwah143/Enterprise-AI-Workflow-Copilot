/**
 * M4 — does reviewed memory change what happens?
 *
 * One controlled A/B comparison, not a benchmark:
 *
 *   setup      record + approve one workflow (one version, shared by both arms);
 *   learning   run once with memory on, hit a UI drift, store the repair as a
 *              candidate, then review it (promotion is never automatic);
 *   compare    N pairs of runs against the same fault and the same starting
 *              record: one arm with `memory: "disabled"`, one with
 *              `memory: "enabled"`. Both arms use the same plan inputs, the same
 *              workflow version, the same model configuration and no AI locator.
 *
 * The comparison fault is a design-system restyle: the save control keeps the id
 * it was given in the previous release (`#save-customer-v2`) but its label is now
 * rendered by CSS, so the DOM has no text while the screen is pixel-identical.
 * The deterministic ladder (recorded selector → role/name → label → text) has
 * nothing left to match; the engine's visual template still resolves it. So the
 * only difference between the arms is whether reviewed memory can name the
 * control. Nothing is switched off in either arm.
 *
 * What is measured per run: verified outcome, wall duration, engine model calls,
 * recovery attempts, human interventions, the failure reason, and which repairs
 * were retrieved / applicable / applied.
 *
 * The result is reported, not assumed. If both arms verify every time, the
 * report says NO MEASURED IMPROVEMENT.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { serve } from "@hono/node-server";
import { KnowledgeEngine, Store, openDb } from "@copilot/knowledge";
import { DEMO_APPS, OpenAdaptEngine } from "@copilot/workflow";
import { loadProjectEnv, type VerificationContract } from "@copilot/shared";

loadProjectEnv();

import { createApp } from "../apps/api/src/app.js";
import { seedDemo } from "../apps/api/src/seed-data.js";
import { startAcmeDesk } from "../apps/demo/src/apps.js";

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const root = path.resolve(process.env.COPILOT_ARTIFACTS ?? ".copilot-data", "m4", stamp);
const apiPort = Number(process.env.M4_API_PORT ?? 4111);
const base = `http://127.0.0.1:${apiPort}`;
const PAIRS = Number(process.env.M4_PAIRS ?? 3);

type MemoryMode = "enabled" | "disabled";

interface RunResult {
  mode: MemoryMode;
  pair: number;
  order: 1 | 2;
  customer: string;
  outcome: string | null;
  verified: boolean;
  durationMs: number;
  modelCalls: number;
  recoveryAttempts: number;
  humanInterventions: number;
  failure: { origin: string; code: string; detail: string } | null;
  repairRetrieved: string[];
  repairApplied: string[];
  repairConfirmed: string[];
  driftStepSource: string | null;
  driftStepRepairId: string | null;
  tableDurationMs: number | null;
}

async function api<T = any>(
  method: string,
  route: string,
  options: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const response = await fetch(`${base}${route}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<number> {
  await rm(root, { recursive: true, force: true });
  await mkdir(path.join(root, "demo"), { recursive: true });
  if (!process.env.PYTHON_BIN) {
    process.env.PYTHON_BIN = path.resolve(
      process.platform === "win32" ? ".venv-flow/Scripts/python.exe" : ".venv-flow/bin/python",
    );
  }

  const demo = DEMO_APPS[0]!;
  const demoApp = await startAcmeDesk({
    port: Number(new URL(demo.baseUrl).port),
    dataDir: path.join(root, "demo"),
  });
  const sql = await openDb({ dataDir: path.join(root, "pg") });
  const store = new Store(sql);
  const knowledge = new KnowledgeEngine(store);
  const engine = new OpenAdaptEngine();
  const app = createApp({ store, engine, knowledge, artifactRoot: root });
  const server = serve({ fetch: app.fetch, port: apiPort });
  await sleep(250);

  const note = (line: string): void => console.log(line);

  try {
    const world = await seedDemo(store, knowledge);
    const admin = await api<{ token: string }>("POST", "/api/auth/login", {
      body: { tenantSlug: "acme-demo", email: world.users.admin },
    });
    const employee = await api<{ token: string }>("POST", "/api/auth/login", {
      body: { tenantSlug: "acme-demo", email: world.users.employee },
    });
    const adminToken = admin.body.token;
    const employeeToken = employee.body.token;
    const application = world.applications[0]!.application;

    /* ---------------- setup: one recording, one approved workflow --------- */

    const recording = await api<any>("POST", "/api/recordings", {
      token: adminToken,
      body: { applicationId: application.id, mode: "scripted" },
    });
    let compiled: any = null;
    const deadline = Date.now() + 8 * 60_000;
    while (Date.now() < deadline) {
      const poll = await api<any>("GET", `/api/recordings/${recording.body.id}`, {
        token: adminToken,
      });
      if (poll.body?.recording?.status && poll.body.recording.status !== "recording") {
        compiled = poll.body;
        break;
      }
      await sleep(1_000);
    }
    if (!compiled?.workflow) {
      console.error(`SETUP FAILED: recording status=${compiled?.recording?.status}`);
      return 1;
    }

    const verification: VerificationContract = {
      kind: "http",
      tier: "system_of_record",
      url: demo.verification.url,
      recordPath: demo.verification.recordPath,
      expect: demo.verification.expect,
      match: demo.verification.match,
    };
    const approval = await api<any>("POST", `/api/workflows/${compiled.workflow.id}/approve`, {
      token: adminToken,
      body: {
        name: demo.workflowName,
        description: demo.description,
        triggeredBy: demo.triggers,
        verification,
        acknowledgeRisk: true,
      },
    });
    if (approval.status !== 201) {
      console.error(`SETUP FAILED: approval HTTP ${approval.status}`);
      return 1;
    }
    const skillId = approval.body?.skill?.id;
    if (!skillId) {
      console.error("SETUP FAILED: no skill id");
      return 1;
    }
    note(`setup: workflow ${compiled.workflow.id} version ${approval.body?.skill?.version ?? "?"}, fault "renamed-selector"`);

    const setFault = (mode: string): Promise<Response> =>
      fetch(`${demoApp.url}/api/faults`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode }),
      });
    // The recurring problem both arms face: the restyled control.
    const COMPARISON_FAULT = "css-label-selector";
    const reset = async (): Promise<void> => {
      await fetch(`${demoApp.url}/api/reset`, { method: "POST" });
      await setFault(COMPARISON_FAULT);
    };

    const execute = async (
      customer: string,
      email: string,
      mode: MemoryMode,
    ): Promise<any> => {
      const plan = await api<any>("POST", "/api/plans", {
        token: employeeToken,
        body: { intent: `Create a customer named "${customer}" with contact ${email}` },
      });
      const run = await api<any>("POST", "/api/executions", {
        token: employeeToken,
        body: {
          planId: plan.body?.plan?.id,
          inputs: {},
          approved: true,
          allowAiLocator: false,
          memory: mode,
        },
      });
      return run.body;
    };

    /* ---------------- learning: discovery once, then review -------------- */

    // The first release of the change: only the id moved, so the deterministic
    // ladder can still re-identify the control by its label.
    await fetch(`${demoApp.url}/api/reset`, { method: "POST" });
    await setFault("renamed-selector");
    const learning = await execute("Memory Learning", "learning@acme.test", "enabled");
    if (learning?.outcome !== "VERIFIED") {
      console.error(`LEARNING FAILED: outcome=${learning?.outcome} ${learning?.message ?? ""}`);
      return 1;
    }
    const candidates = await api<any>("GET", "/api/repairs?status=candidate", {
      token: adminToken,
    });
    const repair = (candidates.body?.items ?? []).find((row: any) => row.action?.stepIndex === 5);
    if (!repair) {
      console.error("LEARNING FAILED: no repair candidate was stored");
      return 1;
    }
    const review = await api<any>("POST", `/api/repairs/${repair.id}/review`, {
      token: adminToken,
      body: { status: "approved" },
    });
    if (review.status !== 200) {
      console.error(`LEARNING FAILED: review HTTP ${review.status}`);
      return 1;
    }
    note(
      `memory: repair ${repair.id} — step ${repair.action.stepIndex + 1}, ${repair.action.fromSelector} → ${repair.action.toSelector}, approved by the admin`,
    );
    note(`comparison fault: ${COMPARISON_FAULT} (id kept, label moved to CSS)`);

    /* ---------------- comparison ----------------------------------------- */

    const runs: RunResult[] = [];
    for (let pair = 1; pair <= PAIRS; pair += 1) {
      const customer = `Memory Pair ${pair}`;
      const email = `pair${pair}@acme.test`;
      // Order alternates so a warm cache or a cold start cannot be mistaken
      // for a memory effect.
      const order: MemoryMode[] = pair % 2 === 1 ? ["disabled", "enabled"] : ["enabled", "disabled"];
      for (const [index, mode] of order.entries()) {
        await reset();
        const started = Date.now();
        const execution = await execute(customer, email, mode);
        const wall = Date.now() - started;
        const drift = (execution?.steps ?? []).find((step: any) => step.index === 5) ?? null;
        runs.push({
          mode,
          pair,
          order: (index + 1) as 1 | 2,
          customer,
          outcome: execution?.outcome ?? null,
          verified: execution?.outcome === "VERIFIED",
          durationMs: wall,
          modelCalls: execution?.modelCalls ?? 0,
          recoveryAttempts: execution?.recovery?.attempts?.length ?? 0,
          humanInterventions: 0,
          failure: execution?.failure
            ? {
                origin: execution.failure.origin,
                code: execution.failure.code,
                detail: execution.failure.detail,
              }
            : null,
          repairRetrieved: (execution?.memory?.retrieved ?? []).map((row: any) => row.repairId),
          repairApplied: execution?.memory?.appliedRepairIds ?? [],
          repairConfirmed: execution?.memory?.confirmedRepairIds ?? [],
          driftStepSource: drift?.resolutionSource ?? null,
          driftStepRepairId: drift?.repairId ?? null,
          tableDurationMs: execution?.timings?.totalMs ?? null,
        });
        const row = runs.at(-1)!;
        note(
          `pair ${pair} ${mode.padEnd(8)} order ${row.order} → ${row.outcome} ` +
            `(${row.durationMs}ms) step6=${row.driftStepSource}` +
            `${row.repairApplied.length ? ` repair=${row.repairApplied[0]}` : ""}` +
            `${row.failure ? ` failure=${row.failure.origin}/${row.failure.code}` : ""}`,
        );
      }
    }

    const summary = (mode: MemoryMode) => {
      const rows = runs.filter((row) => row.mode === mode);
      const verified = rows.filter((row) => row.verified).length;
      const durations = rows.map((row) => row.durationMs).sort((a, b) => a - b);
      const median = durations.length
        ? durations[Math.floor(durations.length / 2)]!
        : 0;
      return {
        mode,
        runs: rows.length,
        verified,
        verifiedRate: rows.length ? verified / rows.length : 0,
        medianDurationMs: median,
        modelCalls: rows.reduce((sum, row) => sum + row.modelCalls, 0),
        recoveryAttempts: rows.reduce((sum, row) => sum + row.recoveryAttempts, 0),
        humanInterventions: rows.reduce((sum, row) => sum + row.humanInterventions, 0),
        repairsRetrieved: rows.reduce((sum, row) => sum + row.repairRetrieved.length, 0),
        repairsApplied: rows.reduce((sum, row) => sum + row.repairApplied.length, 0),
        failures: rows.filter((row) => row.failure).map((row) => row.failure),
      };
    };

    const disabled = summary("disabled");
    const enabled = summary("enabled");
    const improvement =
      enabled.verifiedRate > disabled.verifiedRate
        ? "MEMORY IMPROVED VERIFIED COMPLETION"
        : "NO MEASURED IMPROVEMENT";

    const report = {
      at: new Date().toISOString(),
      scenario:
        "design-system restyle on an irreversible save control: id kept, label rendered by CSS (no DOM text)",
      comparisonFault: COMPARISON_FAULT,
      workflow: { id: compiled.workflow.id, version: approval.body?.skill?.version ?? null },
      repair: {
        id: repair.id,
        stepIndex: repair.action.stepIndex,
        fromSelector: repair.action.fromSelector,
        toSelector: repair.action.toSelector,
        status: review.body?.repair?.status ?? null,
      },
      pairs: PAIRS,
      disabled,
      enabled,
      verdict: improvement,
      runs,
      artifacts: root,
    };
    await writeFile(path.join(root, "m4-memory-ab.json"), JSON.stringify(report, null, 2), "utf8");

    note("");
    note("| metric | memory_disabled | memory_enabled |");
    note("| --- | --- | --- |");
    note(`| verified | ${disabled.verified}/${disabled.runs} | ${enabled.verified}/${enabled.runs} |`);
    note(
      `| median duration | ${disabled.medianDurationMs}ms | ${enabled.medianDurationMs}ms |`,
    );
    note(`| model calls | ${disabled.modelCalls} | ${enabled.modelCalls} |`);
    note(`| recovery attempts | ${disabled.recoveryAttempts} | ${enabled.recoveryAttempts} |`);
    note(
      `| repairs retrieved / applied | ${disabled.repairsRetrieved} / ${disabled.repairsApplied} | ${enabled.repairsRetrieved} / ${enabled.repairsApplied} |`,
    );
    note(`| human interventions | ${disabled.humanInterventions} | ${enabled.humanInterventions} |`);
    note(`| failures | ${disabled.failures.map((f: any) => `${f?.origin}/${f?.code}`).join(", ") || "none"} | ${enabled.failures.map((f: any) => `${f?.origin}/${f?.code}`).join(", ") || "none"} |`);
    note("");
    note(`VERDICT: ${improvement}`);
    note(`report: ${path.join(root, "m4-memory-ab.json")}`);

    const brokenHarness = runs.every((row) => row.outcome === null);
    return brokenHarness ? 1 : 0;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await sql.close();
    await demoApp.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`M4 ERROR: ${error instanceof Error ? error.stack : String(error)}`);
    process.exit(1);
  });
