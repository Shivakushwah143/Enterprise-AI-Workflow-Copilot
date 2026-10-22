/**
 * M0 — functional reliability baseline (diagnostic harness, not product code).
 *
 * Runs ONE approved, compiled workflow — "Create customer" on the local
 * AcmeDesk CRM — ten times through the real employee path, with a different
 * data set each time:
 *
 *   natural-language intent -> POST /api/plans -> POST /api/executions
 *     -> OpenAdapt replay in a real Chromium -> independent read-back
 *
 * Nothing is stubbed at the business layer: the demo app is a real HTTP server
 * with its own SQLite database, the engine is the real OpenAdapt 2.3.0
 * subprocess, and verification is a different channel (HTTP API) from the GUI
 * the engine drives. The only synthetic piece is the *demonstration* used to
 * create the recording (no human is at this machine); it is labelled as such.
 *
 * After the ten runs, three bounded fault probes (using the demo app's own
 * fault switch, no code changes) prove the harness can actually detect
 * failures. Without them a 10/10 result would be indistinguishable from a
 * measurement that always says PASS.
 *
 * Evidence per run: timing, plan provenance, per-step outcomes, engine report
 * summary, verification evidence, out-of-band read-back, and a Playwright trace
 * written by `scripts/m0/playwright-trace-shim/sitecustomize.py`.
 *
 *   pnpm exec tsx scripts/m0/reliability-baseline.ts
 *
 * Exit code 0 when the harness itself completed (regardless of how many runs
 * failed — the failures are the measurement). 2 when the environment is
 * blocked, with the exact prerequisite printed.
 */
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { serve } from "@hono/node-server";
import { KnowledgeEngine, Store, openDb } from "@copilot/knowledge";
import { DEMO_APPS, OpenAdaptEngine, fillTemplate } from "@copilot/workflow";
import { loadProjectEnv, type VerificationContract } from "@copilot/shared";

loadProjectEnv();

import { createApp } from "../../apps/api/src/app.js";
import { seedDemo } from "../../apps/api/src/seed-data.js";
import { startAcmeDesk } from "../../apps/demo/src/apps.js";

/* ---------------------------------------------------------------- */
/* The workflow under test and the ten employee data sets           */
/* ---------------------------------------------------------------- */

/**
 * Every case is a record-creation an employee could plausibly ask for. The
 * spread is deliberate: plain, punctuated, non-ASCII, long, numeric-leading.
 * Those are the inputs that break fuzzy typing and template substitution.
 */
const CASES = [
  { company: "Northwind Freight", email: "ops@northwind.test", note: "plain" },
  { company: "Contoso Logistics", email: "dana@contoso.test", note: "plain" },
  { company: "Fabrikam Rail", email: "ops@fabrikam.test", note: "plain" },
  { company: "O'Rourke Haulage", email: "paddy@orourke.test", note: "apostrophe" },
  { company: "Müller Logistik", email: "kontakt@mueller.test", note: "non-ASCII" },
  { company: "3M Supply Co", email: "buyer@3msupply.test", note: "leading digit" },
  {
    company: "A Very Long Company Name Holdings International",
    email: "long.name+ap@example.test",
    note: "long name, plus-address",
  },
  { company: "Tailspin Toys", email: "sales@tailspin.test", note: "plain" },
  { company: "Wingtip Traders", email: "hello@wingtip.test", note: "plain" },
  { company: "Adventure Works", email: "orders@adventure.test", note: "plain" },
] as const;

const intentFor = (company: string, email: string): string =>
  `Create a customer named "${company}" with contact ${email}`;

/* ---------------------------------------------------------------- */
/* Types                                                            */
/* ---------------------------------------------------------------- */

type FailureCategory =
  | "reasoning"
  | "selector"
  | "timing"
  | "browser_session"
  | "application"
  | "verification"
  | "infrastructure"
  | "unknown";

interface EngineStep {
  index: number;
  step_id: string | null;
  intent: string;
  ok: boolean;
  skipped: boolean;
  rung: string | null;
  postconditions_ok: boolean | null;
  identity_ok: boolean | null;
  risk: string | null;
  error: string | null;
}

interface ApiStep {
  index: number;
  intent: string;
  status: string;
  rung: string | null;
  detail: string | null;
  durationMs: number | null;
}

interface RunRecord {
  run: number;
  company: string;
  email: string;
  note: string;
  intent: string;
  plan: {
    id: string;
    skillId: string | null;
    method: string;
    confidence: number | null;
    modelCalls: number;
    resolvedInputs: Record<string, string | null>;
    blockers: string[];
    requiresApproval: boolean;
  } | null;
  planHttp: number;
  planMs: number;
  planError: string | null;
  execHttp: number;
  execMs: number;
  executionId: string | null;
  outcome: string | null;
  status: string | null;
  message: string | null;
  engineOutcome: string | null;
  apiSteps: ApiStep[];
  engine: {
    success: boolean;
    executionOutcome: string | null;
    transactionOutcome: string | null;
    haltReason: string | null;
    haltIntent: string | null;
    rungCounts: Record<string, number>;
    healCount: number;
    modelCalls: number;
    totalMs: number;
    results: EngineStep[];
    reportExists: boolean;
  } | null;
  verification: {
    passed: boolean;
    tier: string;
    detail: string;
    source: string;
    expected: Record<string, unknown>;
    observed: Record<string, unknown> | null;
  } | null;
  readback: { url: string; http: number; count: number; items: unknown[] } | null;
  traces: string[];
  success: boolean;
  engineClean: boolean;
  stepsOk: number;
  stepsTotal: number;
  unattributedMs: number;
  failure: { category: FailureCategory; evidence: string } | null;
}

interface ProbeRecord extends Omit<RunRecord, "run" | "note"> {
  probe: string;
  injectedIn: string;
  expectedOutcome: string;
  expectedOrigin: FailureCategory;
  outcomeMatched: boolean;
}

/* ---------------------------------------------------------------- */
/* Small helpers                                                    */
/* ---------------------------------------------------------------- */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const artifactRoot = path.resolve(process.env.COPILOT_ARTIFACTS ?? ".copilot-data");
const runRoot = path.join(artifactRoot, "m0", stamp);
const traceDir = path.join(runRoot, "traces");
const shimDir = path.resolve("scripts/m0/playwright-trace-shim");
const apiPort = Number(process.env.M0_API_PORT ?? 4110);
const apiBase = `http://127.0.0.1:${apiPort}`;

/** Time-box each execution: no run may hang the baseline. */
const ENGINE_BUDGET_MS = Number(process.env.M0_ENGINE_TIMEOUT_MS ?? 120_000);

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

async function api<T = any>(
  method: string,
  route: string,
  options: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const response = await fetch(`${apiBase}${route}`, {
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

/**
 * The trace archive written by the replay that started at `fromMs`. One
 * execution starts one browser, so the newest archive in the window is the
 * run's; older archives belong to an earlier run.
 */
async function traceForWindow(fromMs: number, toMs: number): Promise<string[]> {
  const names = await readdir(traceDir).catch(() => [] as string[]);
  const candidates: { file: string; mtimeMs: number }[] = [];
  for (const name of names) {
    if (!name.endsWith(".zip")) continue;
    const info = await stat(path.join(traceDir, name)).catch(() => null);
    if (!info) continue;
    if (info.mtimeMs >= fromMs && info.mtimeMs <= toMs + 10_000) {
      candidates.push({ file: path.join(traceDir, name), mtimeMs: info.mtimeMs });
    }
  }
  candidates.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return candidates.length > 0 ? [candidates[candidates.length - 1]!.file] : [];
}

/* ---------------------------------------------------------------- */
/* Failure classification (rule-based, evidence kept)               */
/* ---------------------------------------------------------------- */

function classify(run: RunRecord, skillId: string): { category: FailureCategory; evidence: string } | null {
  if (run.success) return null;

  const plan = run.plan;
  if (!plan) {
    const infra = run.planHttp >= 500 || run.planHttp === 0;
    return {
      category: infra ? "infrastructure" : "reasoning",
      evidence: `plan request HTTP ${run.planHttp}: ${run.planError ?? "no plan returned"}`,
    };
  }
  if (plan.skillId !== skillId) {
    return {
      category: "reasoning",
      evidence: `planner selected skill ${plan.skillId ?? "null"} instead of ${skillId}`,
    };
  }
  const missing = Object.entries(plan.resolvedInputs)
    .filter(([, value]) => value === null || value === undefined)
    .map(([name]) => name);
  if (missing.length > 0 || plan.blockers.length > 0) {
    return {
      category: "reasoning",
      evidence: `missing inputs=${JSON.stringify(missing)} blockers=${JSON.stringify(plan.blockers)}`,
    };
  }

  const engineText = [
    run.message ?? "",
    run.engine?.haltReason ?? "",
    ...(run.engine?.results ?? []).map((r) => `${r.intent}: ${r.error ?? ""}`),
    ...run.apiSteps.map((s) => `${s.intent}: ${s.detail ?? ""}`),
    run.verification?.detail ?? "",
  ]
    .join(" | ")
    .toLowerCase();

  if (run.message && /already exists|precheck/i.test(run.message)) {
    return { category: "verification", evidence: run.message };
  }
  if (run.verification && run.verification.passed === false && run.engineClean) {
    return {
      category: "verification",
      evidence: `engine reported every step ok, read-back found no record: ${run.verification.detail}`,
    };
  }
  if (/timed out|timeout|deadline/.test(engineText)) {
    return { category: "timing", evidence: run.message ?? "engine timeout" };
  }
  if (/targetclosed|browser.*closed|context was destroyed|net::err|launch|crash/.test(engineText)) {
    return { category: "browser_session", evidence: run.message ?? "browser closed" };
  }
  if (/selector|locator|not found|no bounding box|not visible|missing control|element/.test(engineText)) {
    return { category: "selector", evidence: run.message ?? "control not resolved" };
  }
  if (/http 4\d\d|http 5\d\d|rejected|422|409|validation/.test(engineText)) {
    return { category: "application", evidence: run.message ?? "application rejected the write" };
  }
  if (/econnrefused|connection refused|database|pg|fetch failed/.test(engineText)) {
    return { category: "infrastructure", evidence: run.message ?? "dependency unreachable" };
  }
  return { category: "unknown", evidence: run.message ?? "unclassified failure" };
}

/* ---------------------------------------------------------------- */
/* One end-to-end execution through the real employee path          */
/* ---------------------------------------------------------------- */

interface CaseContext {
  employeeToken: string;
  skillId: string;
  workflowStepCount: number;
  verification: VerificationContract;
}

async function runCase(
  index: number,
  testCase: { company: string; email: string; note: string },
  context: CaseContext,
): Promise<RunRecord> {
  const intent = intentFor(testCase.company, testCase.email);
  const planStart = Date.now();
  const planResponse = await api<any>("POST", "/api/plans", {
    token: context.employeeToken,
    body: { intent },
  });
  const planMs = Date.now() - planStart;
  const planBody = planResponse.body?.plan ?? null;
  const resolvedInputs = Object.fromEntries(
    (planBody?.resolvedInputs ?? []).map((i: any) => [i.name, i.value]),
  );

  let execHttp = 0;
  let execBody: any = null;
  let execStart = Date.now();
  if (planBody?.id) {
    execStart = Date.now();
    const execution = await api<any>("POST", "/api/executions", {
      token: context.employeeToken,
      body: { planId: planBody.id, inputs: {}, approved: true },
    });
    execHttp = execution.status;
    execBody = execution.body;
  }
  const execMs = Date.now() - execStart;

  // Engine report: per-step evidence straight from the replay run.
  let engineSummary: RunRecord["engine"] = null;
  const reportPath = execBody?.engineReportPath as string | null | undefined;
  if (reportPath) {
    try {
      const report = JSON.parse(await readFile(reportPath, "utf8"));
      const results: EngineStep[] = (report.results ?? []).map((item: any, i: number) => ({
        index: i,
        step_id: item.step_id ?? null,
        intent: item.intent ?? "",
        ok: Boolean(item.ok),
        skipped: Boolean(item.skipped),
        rung: item.resolution?.rung ?? null,
        postconditions_ok: item.postconditions_ok ?? null,
        identity_ok: item.identity?.ok ?? null,
        risk: item.risk ?? null,
        error: item.error ?? null,
      }));
      engineSummary = {
        success: Boolean(report.success),
        executionOutcome: report.execution_outcome ?? null,
        transactionOutcome: report.transaction_outcome ?? null,
        haltReason: report.halt?.reason ?? null,
        haltIntent: report.halt?.intent ?? null,
        rungCounts: report.rung_counts ?? {},
        healCount: report.heal_count ?? 0,
        modelCalls: report.model_calls ?? 0,
        totalMs: report.total_ms ?? 0,
        results,
        reportExists: true,
      };
    } catch (error) {
      engineSummary = {
        success: false,
        executionOutcome: null,
        transactionOutcome: null,
        haltReason: `report unreadable: ${error instanceof Error ? error.message : String(error)}`,
        haltIntent: null,
        rungCounts: {},
        healCount: 0,
        modelCalls: 0,
        totalMs: 0,
        results: [],
        reportExists: false,
      };
    }
  }

  // Out-of-band read-back: the app's own HTTP API, not the copilot's oracle.
  const readbackUrl = fillTemplate(context.verification.url, {
    company_name: testCase.company,
    email: testCase.email,
  });
  let readback: RunRecord["readback"] = null;
  try {
    const response = await fetch(readbackUrl);
    const payload = (await response.json()) as any;
    const items = Array.isArray(payload?.items) ? payload.items : [];
    readback = { url: readbackUrl, http: response.status, count: items.length, items };
  } catch (error) {
    readback = {
      url: readbackUrl,
      http: 0,
      count: 0,
      items: [error instanceof Error ? error.message : String(error)],
    };
  }

  const apiSteps: ApiStep[] = (execBody?.steps ?? []).map((s: any) => ({
    index: s.index,
    intent: s.intent,
    status: s.status,
    rung: s.rung ?? null,
    detail: s.detail ?? null,
    durationMs: s.durationMs ?? null,
  }));
  const verificationResult = execBody?.verification ?? null;
  const success = execBody?.outcome === "VERIFIED";
  const engineClean =
    Boolean(engineSummary?.success) &&
    !engineSummary?.haltReason &&
    (engineSummary?.results ?? []).every((r) => r.ok || r.skipped);

  const record: RunRecord = {
    run: index,
    company: testCase.company,
    email: testCase.email,
    note: testCase.note,
    intent,
    plan: planBody
      ? {
          id: planBody.id,
          skillId: planBody.skillId ?? null,
          method: planResponse.body?.method ?? "unknown",
          confidence: planBody.confidence ?? null,
          modelCalls: planResponse.body?.modelCalls ?? 0,
          resolvedInputs,
          blockers: planBody.blockers ?? [],
          requiresApproval: Boolean(planBody.requiresApproval),
        }
      : null,
    planHttp: planResponse.status,
    planMs,
    planError: planResponse.body?.error?.message ?? null,
    execHttp,
    execMs,
    executionId: execBody?.id ?? null,
    outcome: execBody?.outcome ?? null,
    status: execBody?.status ?? null,
    message: execBody?.message ?? null,
    engineOutcome: execBody?.engineOutcome ?? null,
    apiSteps,
    engine: engineSummary,
    verification: verificationResult
      ? {
          passed: Boolean(verificationResult.passed),
          tier: verificationResult.tier ?? "unknown",
          detail: verificationResult.detail ?? "",
          source: verificationResult.source ?? "",
          expected: verificationResult.expected ?? {},
          observed: verificationResult.observed ?? null,
        }
      : null,
    readback,
    traces: await traceForWindow(execStart, Date.now()),
    success,
    engineClean,
    stepsOk: apiSteps.filter((s) => s.status === "ok").length,
    stepsTotal: apiSteps.length || context.workflowStepCount,
    unattributedMs: Math.max(0, execMs - (engineSummary?.totalMs ?? 0)),
    failure: null,
  };
  record.failure = classify(record, context.skillId);
  return record;
}

/* ---------------------------------------------------------------- */
/* Main                                                             */
/* ---------------------------------------------------------------- */

async function main(): Promise<number> {
  await mkdir(traceDir, { recursive: true });
  await mkdir(path.join(runRoot, "demo"), { recursive: true });

  // Diagnostic tracing reaches the bridge through this process's environment,
  // because the adapter spawns the bridge with `{...process.env}`.
  process.env.M0_TRACE_DIR = traceDir;
  process.env.PYTHONPATH = [shimDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  // Keep the shim from leaving __pycache__ in the source tree.
  process.env.PYTHONDONTWRITEBYTECODE = "1";
  process.env.ENGINE_TIMEOUT_MS = String(ENGINE_BUDGET_MS);
  if (!process.env.PYTHON_BIN) {
    process.env.PYTHON_BIN = path.resolve(
      process.platform === "win32" ? ".venv-flow/Scripts/python.exe" : ".venv-flow/bin/python",
    );
  }

  const demo = DEMO_APPS[0]!;
  const appPort = Number(new URL(demo.baseUrl).port);
  const demoApp = await startAcmeDesk({
    port: appPort,
    dataDir: path.join(runRoot, "demo"),
  });
  console.log(`application under test: ${demoApp.name} ${demoApp.url}`);

  const sql = await openDb({ dataDir: path.join(runRoot, "pg") });
  const store = new Store(sql);
  const knowledge = new KnowledgeEngine(store);
  const engine = new OpenAdaptEngine();
  const app = createApp({ store, engine, knowledge, artifactRoot: runRoot });
  const server = serve({ fetch: app.fetch, port: apiPort });
  await sleep(200);

  const runs: RunRecord[] = [];
  const probes: ProbeRecord[] = [];

  try {
    section("0. Environment");
    const capabilities = await api<any>("GET", "/api/capabilities");
    const engineAvailable = Boolean(capabilities.body?.engine?.available);
    console.log(
      `engine=${capabilities.body?.engine?.detail ?? "unknown"} llm=${capabilities.body?.llm?.status}/${capabilities.body?.llm?.provider ?? "-"} model=${capabilities.body?.llm?.model ?? "-"}`,
    );
    if (!engineAvailable) {
      console.log("\nBLOCKED: the OpenAdapt engine is not usable on this machine.");
      console.log('Install: .venv-flow/Scripts/python.exe -m pip install -e "research/OpenAdapt/packages/flow[browser]"');
      await writeEvidence({ blocked: "engine unavailable", capabilities: capabilities.body, runs: [], probes: [] });
      return 2;
    }

    const world = await seedDemo(store, knowledge);
    section("1. Learn the workflow (one recording, admin approval)");
    const adminToken = await login("acme-demo", world.users.admin);
    const employeeToken = await login("acme-demo", world.users.employee);
    const application = world.applications[0]!.application;

    const recording = await api<any>("POST", "/api/recordings", {
      token: adminToken,
      body: { applicationId: application.id, mode: "scripted" },
    });
    console.log(
      `  recording ${recording.body?.id} HTTP ${recording.status} (driver: scripted stand-in, NOT a human demonstration)`,
    );
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
      console.log(
        `BLOCKED: recording did not compile (status=${compiled?.recording?.status}, error=${compiled?.recording?.error ?? "unknown"})`,
      );
      await writeEvidence({ blocked: "recording did not compile", recording: compiled ?? null, runs: [], probes: [] });
      return 2;
    }
    const workflow = compiled.workflow;
    console.log(`  compiled workflow ${workflow.id}: ${workflow.steps.length} steps`);

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
    const skill = approval.body?.skill;
    if (approval.status !== 201 || !skill) {
      console.log(`BLOCKED: approval failed HTTP ${approval.status}: ${JSON.stringify(approval.body?.error ?? {})}`);
      await writeEvidence({ blocked: "approval failed", approval: approval.body, runs: [], probes: [] });
      return 2;
    }
    console.log(
      `  approved skill ${skill.id} (${skill.status}); inputs=${(skill.requiredInputs ?? []).map((i: any) => i.name).join(",")}`,
    );
    console.log(`  verification: ${verification.url} expect=${JSON.stringify(verification.expect)} match=${verification.match}`);

    const context: CaseContext = {
      employeeToken,
      skillId: skill.id,
      workflowStepCount: workflow.steps.length,
      verification,
    };

    section("2. Ten independent executions with different employee data");
    for (const [index, testCase] of CASES.entries()) {
      const record = await runCase(index + 1, testCase, context);
      runs.push(record);
      console.log(
        [
          `run ${String(record.run).padStart(2, "0")}`,
          record.success ? "VERIFIED" : `FAILED(${record.outcome ?? "no execution"})`,
          `plan=${record.plan?.method ?? "-"}/${record.planMs}ms`,
          `exec=${record.execMs}ms engine=${Math.round(record.engine?.totalMs ?? 0)}ms gap=${record.unattributedMs}ms`,
          `steps=${record.stepsOk}/${record.stepsTotal}`,
          `engine=${record.engine ? (record.engineClean ? "clean" : record.engine.haltReason ? `halt:${record.engine.haltReason}` : "unclean") : "none"}`,
          `verify=${record.verification?.passed ? "PASS" : "FAIL"}`,
          `readback=${record.readback?.count ?? "-"}`,
          `trace=${record.traces.length}`,
          record.failure ? `cause=${record.failure.category}` : "",
          testCase.note,
        ]
          .filter(Boolean)
          .join("  "),
      );
      if (!record.success) {
        console.log(`        message: ${record.message ?? "none"}`);
        console.log(`        verification: ${record.verification?.detail ?? "none"}`);
      }
    }

    /* ------------------------------------------------------------ */
    /* Instrument validation: the harness must be able to fail.      */
    /* ------------------------------------------------------------ */

    section("3. Fault probes (instrument validation, app fault switch only)");
    const setFault = async (mode: string): Promise<void> => {
      await fetch(`${demoApp.url}/api/faults`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode }),
      });
    };

    const probeSpecs = [
      {
        probe: "duplicate-data",
        company: CASES[0].company,
        email: CASES[0].email,
        expectedOutcome: "REJECTED",
        expectedOrigin: "verification" as FailureCategory,
        injectedIn: "application data: the record created by run 01 already exists",
        fault: "none",
      },
      {
        probe: "rejected-write",
        company: "Fabrikam Refused",
        email: "ops@fabrikam-refused.test",
        expectedOutcome: "FAILED",
        expectedOrigin: "application" as FailureCategory,
        injectedIn: "application fault reject-create (HTTP 500, nothing persisted)",
        fault: "reject-create",
      },
      {
        probe: "missing-control",
        company: "Fabrikam No Control",
        email: "ops@fabrikam-nocontrol.test",
        expectedOutcome: "FAILED",
        expectedOrigin: "selector" as FailureCategory,
        injectedIn: "application fault missing-control (save button removed from the page)",
        fault: "missing-control",
      },
    ];

    for (const [index, spec] of probeSpecs.entries()) {
      await setFault(spec.fault);
      const base = await runCase(100 + index, { company: spec.company, email: spec.email, note: spec.probe }, context);
      await setFault("none");
      const probeRecord: ProbeRecord = {
        ...base,
        probe: spec.probe,
        injectedIn: spec.injectedIn,
        expectedOutcome: spec.expectedOutcome,
        expectedOrigin: spec.expectedOrigin,
        outcomeMatched: base.outcome === spec.expectedOutcome,
      };
      probes.push(probeRecord);
      console.log(
        [
          `probe ${spec.probe}`,
          `outcome=${base.outcome ?? "none"} expected=${spec.expectedOutcome} ${probeRecord.outcomeMatched ? "MATCH" : "MISMATCH"}`,
          `detected=${base.failure?.category ?? "none"} expectedOrigin=${spec.expectedOrigin}`,
          `verify=${base.verification?.passed ? "PASS" : "FAIL"}`,
          `readback=${base.readback?.count ?? "-"}`,
          `trace=${base.traces.length}`,
        ].join("  "),
      );
      console.log(`        message: ${(base.message ?? "none").slice(0, 220)}`);
    }

    section("4. Result");
    const successes = runs.filter((r) => r.success).length;
    const engineCleanRuns = runs.filter((r) => r.engineClean).length;
    const categories: Record<string, number> = {};
    for (const run of runs) {
      if (run.failure) categories[run.failure.category] = (categories[run.failure.category] ?? 0) + 1;
    }
    const durations = runs.map((r) => r.execMs).sort((a, b) => a - b);
    const median = durations[Math.floor(durations.length / 2)] ?? 0;
    const avgExecMs = Math.round(runs.reduce((sum, r) => sum + r.execMs, 0) / Math.max(runs.length, 1));
    const engineTimes = runs.map((r) => r.engine?.totalMs ?? 0).sort((a, b) => a - b);
    const engineMedian = Math.round(engineTimes[Math.floor(engineTimes.length / 2)] ?? 0);
    const stepsWithDuration = runs
      .flatMap((r) => r.apiSteps)
      .filter((s) => s.durationMs !== null).length;
    const typeStepsWithoutPostcondition = runs
      .flatMap((r) => r.engine?.results ?? [])
      .filter((s) => s.intent.startsWith("type") && s.postconditions_ok === null).length;

    console.log(
      `business success: ${successes}/${runs.length} (${((successes / Math.max(runs.length, 1)) * 100).toFixed(0)}%)`,
    );
    console.log(`engine-clean runs: ${engineCleanRuns}/${runs.length} (no halt, every step ok)`);
    console.log(
      `exec latency: median ${median}ms, mean ${avgExecMs}ms, min ${durations[0] ?? 0}ms, max ${durations[durations.length - 1] ?? 0}ms; engine-reported median ${engineMedian}ms`,
    );
    console.log(`failure categories: ${JSON.stringify(categories)}`);
    console.log(
      `instrument validation: ${probes.filter((p) => p.outcomeMatched).length}/${probes.length} probes produced the expected outcome`,
    );
    console.log(
      `observability: ${stepsWithDuration} of ${runs.flatMap((r) => r.apiSteps).length} step rows carry a duration; ${typeStepsWithoutPostcondition} type steps report no postcondition`,
    );
    console.log(`traces: ${runs.concat(probes as any).reduce((n, r) => n + r.traces.length, 0)} file(s) in ${traceDir}`);

    await writeEvidence({
      blocked: false,
      application: demo.name,
      applicationUrl: demoApp.url,
      workflow: { id: workflow.id, name: demo.workflowName, steps: workflow.steps.length },
      skill: { id: skill.id, inputs: (skill.requiredInputs ?? []).map((i: any) => i.name) },
      recordingDriver: "scripted stand-in (no human at this machine)",
      capabilities: capabilities.body,
      engineBudgetMs: ENGINE_BUDGET_MS,
      runs,
      probes,
      summary: {
        runs: runs.length,
        businessSuccess: successes,
        successRate: successes / Math.max(runs.length, 1),
        engineCleanRuns,
        failureCategories: categories,
        execMs: { median, mean: avgExecMs, min: durations[0] ?? 0, max: durations[durations.length - 1] ?? 0 },
        engineMedianMs: engineMedian,
        probesMatched: probes.filter((p) => p.outcomeMatched).length,
        probes: probes.length,
        stepRows: runs.flatMap((r) => r.apiSteps).length,
        stepRowsWithDuration: stepsWithDuration,
        typeStepsWithoutPostcondition,
      },
    });
    return 0;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await sql.close();
    await demoApp.close();
  }
}

async function writeEvidence(payload: Record<string, unknown>): Promise<void> {
  const file = path.join(runRoot, "evidence.json");
  await writeFile(file, JSON.stringify({ runAt: new Date().toISOString(), ...payload }, null, 2));
  console.log(`\nevidence: ${file}`);
}

main()
  .then((code) => process.exit(code))
  .catch(async (error) => {
    console.error(`\nBASELINE ERROR: ${error instanceof Error ? error.stack : String(error)}`);
    await writeEvidence({ blocked: false, error: String(error) }).catch(() => {});
    process.exit(1);
  });
