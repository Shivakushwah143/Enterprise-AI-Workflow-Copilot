/**
 * Neon persistence check.
 *
 *   pnpm check:neon
 *
 * Read/write but non-destructive: the schema is applied with
 * `CREATE TABLE IF NOT EXISTS` only (no DROP, no TRUNCATE, no DELETE), and this
 * script never touches a database other than the one in `DATABASE_URL`.
 *
 * What it proves:
 *   1. TLS connectivity to the configured database, and which server answered;
 *   2. the migrations apply cleanly and the expected tables exist;
 *   3. pgvector is present and the embedding column is a real `vector`;
 *   4. an approved skill, its workflow relationship and its verification
 *      contract are persisted;
 *   5. a plan is tenant-scoped (another tenant cannot read it);
 *   6. approvals, plans and execution history survive an API restart;
 *   7. the PGlite fallback still wins when a caller names a data directory.
 */
import path from "node:path";
import { serve } from "@hono/node-server";
import { KnowledgeEngine, Store, openDb, type Sql } from "@copilot/knowledge";
import { DEMO_APPS, OpenAdaptEngine, inspectBundle } from "@copilot/workflow";
import { describeUrl, envUrl, loadProjectEnv, type VerificationContract } from "@copilot/shared";
import { createApp } from "../apps/api/src/app.js";
import { seedDemo } from "../apps/api/src/seed-data.js";
import { startAcmeDesk } from "../apps/demo/src/apps.js";
import { readdir } from "node:fs/promises";

loadProjectEnv();

const apiPort = 4103;
const apiBase = `http://127.0.0.1:${apiPort}`;
const crm = DEMO_APPS[0]!;
const checks: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail: string): boolean {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n      ${detail}`);
  return ok;
}

/** Pooled Neon hosts sometimes reject DDL sessions; the direct host does not. */
function directUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hostname = parsed.hostname.replace("-pooler", "");
    return parsed.toString();
  } catch {
    return url;
  }
}

async function newestBundle(): Promise<string | null> {
  const scenarios = path.join(process.cwd(), ".copilot-data", "scenarios");
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
      try {
        await readdir(path.join(recordings, entry));
        return path.join(recordings, entry);
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

async function main(): Promise<number> {
  const url = envUrl("DATABASE_URL");
  console.log(`database: ${describeUrl(url)}`);
  if (!url) {
    console.error("\nBLOCKED  DATABASE_URL is unset or a placeholder.");
    return 2;
  }

  /* 1-4: connect, migrate, inspect. */
  let sql: Sql | null = null;
  let connectionDetail = "";
  try {
    sql = await openDb({ url });
    connectionDetail = "pooled connection";
  } catch (error) {
    console.log(`      pooled connection failed (${(error as Error).message}); retrying direct`);
    sql = await openDb({ url: directUrl(url) });
    connectionDetail = "direct connection";
  }

  const server = await sql.query<{ version: string }>("SELECT version() AS version");
  check(
    "the database is reachable and reports its version",
    Boolean(server[0]?.version),
    `${connectionDetail}; ${(server[0]?.version ?? "").split(",")[0]}`,
  );

  // The pooler terminates TLS before the Postgres backend, so on the pooled
  // connection `pg_stat_ssl` reports false even though the client leg is
  // encrypted. Check the direct endpoint for a server-side answer, and state
  // the pooled result rather than quietly reporting the wrong one.
  const pooled = await sql.query<{ ssl: boolean }>(
    "SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()",
  );
  // Client-side proof is stronger than a backend flag: `verify-full` validates
  // the server certificate AND the hostname, so a successful connection cannot
  // be an opportunistic, unauthenticated TLS session.
  const strictUrl = new URL(url);
  strictUrl.searchParams.set("sslmode", "verify-full");
  strictUrl.searchParams.delete("uselibpqcompat");
  let strictDetail = "";
  let strictOk = false;
  try {
    const strict = await openDb({ url: strictUrl.toString() });
    try {
      const row = await strict.query<{ ssl: boolean }>(
        "SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()",
      );
      strictOk = true;
      strictDetail = `sslmode=verify-full accepted the server certificate; backend pg_stat_ssl=${row[0]?.ssl}`;
    } finally {
      await strict.close();
    }
  } catch (error) {
    strictDetail = `sslmode=verify-full failed: ${(error as Error).message}`;
  }
  check(
    "the connection is TLS with a verified certificate",
    strictOk,
    `${strictDetail}; pooled backend reports ssl=${pooled[0]?.ssl} (the pooler terminates TLS before Postgres) ${connectionDetail}`,
  );
  const sslMode = new URL(url).searchParams.get("sslmode");
  check(
    "the connection string asks for TLS",
    sslMode === "require" || sslMode === "verify-full" || sslMode === "verify-ca",
    `sslmode=${sslMode ?? "unset (libpq default)"}`,
  );

  const expectedTables = [
    "tenants",
    "users",
    "sessions",
    "applications",
    "recordings",
    "workflows",
    "workflow_steps",
    "skills",
    "plans",
    "executions",
    "verification_results",
    "documents",
    "doc_chunks",
  ];
  const tables = await sql.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
  );
  const present = new Set(tables.map((t) => t.table_name));
  const missing = expectedTables.filter((t) => !present.has(t));
  check(
    "every required table exists after the migrations",
    missing.length === 0,
    missing.length ? `missing: ${missing.join(", ")}` : `${expectedTables.length} tables present`,
  );

  const vector = await sql.query<{ extversion: string }>(
    "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
  );
  const embedding = await sql.query<{ udt_name: string }>(
    `SELECT udt_name FROM information_schema.columns
       WHERE table_name = 'doc_chunks' AND column_name = 'embedding'`,
  );
  check(
    "pgvector is installed and the embedding column is a real vector",
    Boolean(vector[0]?.extversion) && embedding[0]?.udt_name === "vector",
    `vector ${vector[0]?.extversion ?? "absent"}; doc_chunks.embedding=${embedding[0]?.udt_name ?? "absent"}`,
  );

  /* PGlite fallback must survive a DATABASE_URL being present. */
  const fallbackDir = path.join(process.cwd(), ".copilot-data", "neon-fallback-check");
  const fallback = await openDb({ dataDir: fallbackDir });
  check(
    "naming a data directory still selects the embedded database",
    fallback.kind === "pglite",
    `kind=${fallback.kind}`,
  );
  await fallback.close();

  /* 5-6: real records through the API, then a restart. */
  const crmApp = await startAcmeDesk({
    port: Number(new URL(crm.baseUrl).port),
    dataDir: path.join(process.cwd(), ".copilot-data", "neon-check-demo"),
  });

  const boot = async (): Promise<{
    store: Store;
    app: ReturnType<typeof createApp>;
    server: ReturnType<typeof serve>;
  }> => {
    const store = new Store(sql!);
    const knowledge = new KnowledgeEngine(store);
    const app = createApp({
      store,
      engine: new OpenAdaptEngine(),
      knowledge,
      artifactRoot: path.join(process.cwd(), ".copilot-data", "neon-check"),
    });
    const httpServer = serve({ fetch: app.fetch, port: apiPort });
    await new Promise((r) => setTimeout(r, 250));
    return { store, app, server: httpServer };
  };

  const close = async (instance: { server: ReturnType<typeof serve> }): Promise<void> => {
    await new Promise<void>((resolve) => instance.server.close(() => resolve()));
  };

  let first = await boot();
  try {
    const world = await seedDemo(first.store, new KnowledgeEngine(first.store));

    const login = async (tenantSlug: string, email: string): Promise<string> =>
      (
        (await (
          await fetch(`${apiBase}/api/auth/login`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ tenantSlug, email }),
          })
        ).json()) as { token: string }
      ).token;
    const adminToken = await login("acme-demo", "admin@acme.test");
    const employeeToken = await login("acme-demo", "employee@acme.test");
    const outsiderToken = await login("other-tenant", "admin@other.test");

    const call = async <T = any>(
      method: string,
      urlPath: string,
      options: { token?: string; body?: unknown } = {},
    ): Promise<{ status: number; body: T }> => {
      const response = await fetch(`${apiBase}${urlPath}`, {
        method,
        headers: {
          "content-type": "application/json",
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      });
      return { status: response.status, body: (await response.json()) as T };
    };

    const bundlePath = await newestBundle();
    if (!bundlePath) {
      console.error("\nBLOCKED  no compiled bundle; run `pnpm demo:scenarios` first.");
      return 2;
    }
    const inspected = await inspectBundle(bundlePath);
    const workflow = await first.store.createWorkflow({
      tenantId: world.demoTenantId,
      applicationId: world.applications[0]!.application.id,
      name: inspected.name,
      description: "Learned from a recorded demonstration.",
      bundlePath,
      recordingId: null,
      steps: inspected.steps,
      uncertainty: inspected.uncertainty,
    });
    await first.store.setWorkflowStatus(world.demoTenantId, workflow.id, "approved");
    const verification: VerificationContract = {
      kind: "http",
      tier: "system_of_record",
      url: crm.verification.url,
      recordPath: crm.verification.recordPath,
      expect: crm.verification.expect,
      match: crm.verification.match,
    };
    const approval = await call("POST", `/api/workflows/${workflow.id}/approve`, {
      token: adminToken,
      body: {
        name: crm.workflowName,
        description: crm.description,
        triggeredBy: crm.triggers,
        verification,
        acknowledgeRisk: true,
      },
    });
    const skill = approval.body?.skill;
    check(
      "an approved skill is written to the database",
      approval.status === 201 && Boolean(skill?.id),
      `skillId=${skill?.id ?? "none"} HTTP ${approval.status}`,
    );

    const storedSkill = await sql.query<{
      name: string;
      status: string;
      workflow_id: string;
      application_name: string;
      contract: unknown;
    }>(
      `SELECT s.name, s.status, s.workflow_id, a.name AS application_name, s.verification AS contract
         FROM skills s
         JOIN workflows w ON w.id = s.workflow_id
         JOIN applications a ON a.id = w.application_id
        WHERE s.id = $1`,
      [skill.id],
    );
    check(
      "skill -> workflow -> application links are stored together",
      storedSkill[0]?.status === "active" &&
        storedSkill[0]?.workflow_id === workflow.id &&
        storedSkill[0]?.application_name === crm.name,
      `status=${storedSkill[0]?.status} application=${storedSkill[0]?.application_name} contract=${storedSkill[0]?.contract ? "stored" : "missing"}`,
    );

    const planned = await call<any>("POST", "/api/plans", {
      token: employeeToken,
      body: {
        intent: "Create a customer named Neon Persistence Ltd with contact neon@example.test",
      },
    });
    const planId = planned.body?.plan?.id;
    check(
      "a plan is persisted, not kept in memory",
      Boolean(planId) && planned.body?.plan?.skillId === skill.id,
      `planId=${planId} method=${planned.body?.method}`,
    );

    const foreignRead = await call("GET", `/api/plans/${planId}`, { token: outsiderToken });
    check(
      "another tenant cannot read the plan",
      foreignRead.status === 404,
      `HTTP ${foreignRead.status}`,
    );

    const beforeRestart = await call<any>("GET", "/api/executions", { token: employeeToken });
    const executionsBefore = (beforeRestart.body?.items ?? []).length;

    /* Restart: new pool, new store, same database. */
    await close(first);
    await sql.close();
    sql = await openDb({ url });
    first = await boot();

    const afterLogin = await login("acme-demo", "employee@acme.test");
    const reread = await call<any>("GET", `/api/plans/${planId}`, { token: afterLogin });
    check(
      "the approved plan survives an API restart",
      reread.status === 200 && reread.body?.id === planId,
      `HTTP ${reread.status} skillId=${reread.body?.skillId ?? "none"}`,
    );
    const history = await call<any>("GET", "/api/executions", { token: afterLogin });
    check(
      "execution history survives an API restart",
      (history.body?.items ?? []).length === executionsBefore,
      `${executionsBefore} rows before, ${(history.body?.items ?? []).length} after`,
    );

    const approvalRows = await sql.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM skills WHERE status = 'active'`,
    );
    check(
      "approved skills are still there after the restart",
      Number(approvalRows[0]?.count ?? 0) >= 1,
      `active skills=${approvalRows[0]?.count}`,
    );

    const tenantCounts = await sql.query<{ tenant_id: string; count: string }>(
      "SELECT tenant_id, COUNT(*)::text AS count FROM plans GROUP BY tenant_id",
    );
    check(
      "plans are stored per tenant",
      tenantCounts.length >= 1 && tenantCounts.every((row) => Boolean(row.tenant_id)),
      tenantCounts.map((r) => `${r.tenant_id.slice(0, 8)}:${r.count}`).join(", "),
    );
  } finally {
    await close(first).catch(() => {});
    await sql.close().catch(() => {});
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
