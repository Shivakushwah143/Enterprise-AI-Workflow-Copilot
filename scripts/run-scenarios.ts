/**
 * End-to-end scenarios: record -> learn -> parameterize -> replay -> verify.
 *
 *   pnpm demo:scenarios     (alias: pnpm test:e2e)
 *
 * What runs, against nothing simulated at the business layer:
 *   - both disposable demo applications, on the ports declared in DEMO_APPS;
 *   - the real API (Hono) on a throwaway PostgreSQL (PGlite) directory;
 *   - the real OpenAdapt engine, through the Python bridge subprocess.
 *
 * Coverage:
 *   1. interactive recorder (headed browser) started and stopped through the
 *      engine, compiled and inspected. The first session is driven by an
 *      automated stand-in for a human and is labelled as such; the second is a
 *      real stop request on a human-mode session (nobody performed actions, so
 *      it is expected to contain zero events - it proves the stop path only).
 *   2. for BOTH applications: scripted record -> compile -> approve -> plan with
 *      new inputs -> approved execution -> independent verification.
 *   3. the failure matrix: a refused write, a missing control, a duplicate
 *      record, and an employee attempting an admin action.
 *
 * Exit codes: 0 = every check passed, 1 = a check failed, 2 = blocked (the
 * engine is not usable on this machine; the reason is printed and recorded).
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { serve } from "@hono/node-server";
import { KnowledgeEngine, Store, openDb } from "@copilot/knowledge";
import { DEMO_APPS, OpenAdaptEngine, fillTemplate, inspectBundle } from "@copilot/workflow";
import type { VerificationContract } from "@copilot/shared";
import { createApp } from "../apps/api/src/app.js";
import { seedDemo } from "../apps/api/src/seed-data.js";
import { startAcmeDesk, startStockDesk } from "../apps/demo/src/apps.js";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];
const failures: Check[] = [];

function check(name: string, ok: boolean, detail: string): boolean {
  const entry = { name, ok, detail };
  checks.push(entry);
  if (!ok) failures.push(entry);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n      ${detail}`);
  return ok;
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const artifactRoot = path.resolve(process.env.COPILOT_ARTIFACTS ?? ".copilot-data");
const runRoot = path.join(artifactRoot, "scenarios", stamp);
const apiPort = Number(process.env.SCENARIO_API_PORT ?? 4100);
const baseUrl = `http://127.0.0.1:${apiPort}`;

if (!process.env.PYTHON_BIN) {
  process.env.PYTHON_BIN = path.resolve(
    process.platform === "win32" ? ".venv-flow/Scripts/python.exe" : ".venv-flow/bin/python",
  );
}

let adminToken = "";
let employeeToken = "";

async function api<T = any>(
  method: string,
  route: string,
  options: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
}

async function login(tenantSlug: string, email: string): Promise<string> {
  const response = await api<{ token: string }>("POST", "/api/auth/login", {
    body: { tenantSlug, email },
  });
  if (response.status !== 200) throw new Error(`login failed for ${email}: HTTP ${response.status}`);
  return response.body.token;
}

async function waitForRecording(recordingId: string, timeoutMs = 10 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const { body } = await api<any>("GET", `/api/recordings/${recordingId}`, {
      token: adminToken,
    });
    const status = body.recording.status as string;
    if (status !== last) {
      console.log(`      recording ${recordingId.slice(0, 8)}: ${status}`);
      last = status;
    }
    if (status !== "recording") return body;
    await sleep(1000);
  }
  throw new Error("recording did not finish within the timeout");
}

async function oracle(demoBase: string, contract: VerificationContract, inputs: Record<string, string>) {
  const url = fillTemplate(contract.url, inputs);
  const response = await fetch(url);
  const payload = (await response.json()) as Record<string, unknown>;
  const items = payload[contract.recordPath];
  return { url, items: Array.isArray(items) ? (items as Record<string, unknown>[]) : [] };
}

async function setFault(appUrl: string, mode: string): Promise<void> {
  await fetch(`${appUrl}/api/faults`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
}

async function main(): Promise<number> {
  await rm(runRoot, { recursive: true, force: true });
  await mkdir(runRoot, { recursive: true });

  const crm = DEMO_APPS[0]!;
  const stock = DEMO_APPS[1]!;
  const crmApp = await startAcmeDesk({
    port: Number(new URL(crm.baseUrl).port),
    dataDir: path.join(runRoot, "demo"),
  });
  const stockApp = await startStockDesk({
    port: Number(new URL(stock.baseUrl).port),
    dataDir: path.join(runRoot, "demo"),
  });
  console.log(`demo applications: ${crmApp.url}, ${stockApp.url}`);

  const sql = await openDb({ dataDir: path.join(runRoot, "pg") });
  const store = new Store(sql);
  const knowledge = new KnowledgeEngine(store);
  const engine = new OpenAdaptEngine();
  const app = createApp({ store, engine, knowledge, artifactRoot: runRoot });
  const server = serve({ fetch: app.fetch, port: apiPort });
  await sleep(150);

  try {
    const world = await seedDemo(store, knowledge, (event) =>
      console.log(`   ${JSON.stringify(event)}`),
    );

    section("0. Capabilities");
    const capabilities = await api<any>("GET", "/api/capabilities");
    const engineUp = Boolean(capabilities.body?.engine?.available);
    check(
      "OpenAdapt engine is available",
      engineUp,
      capabilities.body?.engine?.detail ?? "no capability payload",
    );
    check(
      "database is PostgreSQL with tenant scoping",
      capabilities.body?.database?.tenancyEnforced === true,
      `kind=${capabilities.body?.database?.kind}`,
    );
    console.log(
      `      llm=${capabilities.body?.llm?.status} vector=${capabilities.body?.vectorSearch?.status} stagehand=${capabilities.body?.stagehand?.status}`,
    );
    if (!engineUp) {
      console.log("\nBLOCKED: the workflow engine is not usable, so the lifecycle cannot run.");
      console.log(
        'Install it with: .venv-flow/Scripts/python.exe -m pip install -e "research/OpenAdapt/packages/flow[browser]"',
      );
      await writeEvidence({ blocked: true });
      return 2;
    }

    section("1. Interactive recorder (headed browser)");
    adminToken = await login("acme-demo", world.users.admin);
    employeeToken = await login("acme-demo", world.users.employee);
    check("admin and employee sessions issued", Boolean(adminToken && employeeToken), "acme-demo");

    // 1a. The real interactive recorder, driven by an automated stand-in.
    const interactiveDir = path.join(runRoot, "interactive", "standin-rec");
    const standin = await engine.recordInteractive({
      url: crm.baseUrl,
      outDir: interactiveDir,
      paramFields: ["company_name", "email"],
      demoKey: "acme-crm",
    });
    const standinResult = await standin.result;
    check(
      "interactive recorder captured a demonstration in a headed browser",
      standinResult.ok && standinResult.events > 0,
      `events=${standinResult.events} frames=${standinResult.frames} driver=automated stand-in (NOT a human session)`,
    );
    const standinBundle = path.join(runRoot, "interactive", "standin-bundle");
    const standinCompiled = await engine.compile({
      recordingDir: standinResult.recordingDir,
      bundleDir: standinBundle,
      name: "Interactive stand-in demo",
    });
    const inspectedInteractive = standinCompiled.ok
      ? await inspectBundle(standinBundle)
      : null;
    check(
      "the interactive recording compiles into a parameterized workflow",
      Boolean(inspectedInteractive) &&
        inspectedInteractive!.steps.length >= 5 &&
        inspectedInteractive!.params.length === 2,
      inspectedInteractive
        ? `${inspectedInteractive.steps.length} steps, params ${inspectedInteractive.params.map((p) => p.name).join(", ")}`
        : (standinCompiled.error ?? "compile failed"),
    );

    // 1b. A stop request on a human-mode session. Nobody is at the keyboard in
    // this run, so zero events is the correct result; what is proven is that a
    // stop request ends the session and the browser closes.
    const humanDir = path.join(runRoot, "interactive", "stop-rec");
    const session = await engine.recordInteractive({
      url: crm.baseUrl,
      outDir: humanDir,
      paramFields: ["company_name", "email"],
    });
    await sleep(2500);
    const stopStarted = Date.now();
    await session.stop();
    const stopped = await session.result;
    check(
      "a stop request ends the session and the recorder flushes",
      stopped.ok && Date.now() - stopStarted < 60_000,
      `events=${stopped.events} (no human drove this session) stop took ${Date.now() - stopStarted}ms`,
    );

    section("2. Rejected permissions");
    const forbiddenApprove = await api<any>("POST", `/api/workflows/any/approve`, {
      token: employeeToken,
      body: {},
    });
    check(
      "an employee cannot approve a workflow",
      forbiddenApprove.status === 403,
      `HTTP ${forbiddenApprove.status} ${forbiddenApprove.body?.error?.message ?? ""}`,
    );
    const forbiddenRecord = await api<any>("POST", "/api/recordings", {
      token: employeeToken,
      body: { applicationId: world.applications[0]!.application.id, mode: "scripted" },
    });
    check(
      "an employee cannot record a demonstration",
      forbiddenRecord.status === 403,
      `HTTP ${forbiddenRecord.status}`,
    );

    section("3. Cross-application lifecycle");
    const approved: { demo: typeof crm; skillId: string; workflowId: string }[] = [];
    const intents: Record<string, { text: string; inputs: Record<string, string> }> = {
      "acme-crm": {
        text: 'Create a customer named "Northwind Freight" with contact ops@northwind.test',
        inputs: { company_name: "Northwind Freight", email: "ops@northwind.test" },
      },
      stockdesk: {
        text: 'Register stock item "SKU-8842" with quantity 40',
        inputs: { sku: "SKU-8842", quantity: "40" },
      },
    };

    for (const [index, demo] of DEMO_APPS.entries()) {
      const application = world.applications[index]!.application;
      console.log(`\n--- ${demo.name} ---`);

      const started = await api<any>("POST", "/api/recordings", {
        token: adminToken,
        body: { applicationId: application.id, mode: "scripted" },
      });
      check(`${demo.name}: demonstration accepted`, started.status === 202, `HTTP ${started.status}`);
      const finished = await waitForRecording(started.body.id);
      check(
        `${demo.name}: compiled into a draft workflow`,
        finished.recording.status === "compiled" && Boolean(finished.workflow),
        `status=${finished.recording.status} error=${finished.recording.error ?? "none"}`,
      );
      const workflow = finished.workflow;
      if (!workflow) continue;

      const verification: VerificationContract = {
        kind: "http",
        tier: "system_of_record",
        url: demo.verification.url,
        recordPath: demo.verification.recordPath,
        expect: demo.verification.expect,
        match: demo.verification.match,
      };
      const approval = await api<any>("POST", `/api/workflows/${workflow.id}/approve`, {
        token: adminToken,
        body: {
          name: demo.workflowName,
          description: demo.description,
          triggeredBy: demo.triggers,
          verification,
          acknowledgeRisk: true,
        },
      });
      check(
        `${demo.name}: workflow approved into an active skill`,
        approval.status === 201 && approval.body?.skill?.status === "active",
        `HTTP ${approval.status} inputs=${(approval.body?.skill?.requiredInputs ?? []).map((p: any) => p.name).join(",")}`,
      );
      const skill = approval.body?.skill;
      if (!skill) continue;
      approved.push({ demo, skillId: skill.id, workflowId: workflow.id });

      const planResponse = await api<any>("POST", "/api/plans", {
        token: employeeToken,
        body: { intent: intents[demo.key]!.text },
      });
      const plan = planResponse.body?.plan;
      check(
        `${demo.name}: the agent selects the approved skill from natural language`,
        plan?.skillId === skill.id,
        `method=${planResponse.body?.method} confidence=${plan?.confidence} intent="${intents[demo.key]!.text}"`,
      );
      const resolved = Object.fromEntries(
        (plan?.resolvedInputs ?? []).map((i: any) => [i.name, i.value]),
      );
      check(
        `${demo.name}: new input data is extracted, not the demonstrated values`,
        JSON.stringify(resolved) === JSON.stringify(intents[demo.key]!.inputs),
        JSON.stringify(resolved),
      );

      const blockedRun = await api<any>("POST", "/api/executions", {
        token: employeeToken,
        body: { planId: plan.id, inputs: {}, approved: false },
      });
      check(
        `${demo.name}: executing without the policy approval is refused`,
        blockedRun.body?.outcome === "REJECTED_POLICY",
        `outcome=${blockedRun.body?.outcome}`,
      );

      const run = await api<any>("POST", "/api/executions", {
        token: employeeToken,
        body: { planId: plan.id, inputs: {}, approved: true },
      });
      check(
        `${demo.name}: execution VERIFIED by the system of record`,
        run.body?.outcome === "VERIFIED",
        `outcome=${run.body?.outcome} engine=${run.body?.engineOutcome} message="${run.body?.message}"`,
      );
      check(
        `${demo.name}: verification evidence is a real read-back`,
        run.body?.verification?.passed === true &&
          run.body?.verification?.tier === "system_of_record",
        run.body?.verification?.detail ?? "no verification result",
      );
      const readback = await oracle(demo.baseUrl, verification, intents[demo.key]!.inputs);
      check(
        `${demo.name}: the application database contains the new record`,
        readback.items.length === 1,
        `${readback.url} -> ${JSON.stringify(readback.items)}`,
      );

      const guidance = await api<any>("GET", `/api/guidance?skillId=${skill.id}&stepIndex=0`, {
        token: employeeToken,
      });
      check(
        `${demo.name}: guidance exposes the recorded selector`,
        guidance.body?.highlightable === true && Boolean(guidance.body?.selector),
        `selector=${guidance.body?.selector} instruction="${guidance.body?.instruction}"`,
      );
    }

    section("4. Failure matrix");
    // A refused write: the application answers 500 and persists nothing.
    await setFault(crm.baseUrl, "reject-create");
    const rejectedPlan = await api<any>("POST", "/api/plans", {
      token: employeeToken,
      body: { intent: 'Create a customer named "Fabrikam Rail" with contact ops@fabrikam.test' },
    });
    const rejectedRun = await api<any>("POST", "/api/executions", {
      token: employeeToken,
      body: { planId: rejectedPlan.body?.plan?.id, inputs: {}, approved: true },
    });
    check(
      "a refused write produces FAILED, never VERIFIED",
      rejectedRun.body?.outcome === "FAILED" && rejectedRun.body?.verification?.passed === false,
      `outcome=${rejectedRun.body?.outcome} message="${rejectedRun.body?.message}"`,
    );
    const rejectedReadback = await fetch(
      `${crm.baseUrl}/api/customers?name=Fabrikam%20Rail`,
    ).then((r) => r.json());
    check(
      "the refused record is absent from the application database",
      Array.isArray(rejectedReadback.items) && rejectedReadback.items.length === 0,
      JSON.stringify(rejectedReadback.items),
    );
    await setFault(crm.baseUrl, "none");

    // A missing control: the page no longer offers the save button.
    await setFault(stock.baseUrl, "missing-control");
    const missingPage = await fetch(`${stock.baseUrl}/`).then((r) => r.text());
    check(
      "the application really serves a page without the save control",
      missingPage.includes("save-unavailable") && !missingPage.includes("save-item"),
      `save-unavailable present=${missingPage.includes("save-unavailable")}`,
    );
    const missingPlan = await api<any>("POST", "/api/plans", {
      token: employeeToken,
      body: { intent: 'Register stock item "SKU-9999" with quantity 5' },
    });
    const missingRun = await api<any>("POST", "/api/executions", {
      token: employeeToken,
      body: { planId: missingPlan.body?.plan?.id, inputs: {}, approved: true },
    });
    check(
      "a missing control fails the run instead of claiming success",
      missingRun.body?.outcome === "FAILED",
      `outcome=${missingRun.body?.outcome} message="${(missingRun.body?.message ?? "").slice(0, 200)}"`,
    );
    const missingReadback = await fetch(`${stock.baseUrl}/api/items?sku=SKU-9999`).then((r) =>
      r.json(),
    );
    check(
      "no record was written when the control was missing",
      Array.isArray(missingReadback.items) && missingReadback.items.length === 0,
      JSON.stringify(missingReadback.items),
    );
    await setFault(stock.baseUrl, "none");

    // A duplicate: the pre-run read refuses to re-create what already exists.
    const duplicatePlan = await api<any>("POST", "/api/plans", {
      token: employeeToken,
      body: { intent: intents["acme-crm"]!.text },
    });
    const duplicateRun = await api<any>("POST", "/api/executions", {
      token: employeeToken,
      body: { planId: duplicatePlan.body?.plan?.id, inputs: {}, approved: true },
    });
    check(
      "an existing record is refused before anything runs",
      duplicateRun.body?.outcome === "REJECTED",
      `outcome=${duplicateRun.body?.outcome} message="${duplicateRun.body?.message}"`,
    );

    section("5. Execution history and extension context");
    const history = await api<any>("GET", "/api/executions", { token: employeeToken });
    const outcomes = (history.body?.items ?? []).map((i: any) => i.outcome);
    check(
      "history shows verified and failed runs side by side",
      outcomes.includes("VERIFIED") && outcomes.includes("FAILED"),
      outcomes.join(", "),
    );
    for (const demo of DEMO_APPS) {
      const context = await api<any>(
        "GET",
        `/api/context?url=${encodeURIComponent(`${demo.baseUrl}/`)}`,
        { token: employeeToken },
      );
      check(
        `extension context resolves ${demo.name}`,
        context.body?.appName === demo.name && context.body?.suggestedSkills?.length > 0,
        `app=${context.body?.appName} skills=${context.body?.suggestedSkills?.length}`,
      );
    }

    section("6. Persistence");
    const planRows = await sql.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM plans");
    const executionRows = await sql.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM executions",
    );
    const verificationRows = await sql.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM verification_results",
    );
    check(
      "plans, executions and verification evidence are persisted",
      Number(planRows[0]?.count ?? 0) >= 4 &&
        Number(executionRows[0]?.count ?? 0) >= 4 &&
        Number(verificationRows[0]?.count ?? 0) >= 2,
      `plans=${planRows[0]?.count} executions=${executionRows[0]?.count} verifications=${verificationRows[0]?.count}`,
    );

    const passed = failures.length === 0;
    await writeEvidence({
      blocked: false,
      outcome: passed ? "PASS" : "FAIL",
      applications: DEMO_APPS.map((d) => d.name),
      skills: approved.map((a) => ({ application: a.demo.name, skillId: a.skillId })),
      checks,
    });
    return passed ? 0 : 1;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await sql.close();
    await crmApp.close();
    await stockApp.close();
  }
}

async function writeEvidence(payload: Record<string, unknown>): Promise<void> {
  const file = path.join(runRoot, "evidence.json");
  await writeFile(file, JSON.stringify({ runAt: new Date().toISOString(), ...payload }, null, 2));
  console.log(`\nevidence: ${file}`);
  if (!payload["blocked"]) {
    const failed = checks.filter((c) => !c.ok);
    console.log(
      `\n${checks.length - failed.length}/${checks.length} checks passed${
        failed.length ? `; failing: ${failed.map((f) => f.name).join("; ")}` : ""
      }`,
    );
  }
}

main()
  .then((code) => process.exit(code))
  .catch(async (error) => {
    console.error(`\nSCENARIO ERROR: ${error instanceof Error ? error.stack : String(error)}`);
    await writeEvidence({ blocked: false, outcome: "ERROR", error: String(error) }).catch(() => {});
    process.exit(1);
  });
