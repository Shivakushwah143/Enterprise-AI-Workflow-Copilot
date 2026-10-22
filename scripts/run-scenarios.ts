/**
 * End-to-end scenario: record -> learn -> parameterize -> replay -> verify.
 *
 *   pnpm demo:scenarios
 *
 * What runs:
 *   - the two disposable demo applications, on the ports declared in DEMO_APPS;
 *   - the real API (Hono) against a throwaway PostgreSQL (PGlite) directory;
 *   - the real OpenAdapt engine, through the Python bridge subprocess.
 *
 * Nothing here is simulated. The workflow is recorded by driving Chromium
 * through OpenAdapt's Recorder, compiled into a bundle, approved by an admin,
 * executed by an employee request with DIFFERENT input data, and then verified
 * by reading the demo application's database out of band. The deliberate
 * failure scenario switches the application into `reject-create` mode, so the
 * write really is refused.
 *
 * Exit codes: 0 = every check passed, 1 = a check failed, 2 = blocked (the
 * engine is not usable on this machine; the reason is printed and recorded).
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { serve } from "@hono/node-server";
import { KnowledgeEngine, Store, openDb } from "@copilot/knowledge";
import { DEMO_APPS, OpenAdaptEngine } from "@copilot/workflow";
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

function portOf(url: string): number {
  return Number(new URL(url).port);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const artifactRoot = path.resolve(process.env.COPILOT_ARTIFACTS ?? ".copilot-data");
const runRoot = path.join(artifactRoot, "scenarios", stamp);
const apiPort = Number(process.env.SCENARIO_API_PORT ?? 4100);
const baseUrl = `http://127.0.0.1:${apiPort}`;

if (!process.env.PYTHON_BIN) {
  const candidate = path.resolve(
    process.platform === "win32" ? ".venv-flow/Scripts/python.exe" : ".venv-flow/bin/python",
  );
  process.env.PYTHON_BIN = candidate;
}

let adminToken = "";
let employeeToken = "";
let tenantId = "";

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
  const response = await api<{ token: string; tenantId: string }>("POST", "/api/auth/login", {
    body: { tenantSlug, email },
  });
  if (response.status !== 200) {
    throw new Error(`login failed for ${email}: HTTP ${response.status}`);
  }
  tenantId = response.body.tenantId;
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

async function main(): Promise<number> {
  await rm(runRoot, { recursive: true, force: true });
  await mkdir(runRoot, { recursive: true });

  const crm = DEMO_APPS[0]!;
  const stock = DEMO_APPS[1]!;
  const crmApp = await startAcmeDesk({ port: portOf(crm.baseUrl), dataDir: path.join(runRoot, "demo") });
  const stockApp = await startStockDesk({
    port: portOf(stock.baseUrl),
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
      capabilities.body?.database?.kind === "pglite" &&
        capabilities.body?.database?.tenancyEnforced === true,
      `kind=${capabilities.body?.database?.kind}`,
    );
    console.log(
      `      llm=${capabilities.body?.llm?.status} vector=${capabilities.body?.vectorSearch?.status} stagehand=${capabilities.body?.stagehand?.status}`,
    );
    if (!engineUp) {
      console.log("\nBLOCKED: the workflow engine is not usable, so the lifecycle cannot run.");
      console.log("Install it with:  .venv-flow/Scripts/python.exe -m pip install -e \"research/OpenAdapt/packages/flow[browser]\"");
      console.log("Then:             .venv-flow/Scripts/python.exe -m playwright install chromium");
      await writeEvidence({ blocked: true });
      return 2;
    }

    section("1. Admin teaches a business workflow (record -> compile)");
    adminToken = await login("acme-demo", world.users.admin);
    employeeToken = await login("acme-demo", world.users.employee);
    check("admin and employee sessions issued", Boolean(adminToken && employeeToken), `tenant ${tenantId}`);

    const started = await api<any>("POST", "/api/recordings", {
      token: adminToken,
      body: { applicationId: world.applications[0]!.application.id, mode: "scripted" },
    });
    check("recording accepted", started.status === 202, `HTTP ${started.status}`);
    if (started.status !== 202) throw new Error("recording could not be started");

    const finished = await waitForRecording(started.body.id);
    check(
      "demonstration compiled into a draft workflow",
      finished.recording.status === "compiled" && Boolean(finished.workflow),
      `status=${finished.recording.status} error=${finished.recording.error ?? "none"}`,
    );
    const workflow = finished.workflow;
    if (!workflow) throw new Error("no workflow was produced");
    check(
      "the learned workflow has steps with recorded identity",
      workflow.steps.length > 0 && workflow.steps.every((s: any) => s.action),
      `${workflow.steps.length} steps, ${workflow.uncertainty.length} uncertainty note(s)`,
    );
    console.log(
      `      bundle: ${workflow.bundlePath}\n      steps: ${workflow.steps
        .map((s: any) => `${s.index}:${s.action}${s.paramName ? `(${s.paramName})` : ""}`)
        .join(" -> ")}`,
    );

    section("2. Admin approves the skill (parameterize + verification contract)");
    const verification: VerificationContract = {
      kind: "http",
      tier: "system_of_record",
      url: world.applications[0]!.demo.verification.url,
      recordPath: world.applications[0]!.demo.verification.recordPath,
      expect: world.applications[0]!.demo.verification.expect,
      match: world.applications[0]!.demo.verification.match,
    };
    const approved = await api<any>("POST", `/api/workflows/${workflow.id}/approve`, {
      token: adminToken,
      body: {
        name: world.applications[0]!.demo.workflowName,
        description: world.applications[0]!.demo.description,
        triggeredBy: world.applications[0]!.demo.triggers,
        verification,
        acknowledgeRisk: true,
      },
    });
    check("workflow approved into an active skill", approved.status === 201, `HTTP ${approved.status}`);
    const skill = approved.body?.skill;
    if (!skill) throw new Error(`approval failed: ${JSON.stringify(approved.body)}`);
    check(
      "skill declares the parameters learned from the bundle",
      Array.isArray(skill.requiredInputs) && skill.requiredInputs.length > 0,
      skill.requiredInputs.map((p: any) => `${p.name}${p.secret ? "(secret)" : ""}`).join(", "),
    );

    section("3. Employee asks in natural language (new input data)");
    const intent =
      'Create a customer named "Northwind Freight" with contact ops@northwind.test';
    const planResponse = await api<any>("POST", "/api/plans", {
      token: employeeToken,
      body: { intent },
    });
    const plan = planResponse.body?.plan;
    check(
      "agent selects the approved skill",
      plan?.skillId === skill.id,
      `skill=${plan?.skillName} method=${planResponse.body?.method} confidence=${plan?.confidence}`,
    );
    check(
      "agent extracts the new input values instead of reusing the demonstration",
      plan?.resolvedInputs?.some(
        (i: any) => i.name === "company_name" && i.value === "Northwind Freight",
      ) === true,
      JSON.stringify(plan?.resolvedInputs),
    );

    section("4. Extension state before and during execution");
    const context = await api<any>(
      "GET",
      `/api/context?url=${encodeURIComponent(world.applications[0]!.application.baseUrl + "/")}`,
      { token: employeeToken },
    );
    check(
      "extension sees the application and its suggested skills",
      context.body?.appName === world.applications[0]!.demo.name &&
        context.body?.suggestedSkills?.length > 0,
      `app=${context.body?.appName} skills=${context.body?.suggestedSkills?.length}`,
    );
    const guidance = await api<any>(
      "GET",
      `/api/guidance?skillId=${skill.id}&stepIndex=0`,
      { token: employeeToken },
    );
    check(
      "guidance step 1 is highlightable from a recorded selector",
      guidance.body?.highlightable === true && Boolean(guidance.body?.selector),
      `selector=${guidance.body?.selector} instruction="${guidance.body?.instruction}"`,
    );

    section("5. Guarded execution against the real application");
    const blockedRun = await api<any>("POST", "/api/executions", {
      token: employeeToken,
      body: { planId: plan.id, inputs: {}, approved: false },
    });
    check(
      "irreversible workflow is refused without explicit approval",
      blockedRun.body?.outcome === "REJECTED_POLICY",
      `outcome=${blockedRun.body?.outcome}`,
    );

    const run = await api<any>("POST", "/api/executions", {
      token: employeeToken,
      body: { planId: plan.id, inputs: {}, approved: true },
    });
    const execution = run.body;
    check(
      "execution is VERIFIED by the system of record",
      execution?.outcome === "VERIFIED",
      `outcome=${execution?.outcome} engine=${execution?.engineOutcome} message="${execution?.message}"`,
    );
    check(
      "verification read the record from the application API",
      execution?.verification?.passed === true &&
        execution?.verification?.tier === "system_of_record",
      execution?.verification?.detail ?? "no verification result",
    );
    console.log(
      `      steps: ${(execution?.steps ?? [])
        .map((s: any) => `${s.index}:${s.status}${s.rung ? `/${s.rung}` : ""}`)
        .join(" ")}\n      report: ${execution?.engineReportPath}`,
    );

    const oracle = await fetch(
      `${world.applications[0]!.application.baseUrl}/api/customers?name=Northwind%20Freight`,
    );
    const oracleBody = await oracle.json();
    check(
      "the application database really contains the new customer",
      Array.isArray(oracleBody.items) &&
        oracleBody.items.length === 1 &&
        oracleBody.items[0].email === "ops@northwind.test",
      JSON.stringify(oracleBody.items),
    );

    section("6. Deliberate failed write (the application rejects the save)");
    await fetch(`${world.applications[0]!.application.baseUrl}/api/faults`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "reject-create" }),
    });
    const failIntent =
      'Create a customer named "Fabrikam Rail" with contact ops@fabrikam.test';
    const failPlan = await api<any>("POST", "/api/plans", {
      token: employeeToken,
      body: { intent: failIntent },
    });
    const failRun = await api<any>("POST", "/api/executions", {
      token: employeeToken,
      body: { planId: failPlan.body?.plan?.id, inputs: {}, approved: true },
    });
    check(
      "a refused write produces FAILED, never VERIFIED",
      failRun.body?.outcome === "FAILED",
      `outcome=${failRun.body?.outcome} message="${failRun.body?.message}"`,
    );
    const failedOracle = await fetch(
      `${world.applications[0]!.application.baseUrl}/api/customers?name=Fabrikam%20Rail`,
    );
    const failedBody = await failedOracle.json();
    check(
      "the refused record is absent from the application database",
      Array.isArray(failedBody.items) && failedBody.items.length === 0,
      JSON.stringify(failedBody.items),
    );
    await fetch(`${world.applications[0]!.application.baseUrl}/api/faults`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "none" }),
    });

    section("7. Execution history for the extension");
    const history = await api<any>("GET", "/api/executions", { token: employeeToken });
    const outcomes = (history.body?.items ?? []).map((i: any) => i.outcome);
    check(
      "history shows both the verified and the failed run",
      outcomes.includes("VERIFIED") && outcomes.includes("FAILED"),
      outcomes.join(", "),
    );

    const passed = failures.length === 0;
    await writeEvidence({
      blocked: false,
      outcome: passed ? "PASS" : "FAIL",
      workflowId: workflow.id,
      skillId: skill.id,
      bundlePath: workflow.bundlePath,
      executions: outcomes,
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
