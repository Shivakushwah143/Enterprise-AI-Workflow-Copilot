/**
 * Extension verification: load the built MV3 extension into a real Chromium
 * session, drive its side panel, and check that what it shows comes from the
 * running API (capabilities, application context, plan, execution result).
 *
 *   pnpm build:extension
 *   pnpm demo:scenarios        # produces a compiled bundle to re-use
 *   pnpm verify:extension
 *
 * The side panel is opened as its own extension page (`sidepanel.html`), which
 * is the same UI Chrome shows in the side panel. Everything it reads comes from
 * http://127.0.0.1:4000, the API started by this script.
 */
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { serve } from "@hono/node-server";
import { KnowledgeEngine, Store, openDb } from "@copilot/knowledge";
import { DEMO_APPS, inspectBundle, OpenAdaptEngine } from "@copilot/workflow";
import type { VerificationContract } from "@copilot/shared";
import { createApp } from "../apps/api/src/app.js";
import { seedDemo } from "../apps/api/src/seed-data.js";
import { startAcmeDesk, startStockDesk } from "../apps/demo/src/apps.js";

const results: { name: string; ok: boolean; detail: string }[] = [];
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function check(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n      ${detail}`);
}

const root = process.cwd();
const extensionDir = path.join(root, "apps", "extension", ".output", "chrome-mv3");
const runRoot = path.join(root, ".copilot-data", "extension-check");
const apiPort = 4000;
const apiBase = `http://127.0.0.1:${apiPort}`;
const crm = DEMO_APPS[0]!;

/** Newest compiled bundle from a scenario run, if there is one. */
async function newestBundle(): Promise<string | null> {
  const scenarios = path.join(root, ".copilot-data", "scenarios");
  let runs: string[];
  try {
    runs = (await readdir(scenarios)).sort().reverse();
  } catch {
    return null;
  }
  for (const run of runs) {
    const recordings = path.join(scenarios, run, "recordings");
    let entries: string[];
    try {
      entries = await readdir(recordings);
    } catch {
      continue;
    }
    for (const entry of entries.filter((e) => e.endsWith("-bundle")).reverse()) {
      const bundle = path.join(recordings, entry);
      try {
        await readdir(bundle);
        return bundle;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

async function main(): Promise<number> {
  try {
    await readdir(extensionDir);
  } catch {
    console.error(`No built extension at ${extensionDir}. Run: pnpm build:extension`);
    return 2;
  }

  await rm(runRoot, { recursive: true, force: true });
  await mkdir(runRoot, { recursive: true });

  const crmApp = await startAcmeDesk({ port: Number(new URL(crm.baseUrl).port), dataDir: path.join(runRoot, "demo") });
  const stockApp = await startStockDesk({
    port: Number(new URL(DEMO_APPS[1]!.baseUrl).port),
    dataDir: path.join(runRoot, "demo"),
  });

  const sql = await openDb({ dataDir: path.join(runRoot, "pg") });
  const store = new Store(sql);
  const knowledge = new KnowledgeEngine(store);
  const engine = new OpenAdaptEngine();
  const app = createApp({ store, engine, knowledge, artifactRoot: runRoot });
  const server = serve({ fetch: app.fetch, port: apiPort });
  await sleep(200);

  let context: BrowserContext | null = null;
  try {
    const world = await seedDemo(store, knowledge);

    // Re-use a real compiled bundle so the UI can plan and execute for real.
    const bundlePath = await newestBundle();
    let skillId: string | null = null;
    if (bundlePath) {
      const inspected = await inspectBundle(bundlePath);
      const workflow = await store.createWorkflow({
        tenantId: world.demoTenantId,
        applicationId: world.applications[0]!.application.id,
        name: inspected.name,
        description: "Learned from a recorded demonstration.",
        bundlePath,
        recordingId: null,
        steps: inspected.steps,
        uncertainty: inspected.uncertainty,
      });
      await store.setWorkflowStatus(world.demoTenantId, workflow.id, "approved");
      const verification: VerificationContract = {
        kind: "http",
        tier: "system_of_record",
        url: crm.verification.url,
        recordPath: crm.verification.recordPath,
        expect: crm.verification.expect,
        match: crm.verification.match,
      };
      const skill = await store.createSkill({
        tenantId: world.demoTenantId,
        workflowId: workflow.id,
        name: crm.workflowName,
        description: crm.description,
        requiredInputs: inspected.params,
        triggeredBy: crm.triggers,
        verification,
        approvedBy: "admin@acme.test",
      });
      skillId = skill.id;
      console.log(`seeded skill ${skillId} from ${bundlePath}`);
    } else {
      console.log("No compiled bundle found; the plan/execute checks will be skipped.");
    }

    await mkdir(path.join(runRoot, "shots"), { recursive: true });
    const userDataDir = path.join(runRoot, "chrome-profile");
    const launch = async (headless: boolean): Promise<BrowserContext> =>
      chromium.launchPersistentContext(userDataDir, {
        headless,
        args: [
          `--disable-extensions-except=${extensionDir}`,
          `--load-extension=${extensionDir}`,
          "--no-first-run",
        ],
      });

    const waitForWorker = async (ctx: BrowserContext): Promise<string | null> => {
      const existing = ctx.serviceWorkers()[0];
      if (existing) return new URL(existing.url()).host;
      const worker = await ctx.waitForEvent("serviceworker", { timeout: 15_000 }).catch(() => null);
      return worker ? new URL(worker.url()).host : null;
    };

    context = await launch(true);
    let extensionId = await waitForWorker(context);
    if (!extensionId) {
      console.log("      headless Chromium did not start the extension worker; retrying headed.");
      await context.close();
      context = await launch(false);
      extensionId = await waitForWorker(context);
    }
    check(
      "Chromium loads the built extension",
      Boolean(extensionId),
      extensionId ? `extension id ${extensionId}` : "no service worker appeared",
    );
    if (!extensionId) throw new Error("the extension did not load");

    // A real page in another tab: this is what the side panel inspects.
    const appPage: Page = await context.newPage();
    await appPage.goto(`${crm.baseUrl}/`, { waitUntil: "load" });

    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`, { waitUntil: "load" });

    await panel.fill('[data-testid="api-base"]', apiBase);
    await panel.fill('[data-testid="login-tenant"]', "acme-demo");
    await panel.fill('[data-testid="login-email"]', "admin@acme.test");
    await panel.click('[data-testid="login-submit"]');

    await panel.waitForSelector('[data-testid="connection-status"]', { timeout: 15_000 });
    const session = await panel.textContent('[data-testid="connection-status"]');
    check("side panel signs in through the API", /admin/.test(session ?? ""), `session: ${session}`);

    await panel.waitForFunction(
      () =>
        document.querySelector('[data-testid="capability-engine"]')?.textContent?.includes(
          "available",
        ) ?? false,
      undefined,
      { timeout: 20_000 },
    );
    const engineBadge = await panel.textContent('[data-testid="capability-engine"]');
    check(
      "capability badge reports the live engine state",
      /available/.test(engineBadge ?? ""),
      engineBadge ?? "",
    );

    await panel.waitForFunction(
      () =>
        document.querySelector('[data-testid="app-context"]')?.textContent?.includes(
          "AcmeDesk CRM",
        ) ?? false,
      undefined,
      { timeout: 20_000 },
    );
    const appContext = await panel.textContent('[data-testid="app-context"]');
    check("context panel names the registered application", true, appContext ?? "");

    await panel.screenshot({ path: path.join(runRoot, "shots", "sidepanel-signed-in.png") });

    // The admin controls for "Learn my app": the real path is interactive, so
    // that must be the default and the parameter fields must be visible.
    if (skillId) {
      const mode = await panel.inputValue('[data-testid="record-mode"]');
      const paramFields = await panel.inputValue('[data-testid="record-param-fields"]');
      const startEnabled = await panel.isEnabled('[data-testid="record-start"]');
      const stopEnabled = await panel.isEnabled('[data-testid="record-stop"]');
      check(
        "the admin panel offers interactive recording with parameter fields",
        mode === "interactive" && paramFields.includes("company_name") && startEnabled && !stopEnabled,
        `mode=${mode} paramFields="${paramFields}" start=${startEnabled} stop=${stopEnabled}`,
      );
    }

    /** Guidance is the only thing the content script does to the page. */
    if (skillId) {
      await panel.click('[data-testid="highlight-current"]');
      await appPage.waitForFunction(
        () => document.documentElement.dataset["copilotHighlighted"] === "#new-customer",
        undefined,
        { timeout: 20_000 },
      );
      const overlay = await appPage.locator(".driver-popover").count();
      const overlayText = overlay ? await appPage.textContent(".driver-popover") : "";
      check(
        "Driver.js highlights the recorded control in the application tab",
        overlay > 0 && (overlayText ?? "").includes("New customer"),
        `overlays=${overlay} text=${(overlayText ?? "").slice(0, 80)}`,
      );
      await appPage.screenshot({ path: path.join(runRoot, "shots", "app-highlighted.png") });

      // Escape must dismiss the overlay so the application stays usable.
      await appPage.keyboard.press("Escape");
      await appPage.waitForFunction(
        () => document.querySelectorAll(".driver-popover").length === 0,
        undefined,
        { timeout: 10_000 },
      );
      const stillBlocked = await appPage.locator(".driver-overlay").count();
      check(
        "the overlay can be dismissed, so application controls stay usable",
        stillBlocked === 0,
        `overlay elements after Escape: ${stillBlocked}`,
      );

      // A changed page state: open the form, then highlight the field that only
      // exists after that click.
      await appPage.click("#new-customer");
      await panel.click('[data-testid="guidance-next"]');
      await appPage.waitForFunction(
        () => document.documentElement.dataset["copilotHighlighted"] === "#customer-name",
        undefined,
        { timeout: 20_000 },
      );
      check(
        "guidance follows a page state that changed after the recording",
        true,
        "highlighted #customer-name after the form opened",
      );
      await appPage.keyboard.press("Escape");

      // A selector that is absent from this page must be reported, never
      // approximated with coordinates.
      await appPage.goto(`${DEMO_APPS[1]!.baseUrl}/`);
      await panel.click('[data-testid="highlight-current"]');
      await panel.waitForFunction(
        () => document.body.textContent?.includes("Could not highlight") === true,
        undefined,
        { timeout: 20_000 },
      );
      const highlightedAfterMiss = await appPage.evaluate(
        () => document.documentElement.dataset["copilotHighlighted"] ?? null,
      );
      check(
        "a missing control is reported instead of highlighted",
        highlightedAfterMiss === null,
        `dataset.copilotHighlighted=${String(highlightedAfterMiss)}`,
      );
      await appPage.goto(`${crm.baseUrl}/`, { waitUntil: "load" });
    }

    /**
     * Plan, approve and execute from the panel, waiting on the API responses
     * rather than on element presence: a previous plan's elements are still on
     * screen, and a stale selector would click into a moving layout.
     */
    const runFromPanel = async (text: string): Promise<string> => {
      await panel.fill('[data-testid="intent-input"]', text);
      const planned = panel.waitForResponse(
        (response) =>
          response.url().endsWith("/api/plans") && response.request().method() === "POST",
        { timeout: 30_000 },
      );
      await panel.click('[data-testid="plan-submit"]');
      await planned;
      await panel.waitForSelector('[data-testid="plan-skill"]', { timeout: 20_000 });

      const checkbox = panel.locator('[data-testid="approval-checkbox"]');
      if (await checkbox.count()) await checkbox.check();
      const executed = panel.waitForResponse(
        (response) =>
          response.url().endsWith("/api/executions") && response.request().method() === "POST",
        { timeout: 180_000 },
      );
      await panel.click('[data-testid="execute-button"]');
      const response = await executed;
      const body = (await response.json()) as { outcome?: string };
      await panel.waitForFunction(
        (expected) =>
          (document.querySelector('[data-testid="execution-outcome"]')?.textContent ?? "").trim() ===
          expected,
        body.outcome,
        { timeout: 30_000 },
      );
      return body.outcome ?? "unknown";
    };

    if (!skillId) {
      console.log("SKIP  plan/execute checks (no compiled bundle available)");
    } else {
      await panel.fill('[data-testid="intent-input"]', 'Create a customer named "Contoso Rail" with contact ops@contoso.test');
      await panel.click('[data-testid="plan-submit"]');
      await panel.waitForSelector('[data-testid="approval-required"]', { timeout: 20_000 });
      const approvalText = await panel.textContent('[data-testid="approval-required"]');
      check(
        "panel demands explicit approval for the irreversible workflow",
        (approvalText ?? "").includes("Approval required"),
        (approvalText ?? "").slice(0, 120),
      );
      const planSkill = await panel.textContent('[data-testid="plan-skill"]');
      check(
        "plan names the approved skill chosen from the request",
        (planSkill ?? "").includes("Create customer"),
        planSkill ?? "",
      );

      const outcome = await runFromPanel(
        `Create a customer named "Contoso Rail ${Date.now().toString().slice(-5)}" with contact ops@contoso.test`,
      );
      check(
        "execution panel shows the verified outcome reported by the API",
        outcome === "VERIFIED",
        `outcome: ${outcome}`,
      );
      const verificationText = await panel.textContent('[data-testid="verification-result"]');
      check(
        "panel shows the system-of-record evidence",
        (verificationText ?? "").includes("PASSED"),
        (verificationText ?? "").slice(0, 160),
      );
      const stepCount = await panel.locator('[data-testid="step-list"] li').count();
      check("panel lists the executed steps", stepCount > 0, `${stepCount} steps`);
      await panel.screenshot({ path: path.join(runRoot, "shots", "sidepanel-verified.png") });

      // Negative path: the application rejects the write. The panel must FAIL.
      await fetch(`${crm.baseUrl}/api/faults`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "reject-create" }),
      });
      const failed = await runFromPanel(
        `Create a customer named "Rejected Ltd ${Date.now().toString().slice(-5)}" with contact ops@rejected.test`,
      );
      check("a rejected write is shown as FAILED in the panel", failed === "FAILED", `outcome: ${failed}`);
      await panel.screenshot({ path: path.join(runRoot, "shots", "sidepanel-failed.png") });
      await fetch(`${crm.baseUrl}/api/faults`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "none" }),
      });
    }

    const failed = results.filter((r) => !r.ok).length;
    console.log(
      `\n${results.length - failed}/${results.length} extension checks passed`,
    );
    await writeFile(
      path.join(runRoot, "evidence.json"),
      JSON.stringify({ runAt: new Date().toISOString(), checks: results }, null, 2),
    );
    console.log(`evidence: ${path.join(runRoot, "evidence.json")}`);
    return failed === 0 ? 0 : 1;
  } finally {
    await context?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await sql.close();
    await crmApp.close();
    await stockApp.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`EXTENSION CHECK ERROR: ${error instanceof Error ? error.stack : String(error)}`);
    process.exit(1);
  });
