/**
 * Targeted smoke test for M1 + M2 + M3 (three executions, not a benchmark).
 *
 *   1. a normal run with new data: verified, timed, field-checked;
 *   2. a recoverable UI change: control re-discovered, verified, repair stored
 *      as a candidate, reviewed, then re-used on the next run;
 *   3. a rejected write: FAILED with a structured origin, and no false success.
 *
 * Uses the disposable demo application and an embedded database. Prints one
 * PASS/FAIL line per assertion and exits non-zero if any fail.
 */
import { mkdir, rm } from "node:fs/promises";
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
const root = path.resolve(process.env.COPILOT_ARTIFACTS ?? ".copilot-data", "m1m2m3", stamp);
const apiPort = Number(process.env.M0_API_PORT ?? 4110);
const base = `http://127.0.0.1:${apiPort}`;

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${detail}` : ""}`);
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
  await sleep(200);

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
    const recording = await api<any>("POST", "/api/recordings", {
      token: adminToken,
      body: { applicationId: application.id, mode: "scripted" },
    });
    let compiled: any = null;
    const deadline = Date.now() + 8 * 60_000;
    while (Date.now() < deadline) {
      const poll = await api<any>("GET", `/api/recordings/${recording.body.id}`, { token: adminToken });
      if (poll.body?.recording?.status && poll.body.recording.status !== "recording") {
        compiled = poll.body;
        break;
      }
      await sleep(1_000);
    }
    if (!compiled?.workflow) {
      check("recording compiled", false, `status=${compiled?.recording?.status}`);
      return 1;
    }
    check("recording compiled into a draft workflow", true, `${compiled.workflow.steps.length} steps`);

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
    check("workflow approved", approval.status === 201, `HTTP ${approval.status}`);

    const execute = async (company: string, email: string, extra: Record<string, unknown> = {}) => {
      const plan = await api<any>("POST", "/api/plans", {
        token: employeeToken,
        body: { intent: `Create a customer named "${company}" with contact ${email}` },
      });
      const run = await api<any>("POST", "/api/executions", {
        token: employeeToken,
        body: { planId: plan.body?.plan?.id, inputs: {}, approved: true, ...extra },
      });
      return run.body;
    };
    const setFault = (mode: string) =>
      fetch(`${demoApp.url}/api/faults`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode }),
      });

    /* ---------------- 1. normal run, new data ---------------- */
    const normal = await execute("Northwind Freight", "ops@northwind.test");
    check("1. new data verifies against the system of record", normal?.outcome === "VERIFIED", `outcome=${normal?.outcome} message=${(normal?.message ?? "").slice(0, 140)}`);
    check(
      "1. no failure is recorded on a verified run",
      normal?.failure === null,
      JSON.stringify(normal?.failure ?? null),
    );
    const phases = normal?.timings?.phases ?? {};
    check(
      "1. phase timings are recorded",
      (normal?.timings?.totalMs ?? 0) > 0 && phases.replayMs !== null && phases.persistenceMs !== null,
      `total=${normal?.timings?.totalMs}ms replay=${Math.round(phases.replayMs ?? 0)}ms startup=${Math.round(phases.bridgeStartupMs ?? 0)}ms verify=${phases.verificationMs}ms`,
    );
    const steps = normal?.steps ?? [];
    check(
      "1. every step carries a real duration",
      steps.length > 0 && steps.every((step: any) => typeof step.durationMs === "number" && step.durationMs > 0),
      steps.map((step: any) => `${step.index}:${Math.round(step.durationMs ?? 0)}ms`).join(" "),
    );
    const typed = steps.filter((step: any) => step.intent.startsWith("type"));
    check(
      "1. typed values are verified by the engine at their step",
      typed.length > 0 && typed.every((step: any) => step.inputVerified === true),
      typed.map((step: any) => `${step.intent}:${step.inputVerified}`).join(" "),
    );
    check(
      "1. every target resolved, none by AI assistance",
      steps.length === 6 &&
        steps.every((step: any) => Boolean(step.resolvedSelector)) &&
        steps.every((step: any) => step.resolutionSource !== "ai_assisted"),
      steps.map((step: any) => `${step.index}:${step.resolutionSource}`).join(" "),
    );
    check(
      "1. controls with a recorded selector use it unchanged",
      steps
        .filter((step: any) => [0, 1, 3, 5].includes(step.index))
        .every((step: any) => step.resolutionSource === "recorded"),
      steps.map((step: any) => `${step.index}:${step.resolvedSelector}`).join(" "),
    );

    /* ---------------- 2. recoverable UI change ---------------- */
    await setFault("renamed-selector");
    const first = await execute("Contoso Logistics", "dana@contoso.test");
    check("2. a renamed control is re-discovered and the run verifies", first?.outcome === "VERIFIED", `outcome=${first?.outcome}`);
    check(
      "2. the rediscovered selector is recorded on its step",
      (first?.steps ?? []).some(
        (step: any) => step.resolutionSource === "rediscovered" && step.resolvedSelector === "#save-customer-v2",
      ),
      JSON.stringify((first?.steps ?? []).map((step: any) => [step.resolvedSelector, step.resolutionSource])),
    );

    const candidates = await api<any>("GET", "/api/repairs?status=candidate", { token: adminToken });
    const repair = (candidates.body?.items ?? []).find((row: any) => row.action?.stepIndex === 5);
    check(
      "2. the verified drift is stored as a repair candidate awaiting review",
      Boolean(repair) && repair.status === "candidate" && repair.action?.toSelector === "#save-customer-v2",
      JSON.stringify(repair?.action ?? null),
    );

    const review = repair
      ? await api<any>("POST", `/api/repairs/${repair.id}/review`, {
          token: adminToken,
          body: { status: "approved" },
        })
      : { status: 0, body: null };
    check("2. an admin can promote the repair", review.status === 200 && review.body?.repair?.status === "approved", `HTTP ${review.status}`);

    const employeeReview = repair
      ? await api<any>("POST", `/api/repairs/${repair.id}/review`, {
          token: employeeToken,
          body: { status: "approved" },
        })
      : { status: 0 };
    check("2. an employee cannot promote a repair", employeeReview.status === 403, `HTTP ${employeeReview.status}`);

    const second = await execute("Fabrikam Rail", "ops@fabrikam.test");
    check("2. the next run still verifies with the repaired selector", second?.outcome === "VERIFIED", `outcome=${second?.outcome}`);
    const repairsAfter = await api<any>("GET", "/api/repairs", { token: adminToken });
    const used = (repairsAfter.body?.items ?? []).find((row: any) => row.id === repair?.id);
    check(
      "2. the approved repair was re-used and its success recorded",
      used?.successCount === 1,
      `successCount=${used?.successCount} failureCount=${used?.failureCount}`,
    );
    const appliedStep = (second?.steps ?? []).find((step: any) => step.index === 5);
    check(
      "2. the approved repair supplies the drifted control (M4: reviewed memory before re-discovery)",
      appliedStep?.resolvedSelector === "#save-customer-v2" &&
        appliedStep?.resolutionSource === "repair" &&
        Boolean(appliedStep?.repairId),
      JSON.stringify({
        selector: appliedStep?.resolvedSelector,
        source: appliedStep?.resolutionSource,
        detail: appliedStep?.detail,
      }),
    );
    await setFault("none");

    /* ---------------- 3. rejected write ---------------- */
    await setFault("reject-create");
    const rejected = await execute("Tailspin Refused", "ops@tailspin-refused.test");
    check("3. a rejected write is never VERIFIED", rejected?.outcome === "FAILED", `outcome=${rejected?.outcome}`);
    check(
      "3. the failure carries a structured origin and code",
      Boolean(rejected?.failure?.origin) && Boolean(rejected?.failure?.code),
      `${rejected?.failure?.origin} / ${rejected?.failure?.code} — ${(rejected?.failure?.detail ?? "").slice(0, 120)}`,
    );
    check(
      "3. an application-rejected write is classified from its response evidence and is not retried",
      rejected?.failure?.origin === "application" &&
        rejected?.failure?.code === "APPLICATION_REJECTED" &&
        (rejected?.recovery === null || rejected?.recovery?.attempted === false),
      `${rejected?.failure?.origin}/${rejected?.failure?.code} recovery=${JSON.stringify(rejected?.recovery ?? null)}`,
    );
    const readback = await fetch(`${demoApp.url}/api/customers?name=Tailspin%20Refused`).then((r) => r.json());
    check(
      "3. nothing was written to the application",
      Array.isArray(readback.items) && readback.items.length === 0,
      JSON.stringify(readback.items),
    );
    await setFault("none");

    const episodes = await api<any>("GET", "/api/memory/episodes?limit=10", { token: adminToken });
    check(
      "3. every attempt left an episodic memory row",
      (episodes.body?.items ?? []).length >= 4,
      `episodes=${(episodes.body?.items ?? []).length}`,
    );

    const failed = results.filter((row) => !row.ok);
    console.log(`\n${results.length - failed.length}/${results.length} smoke checks passed`);
    return failed.length === 0 ? 0 : 1;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await sql.close();
    await demoApp.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`SMOKE ERROR: ${error instanceof Error ? error.stack : String(error)}`);
    process.exit(1);
  });
