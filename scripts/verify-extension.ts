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
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { serve } from "@hono/node-server";
import { KnowledgeEngine, Store, openDb } from "@copilot/knowledge";
import { DEMO_APPS, inspectBundle, OpenAdaptEngine } from "@copilot/workflow";
import { loadProjectEnv, type VerificationContract } from "@copilot/shared";
import { createApp } from "../apps/api/src/app.js";
import { seedDemo } from "../apps/api/src/seed-data.js";
import { startAcmeDesk, startStockDesk } from "../apps/demo/src/apps.js";

loadProjectEnv();

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
    // The newest run has a bundle per application. This check drives AcmeDesk
    // CRM, so pick the bundle whose steps are the customer workflow - taking the
    // newest bundle blindly can hand the CRM skill StockDesk selectors.
    for (const entry of entries.filter((e) => e.endsWith("-bundle")).reverse()) {
      const bundle = path.join(recordings, entry);
      try {
        await readdir(bundle);
      } catch {
        continue;
      }
      try {
        const inspected = await inspectBundle(bundle);
        const text = [
          inspected.name,
          ...inspected.steps.map((step) => `${step.intent} ${step.elementName ?? ""}`),
        ]
          .join(" ")
          .toLowerCase();
        if (text.includes("customer")) return bundle;
      } catch {
        /* an unreadable bundle is not a candidate */
      }
    }
  }
  return null;
}

/**
 * The built extension is served to any page the user visits, so a credential in
 * it is a credential published. WXT inlines only `WXT_`/`VITE_`-prefixed values,
 * and this check proves that on the actual artifact rather than by assumption.
 */
async function scanBundleForSecrets(dir: string): Promise<string[]> {
  const leaks: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!/\.(js|mjs|json|html|css)$/.test(entry.name)) continue;
      const text = await readFile(full, "utf8");
      for (const pattern of [/gsk_[A-Za-z0-9]{10,}/, /GROQ_API_KEY/, /DATABASE_URL/, /postgres:\/\//]) {
        if (pattern.test(text)) leaks.push(`${path.relative(dir, full)} matches ${pattern}`);
      }
    }
  };
  await walk(dir);
  return leaks;
}

async function main(): Promise<number> {
  try {
    await readdir(extensionDir);
  } catch {
    console.error(`No built extension at ${extensionDir}. Run: pnpm build:extension`);
    return 2;
  }

  const leaks = await scanBundleForSecrets(extensionDir);
  check(
    "the built extension contains no credentials or database URL",
    leaks.length === 0,
    leaks.length ? leaks.join("; ") : "scanned every bundled js/json/html file",
  );

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

    // Execution mode is stated, and switching it is an explicit user action.
    const defaultMode = await panel.inputValue('[data-testid="mode-select"]');
    const defaultLabel = await panel.textContent('[data-testid="execution-mode"]');
    check(
      "the panel names the active execution mode and its browser context",
      defaultMode === "autonomous" &&
        (defaultLabel ?? "").includes("Autonomous") &&
        (defaultLabel ?? "").includes("Controlled browser session"),
      `mode=${defaultMode} label=${defaultLabel}`,
    );
    await panel.selectOption('[data-testid="mode-select"]', "guided");
    const guidedLabel = await panel.textContent('[data-testid="execution-mode"]');
    const guidedNote = await panel.textContent('[data-testid="execution-mode-detail"]');
    check(
      "guided mode says it uses the current tab and never claims to act",
      (guidedLabel ?? "").includes("Guided") &&
        (guidedLabel ?? "").includes("Current browser tab") &&
        (guidedNote ?? "").includes("never acts for you"),
      `label=${guidedLabel} detail=${(guidedNote ?? "").slice(0, 90)}`,
    );
    await panel.selectOption('[data-testid="mode-select"]', "autonomous");

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
      try {
        await appPage.waitForFunction(
          () => document.documentElement.dataset["copilotHighlighted"] === "#new-customer",
          undefined,
          { timeout: 20_000 },
        );
      } catch (error) {
        const note = await panel.textContent('[data-testid="guidance-note"]').catch(() => "");
        throw new Error(
          `the highlight did not reach the application tab; panel note: ${note ?? "none"} (${(error as Error).message.split("\n")[0]})`,
        );
      }
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

      // Guided mode verifies the recorded control is really on the page. This
      // is observation only: the content script never acts on the page.
      await panel.selectOption('[data-testid="mode-select"]', "guided");
      // Step 1 was the field that only exists after the form opens; return to
      // the first recorded step, whose control is on the landing page.
      await panel.click('[data-testid="guidance-prev"]');
      await panel.click('[data-testid="highlight-current"]');
      await appPage.waitForFunction(
        () => document.documentElement.dataset["copilotHighlighted"] === "#new-customer",
        undefined,
        { timeout: 20_000 },
      );
      await panel.click('[data-testid="guidance-verify"]');
      await panel.waitForSelector('[data-testid="guidance-verified"]', { timeout: 15_000 });
      const verifiedText = await panel.textContent('[data-testid="guidance-verified"]');
      check(
        "guided mode verifies the recorded control in the page it is showing",
        (verifiedText ?? "").includes("visible"),
        `verify=\"${(verifiedText ?? "").slice(0, 90)}\"`,
      );
      await appPage.keyboard.press("Escape");
      await panel.selectOption('[data-testid="mode-select"]', "autonomous");
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

      // The pre-flight shows what the controlled session would do, before it
      // runs: target, skill, inputs, requested actions, impact and session type.
      const preflight = await panel.textContent('[data-testid="autonomous-preflight"]');
      const sessionType = await panel.textContent('[data-testid="session-type"]');
      const sessionActions = await panel.textContent('[data-testid="session-actions"]');
      check(
        "autonomous pre-flight names the target, skill, actions and session type",
        (preflight ?? "").includes("Create customer") &&
          (preflight ?? "").includes("AcmeDesk CRM") &&
          (sessionType ?? "").includes("Controlled browser session") &&
          (sessionType ?? "").includes("not your tab") &&
          (sessionActions ?? "").length > 20,
        `type=${(sessionType ?? "").slice(0, 60)} actions=${(sessionActions ?? "").slice(0, 60)}`,
      );

      // In guided mode the autonomous execute control is gone, not merely dimmed.
      await panel.selectOption('[data-testid="mode-select"]', "guided");
      const executeInGuided = await panel.locator('[data-testid="execute-button"]').count();
      const stagehandInGuided = await panel.locator('[data-testid="stagehand-run"]').count();
      check(
        "guided mode offers no autonomous execution controls",
        executeInGuided === 0 && stagehandInGuided === 0,
        `executeButtons=${executeInGuided} stagehandButtons=${stagehandInGuided}`,
      );
      await panel.selectOption('[data-testid="mode-select"]', "autonomous");

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

      // Closing and reopening the panel must not lose the operation.
      await panel.reload({ waitUntil: "load" });
      await panel.waitForSelector('[data-testid="execution-outcome"]', { timeout: 20_000 });
      const restoredOutcome = await panel.textContent('[data-testid="execution-outcome"]');
      const restoredPlan = await panel.locator('[data-testid="plan-skill"]').count();
      check(
        "reopening the panel restores the plan and the verified result from the API",
        (restoredOutcome ?? "").trim() === "VERIFIED" && restoredPlan === 1,
        `outcome=${(restoredOutcome ?? "").trim()} planVisible=${restoredPlan}`,
      );

      // Autonomous mode: a real controlled session with its own id, progress and
      // terminal status. Started through the same API the panel calls, then the
      // panel is reopened and must read that session back - the acceptance
      // condition for "status survives reopening".
      const login = (await (
        await fetch(`${apiBase}/api/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tenantSlug: "acme-demo", email: "admin@acme.test" }),
        })
      ).json()) as { token: string };
      const sessionStart = await fetch(`${apiBase}/api/stagehand/sessions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${login.token}`,
        },
        body: JSON.stringify({
          url: `${crm.baseUrl}/`,
          instruction: "open the new customer form",
          approved: true,
        }),
      });
      const sessionBody = (await sessionStart.json()) as {
        id?: string;
        status?: string;
        sessionType?: string;
        applicationName?: string;
      };
      check(
        "a controlled browser session is created with an operation id and its target",
        sessionStart.status === 202 &&
          Boolean(sessionBody.id) &&
          sessionBody.sessionType === "controlled_browser_session" &&
          sessionBody.applicationName === "AcmeDesk CRM",
        `HTTP ${sessionStart.status} id=${String(sessionBody.id).slice(0, 8)} type=${sessionBody.sessionType} app=${sessionBody.applicationName}`,
      );

      let sessionState = sessionBody as { status?: string; actions?: unknown[]; summary?: string };
      const sessionDeadline = Date.now() + 120_000;
      while (sessionState.status === "running" && Date.now() < sessionDeadline) {
        await sleep(1500);
        sessionState = (await fetch(`${apiBase}/api/stagehand/sessions/${sessionBody.id}`, {
          headers: { authorization: `Bearer ${login.token}` },
        }).then((r) => r.json())) as typeof sessionState;
      }
      check(
        "the session reports its own progress and a real terminal status",
        sessionState.status === "completed" && (sessionState.actions?.length ?? 0) > 0,
        `status=${sessionState.status} actions=${sessionState.actions?.length} summary=${String(sessionState.summary ?? "").slice(0, 80)}`,
      );

      // Reopen the panel with that session as its workspace (what the panel's
      // own start button persists) and read the status back from the API.
      await panel.evaluate(async (sessionId: string) => {
        const extensionChrome = (
          globalThis as unknown as {
            chrome: {
              storage: { local: { set(items: Record<string, unknown>): Promise<void> } };
            };
          }
        ).chrome;
        await extensionChrome.storage.local.set({
          "copilot.workspace": {
            mode: "autonomous",
            planResult: null,
            executionId: null,
            recordingId: null,
            workflowId: null,
            browserSessionId: sessionId,
            applicationChoice: null,
          },
        });
      }, sessionBody.id!);
      await panel.reload({ waitUntil: "load" });
      await panel.waitForSelector('[data-testid="browser-session-status"]', { timeout: 30_000 });
      const sessionStatus = await panel.textContent('[data-testid="browser-session-status"]');
      const sessionIdentity = await panel.textContent('[data-testid="browser-session-id"]');
      check(
        "the reopened panel shows the session's real terminal status and identity",
        (sessionStatus ?? "").trim() === "completed" &&
          (sessionIdentity ?? "").includes("controlled_browser_session"),
        `status=${(sessionStatus ?? "").trim()} identity=${(sessionIdentity ?? "").slice(0, 70)}`,
      );
      await panel.screenshot({ path: path.join(runRoot, "shots", "sidepanel-autonomous.png") });

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
