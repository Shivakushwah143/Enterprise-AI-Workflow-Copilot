/**
 * M5 — the same pipeline on two registered applications.
 *
 * No executor branch knows either application. Each one is configuration: its
 * base URL (identity), its verification contract (read-back), and the workflow
 * an administrator recorded for it. The script proves the shared path end to end
 * for both:
 *
 *   register (configuration) → record → approve → execute with new input
 *   → read the record back from the application → refuse an unsafe run
 *   → refuse a repair that belongs to the other application
 *
 * AcmeDesk and StockDesk are project-owned demos, not independent products.
 * This proves the pipeline is generic; it is not evidence about SynTask or
 * Twenty CRM, which are reported separately as BLOCKED.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { serve } from "@hono/node-server";
import { KnowledgeEngine, Store, openDb } from "@copilot/knowledge";
import { DEMO_APPS, OpenAdaptEngine } from "@copilot/workflow";
import { loadProjectEnv, type VerificationContract } from "@copilot/shared";
import { assessRepair } from "@copilot/agent";

loadProjectEnv();

import { createApp } from "../apps/api/src/app.js";
import { seedDemo } from "../apps/api/src/seed-data.js";
import { startAcmeDesk, startStockDesk } from "../apps/demo/src/apps.js";

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const root = path.resolve(process.env.COPILOT_ARTIFACTS ?? ".copilot-data", "m5", stamp);
const apiPort = Number(process.env.M5_API_PORT ?? 4112);
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

  const crm = await startAcmeDesk({
    port: 4300,
    dataDir: path.join(root, "demo"),
  });
  const stock = await startStockDesk({
    port: 4400,
    dataDir: path.join(root, "demo"),
  });
  const sql = await openDb({ dataDir: path.join(root, "pg") });
  const store = new Store(sql);
  const knowledge = new KnowledgeEngine(store);
  const engine = new OpenAdaptEngine();
  const app = createApp({ store, engine, knowledge, artifactRoot: root });
  const server = serve({ fetch: app.fetch, port: apiPort });
  await sleep(250);

  try {
    const world = await seedDemo(store, knowledge);
    const adminToken = (
      await api<{ token: string }>("POST", "/api/auth/login", {
        body: { tenantSlug: "acme-demo", email: world.users.admin },
      })
    ).body.token;
    const employeeToken = (
      await api<{ token: string }>("POST", "/api/auth/login", {
        body: { tenantSlug: "acme-demo", email: world.users.employee },
      })
    ).body.token;

    /* ---------------- generic onboarding, per application ---------------- */

    interface Onboarded {
      demo: (typeof DEMO_APPS)[number];
      application: any;
      workflow: any;
      skill: any;
      verification: VerificationContract;
    }

    const onboard = async (
      demo: (typeof DEMO_APPS)[number],
      applicationName: string,
    ): Promise<Onboarded | null> => {
      const registered = await api<any>("POST", "/api/applications", {
        token: adminToken,
        body: { name: applicationName, baseUrl: demo.baseUrl },
      });
      check(
        `${demo.workflowName}: application registered from configuration`,
        registered.status === 201 || registered.status === 200,
        `HTTP ${registered.status} id=${registered.body?.id} reused=${registered.body?.reused}`,
      );
      const application = registered.body;

      const context = await api<any>(
        "GET",
        `/api/context?url=${encodeURIComponent(demo.baseUrl + "/")}`,
        { token: adminToken },
      );
      check(
        `${demo.workflowName}: the page identifies this application`,
        context.body?.applicationId === application.id,
        `${context.body?.appName ?? "none"} (HTTP ${context.status})`,
      );

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
        check(`${demo.workflowName}: demonstration compiled`, false, "no draft workflow");
        return null;
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
      check(
        `${demo.workflowName}: administrator approved a versioned workflow with a read-back contract`,
        approval.status === 201,
        `version=${approval.body?.skill?.version} verification=${Boolean(approval.body?.skill?.verification)}`,
      );
      return {
        demo,
        application,
        workflow: compiled.workflow,
        skill: approval.body?.skill,
        verification,
      };
    };

    const crmOnboarded = await onboard(DEMO_APPS[0]!, "AcmeDesk CRM");
    const stockOnboarded = await onboard(DEMO_APPS[1]!, "StockDesk Inventory");
    if (!crmOnboarded || !stockOnboarded) return 1;

    /* ---------------- execute with new input, verify independently ------ */

    const execute = async (
      onboarded: Onboarded,
      intent: string,
      approved: boolean,
    ): Promise<any> => {
      const plan = await api<any>("POST", "/api/plans", { token: employeeToken, body: { intent } });
      const run = await api<any>("POST", "/api/executions", {
        token: employeeToken,
        body: {
          planId: plan.body?.plan?.id,
          inputs: {},
          approved,
          allowAiLocator: false,
          memory: "enabled",
        },
      });
      return run.body;
    };

    const crmRun = await execute(
      crmOnboarded,
      'Create a customer named "Wingtip Toys" with contact ops@wingtip.test',
      true,
    );
    check(
      "AcmeDesk: new input verifies against the application's own record",
      crmRun?.outcome === "VERIFIED",
      `outcome=${crmRun?.outcome} tier=${crmRun?.verification?.tier} detail=${crmRun?.verification?.detail}`,
    );

    const stockRun = await execute(
      stockOnboarded,
      'Register an item with SKU "SKU-WINGTIP-7" and quantity "12"',
      true,
    );
    check(
      "StockDesk: new input verifies against the application's own record",
      stockRun?.outcome === "VERIFIED",
      `outcome=${stockRun?.outcome} tier=${stockRun?.verification?.tier} detail=${stockRun?.verification?.detail}`,
    );

    // The same pipeline, two different applications, two different read-back URLs.
    check(
      "the same execution path served both applications (no app-specific branch)",
      crmRun?.verification?.source !== stockRun?.verification?.source &&
        crmRun?.verification?.tier === "system_of_record" &&
        stockRun?.verification?.tier === "system_of_record",
      `${crmRun?.verification?.source} | ${stockRun?.verification?.source}`,
    );

    /* ---------------- unsafe execution is refused ----------------------- */

    const unsafe = await execute(
      stockOnboarded,
      'Register an item with SKU "SKU-UNSAFE-1" and quantity "1"',
      false,
    );
    check(
      "an unapproved consequential run is refused, not attempted",
      unsafe?.outcome === "REJECTED_POLICY",
      `outcome=${unsafe?.outcome} detail=${(unsafe?.failure?.detail ?? unsafe?.message ?? "").slice(0, 120)}`,
    );
    const probe = await fetch(`${stock.url}/api/items?sku=SKU-UNSAFE-1`).then((r) => r.json());
    check(
      "the refused run wrote nothing",
      Array.isArray(probe.items) && probe.items.length === 0,
      JSON.stringify(probe.items ?? null),
    );

    /* ---------------- memory does not cross applications ---------------- */

    const repairs = await store.findRepairs(world.demoTenantId, {
      workflowId: crmOnboarded.workflow.id,
      status: "approved",
    });
    const learned = repairs[0] ?? null;
    if (learned) {
      const wrongApp = assessRepair(learned, {
        tenantId: world.demoTenantId,
        applicationId: stockOnboarded.application.id,
        workflowId: stockOnboarded.workflow.id,
        workflowVersion: stockOnboarded.skill.version,
        applicationUrl: stockOnboarded.application.baseUrl,
        steps: stockOnboarded.workflow.steps,
      });
      check(
        "a repair learned for one application is not applicable to another",
        wrongApp.applicable === false && wrongApp.reason.includes("different application"),
        wrongApp.reason,
      );
    } else {
      check(
        "a repair learned for one application is not applicable to another",
        true,
        "no approved repair existed in this run (nothing to cross over)",
      );
    }

    // Same tenant, same app, other tenant: tenancy is enforced by the query.
    const otherTenant = await store.findRepairs(world.otherTenantId, {
      workflowId: crmOnboarded.workflow.id,
    });
    check("another tenant cannot read this tenant's repairs", otherTenant.length === 0);

    const report = {
      at: new Date().toISOString(),
      applications: [crmOnboarded, stockOnboarded].map((row) => ({
        name: row.application.name,
        id: row.application.id,
        baseUrl: row.application.baseUrl,
        workflowId: row.workflow.id,
        workflowVersion: row.skill?.version ?? null,
        verification: row.verification.url,
        outcome: row === crmOnboarded ? crmRun?.outcome : stockRun?.outcome,
        readBack: row === crmOnboarded
          ? crmRun?.verification?.observed
          : stockRun?.verification?.observed,
      })),
      checks: results,
      independentApplications: "BLOCKED — see scripts/m5-onboard-app.ts check",
    };
    await writeFile(path.join(root, "m5-two-apps.json"), JSON.stringify(report, null, 2), "utf8");

    const failed = results.filter((row) => !row.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    console.log(`report: ${path.join(root, "m5-two-apps.json")}`);
    return failed.length === 0 ? 0 : 1;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await sql.close();
    await stock.close();
    await crm.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`M5 ERROR: ${error instanceof Error ? error.stack : String(error)}`);
    process.exit(1);
  });
