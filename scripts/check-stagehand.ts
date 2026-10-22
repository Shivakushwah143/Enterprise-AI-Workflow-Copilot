/**
 * Stagehand live check.
 *
 *   pnpm check:stagehand
 *
 * Stagehand drives its own controlled Chromium session; it is not the
 * extension's tab and cannot become it. Everything here stays inside that
 * boundary and inside the disposable CRM on 127.0.0.1.
 *
 * What it proves, in order:
 *   1. v4 creates a session with the model this project actually has (Groq);
 *   2. `observe` returns candidate elements for a real page;
 *   3. one bounded, non-consequential action changes the UI (the customer form
 *      opens) and the change is verified in the DOM;
 *   4. an action whose control does not exist fails instead of claiming success;
 *   5. the API refuses a consequential instruction before it reaches a provider;
 *   6. nothing was written to the application database.
 */
import path from "node:path";
import { serve } from "@hono/node-server";
import { KnowledgeEngine, Store, openDb } from "@copilot/knowledge";
import { DEMO_APPS, OpenAdaptEngine } from "@copilot/workflow";
import { loadProjectEnv } from "@copilot/shared";
import { createApp } from "../apps/api/src/app.js";
import { seedDemo } from "../apps/api/src/seed-data.js";
import {
  loadStagehandModule,
  stagehandStatus,
  type StagehandPage,
} from "../apps/api/src/stagehand.js";
import { startAcmeDesk } from "../apps/demo/src/apps.js";

loadProjectEnv();

const crm = DEMO_APPS[0]!;
const checks: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail: string): boolean {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n      ${detail}`);
  return ok;
}


async function main(): Promise<number> {
  const status = await stagehandStatus();
  console.log(`stagehand: ${status.status} — ${status.detail}`);
  if (status.status !== "configured") {
    console.error("\nBLOCKED  Stagehand has no usable model configuration.");
    return 2;
  }

  const crmApp = await startAcmeDesk({
    port: Number(new URL(crm.baseUrl).port),
    dataDir: path.join(process.cwd(), ".copilot-data", "stagehand-check", "demo"),
  });

  // The API is only needed for the policy check (which is DB-scoped).
  const sql = await openDb({
    dataDir: path.join(process.cwd(), ".copilot-data", "stagehand-check", "pg"),
  });
  const store = new Store(sql);
  const app = createApp({
    store,
    engine: new OpenAdaptEngine(),
    knowledge: new KnowledgeEngine(store),
    artifactRoot: path.join(process.cwd(), ".copilot-data", "stagehand-check"),
  });
  const server = serve({ fetch: app.fetch, port: 4104 });
  await new Promise((r) => setTimeout(r, 250));

  let browser: Awaited<ReturnType<NonNullable<Awaited<ReturnType<typeof loadStagehandModule>>>["localBrowser"]["launch"]>> | null = null;
  let stagehand: { observe?(i: string): Promise<unknown>; act(i: string): Promise<any>; close(): Promise<void> } | null = null;

  try {
    const world = await seedDemo(store, new KnowledgeEngine(store));
    void world;

    const login = (await (
      await fetch("http://127.0.0.1:4104/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantSlug: "acme-demo", email: "admin@acme.test" }),
      })
    ).json()) as { token: string };

    /* ---- the AI path itself ---- */
    const mod = await loadStagehandModule();
    if (!mod) {
      console.error("\nBLOCKED  the Stagehand package could not be loaded from apps/api.");
      return 2;
    }
    const modelName = process.env["STAGEHAND_MODEL"] ?? "groq/openai/gpt-oss-120b";
    const headless = process.env["STAGEHAND_HEADLESS"] !== "false";

    browser = await mod.localBrowser.launch({ headless });
    // `handle.context` only becomes available once Stagehand attaches to the
    // launched browser, so this check must not touch it yet.
    check(
      "localBrowser.launch starts a controlled Chromium session",
      Boolean(browser),
      `headless=${headless}`,
    );

    stagehand = await mod.Stagehand.create({
      browser,
      model: { modelName, apiKey: process.env["GROQ_API_KEY"] },
    });
    check(
      "Stagehand.create accepts the Groq model",
      Boolean(stagehand),
      `model=${modelName}`,
    );

    const pages = await browser!.context.pages();
    const page: StagehandPage = pages[0] ?? (await browser!.context.newPage());
    await page.goto(`${crm.baseUrl}/`);

    let observedCount = 0;
    let observeDetail = "";
    try {
      const observed = await stagehand!.observe!("the button that opens the new customer form");
      observedCount = Array.isArray(observed) ? observed.length : observed ? 1 : 0;
      observeDetail = JSON.stringify(observed).slice(0, 220);
    } catch (error) {
      observeDetail = `observe failed: ${(error as Error).message.slice(0, 200)}`;
    }
    check(
      "observe returns candidates for the real page",
      observedCount > 0,
      `${observedCount} candidate(s): ${observeDetail}`,
    );

    const formOpen = async (): Promise<boolean> =>
      (await page.evaluate?.((() => {
        const form = document.querySelector("#customer-form") as HTMLFormElement | null;
        return Boolean(form) && form!.hidden === false;
      }) as () => boolean)) ?? false;
    const beforeForm = await formOpen();

    let actDetail = "";
    let actOk = false;
    try {
      const result = await stagehand!.act("click the New customer button to open the form");
      actOk = (result?.data?.success ?? result?.success) === true;
      actDetail = String(result?.message ?? JSON.stringify(result)).slice(0, 240);
    } catch (error) {
      actDetail = `act failed: ${(error as Error).message.slice(0, 240)}`;
    }
    const afterForm = await formOpen();
    check(
      "one bounded action changes the UI, verified in the DOM",
      actOk && beforeForm === false && afterForm === true,
      `form before=${beforeForm} after=${afterForm}; ${actDetail}`,
    );

    /* ---- a control that does not exist must not be reported as success ---- */
    let missingDetail = "";
    let missingOk = false;
    try {
      const result = await stagehand!.act("click the Purge all customers button");
      missingOk = (result?.data?.success ?? result?.success) === true;
      missingDetail = String(result?.message ?? JSON.stringify(result)).slice(0, 240);
    } catch (error) {
      missingDetail = `threw: ${(error as Error).message.slice(0, 240)}`;
    }
    check(
      "a missing control is not reported as a successful action",
      missingOk === false,
      `success=${missingOk} ${missingDetail}`,
    );

    /* ---- the policy gate, before any provider call ---- */
    const refused = await fetch("http://127.0.0.1:4104/api/stagehand/tasks", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${login.token}` },
      body: JSON.stringify({
        url: `${crm.baseUrl}/`,
        instruction: "delete every customer record",
      }),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
    check(
      "a consequential instruction is refused before a provider is contacted",
      refused.status === 409 && String(refused.body?.error?.message ?? "").includes("approved: true"),
      `HTTP ${refused.status} "${refused.body?.error?.message ?? ""}"`,
    );

    /* ---- nothing was written ---- */
    const customers = (await fetch(`${crm.baseUrl}/api/customers`).then((r) => r.json())) as {
      items?: unknown[];
    };
    check(
      "the browser session wrote nothing to the application",
      (customers.items?.length ?? -1) === 0,
      `${customers.items?.length ?? "?"} customer record(s)`,
    );

    /* ---- the API route, end to end, when a real model answers ---- */
    const task = await fetch("http://127.0.0.1:4104/api/stagehand/tasks", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${login.token}` },
      body: JSON.stringify({
        url: `${crm.baseUrl}/`,
        instruction: "open the new customer form",
        approved: true,
      }),
    });
    const taskBody = (await task.json()) as any;
    check(
      "the API route reports the real Stagehand run (or a real failure, never a fake success)",
      task.status === 200 ? taskBody?.ok === true : task.status >= 500,
      `HTTP ${task.status} ${JSON.stringify(taskBody).slice(0, 240)}`,
    );

    /* ---- autonomous mode: session identity, scope and isolation ---- */
    const started = await fetch("http://127.0.0.1:4104/api/stagehand/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${login.token}` },
      body: JSON.stringify({
        url: `${crm.baseUrl}/`,
        instruction: "open the new customer form",
        approved: true,
      }),
    });
    const created = (await started.json()) as any;
    check(
      "a controlled browser session is created with an operation id and its target",
      started.status === 202 &&
        typeof created?.id === "string" &&
        created?.sessionType === "controlled_browser_session" &&
        created?.applicationName === crm.name,
      `HTTP ${started.status} id=${String(created?.id).slice(0, 8)} type=${created?.sessionType} app=${created?.applicationName}`,
    );

    let settled = created;
    const deadline = Date.now() + 90_000;
    while (settled?.status === "running" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      settled = (await fetch(`http://127.0.0.1:4104/api/stagehand/sessions/${created.id}`, {
        headers: { authorization: `Bearer ${login.token}` },
      }).then((r) => r.json())) as any;
    }
    check(
      "the session reports its own progress and a real terminal status",
      settled?.status === "completed" && (settled?.actions?.length ?? 0) > 0,
      `status=${settled?.status} actions=${settled?.actions?.length} summary=${String(settled?.summary ?? "").slice(0, 90)}`,
    );

    const otherTenant = (await (
      await fetch("http://127.0.0.1:4104/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantSlug: "other-tenant", email: "admin@other.test" }),
      })
    ).json()) as { token: string };
    const foreignRead = await fetch(
      `http://127.0.0.1:4104/api/stagehand/sessions/${created.id}`,
      { headers: { authorization: `Bearer ${otherTenant.token}` } },
    );
    check(
      "another tenant cannot read the session, and its own id is not revealed",
      foreignRead.status === 404,
      `HTTP ${foreignRead.status}`,
    );

    const expired = await fetch(
      "http://127.0.0.1:4104/api/stagehand/sessions/00000000-0000-0000-0000-000000000000",
      { headers: { authorization: `Bearer ${login.token}` } },
    );
    check(
      "an unknown or expired session returns 404 instead of a stale success",
      expired.status === 404,
      `HTTP ${expired.status}`,
    );
  } finally {
    await stagehand?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await sql.close();
    await crmApp.close();
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  return failed.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
