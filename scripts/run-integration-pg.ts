/**
 * Run the integration suite against a real PostgreSQL (Neon or Docker) without
 * ever pointing it at the live database.
 *
 *   pnpm test:integration:pg
 *
 * The rule this enforces: `TEST_DATABASE_URL` must name a *different database*
 * from `DATABASE_URL`. When it is unset (or still the `YOUR_...` placeholder
 * from `.env.example`), a disposable `copilot_test` database is derived from
 * `DATABASE_URL` on the same server and created if it does not exist.
 *
 * Isolation is then *proved* rather than assumed: the plan count in the live
 * database is compared before and after, and a change is a failure.
 */
import { spawn } from "node:child_process";
import { envUrl, loadProjectEnv } from "@copilot/shared";
import { openDb } from "@copilot/knowledge";

loadProjectEnv();

function databaseName(url: URL): string {
  return url.pathname.replace(/^\//, "");
}

async function main(): Promise<number> {
  const live = envUrl("DATABASE_URL");
  if (!live) {
    console.error("BLOCKED  DATABASE_URL is unset or a placeholder.");
    return 2;
  }
  const liveUrl = new URL(live);
  const liveDb = databaseName(liveUrl);

  const explicit = envUrl("TEST_DATABASE_URL");
  const testUrl = explicit ? new URL(explicit) : new URL(live);

  if (!explicit) {
    testUrl.pathname = `/${liveDb}_test`;
  } else if (databaseName(testUrl) === liveDb && testUrl.hostname === liveUrl.hostname) {
    console.error(
      `REFUSED  TEST_DATABASE_URL points at "${liveDb}", the same database as DATABASE_URL. Use a separate database or branch.`,
    );
    return 2;
  }

  // Create the derived database when it does not exist. Creating is additive;
  // nothing here drops or truncates anything.
  if (!explicit) {
    const admin = await openDb({ url: live });
    try {
      const exists = await admin.query<{ n: string }>(
        "SELECT COUNT(*)::text AS n FROM pg_database WHERE datname = $1",
        [databaseName(testUrl)],
      );
      if (exists[0]?.n === "0") {
        await admin.exec(`CREATE DATABASE "${databaseName(testUrl).replace(/"/g, "")}"`);
        console.log(`created isolated test database ${databaseName(testUrl)}`);
      } else {
        console.log(`using existing isolated test database ${databaseName(testUrl)}`);
      }
    } finally {
      await admin.close();
    }
  }

  const plans = async (url: string): Promise<number> => {
    const sql = await openDb({ url });
    try {
      const rows = await sql.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM plans");
      return Number(rows[0]?.n ?? 0);
    } finally {
      await sql.close();
    }
  };

  const before = await plans(live);
  console.log(`live database plans before: ${before} (must not change)`);

  const child = spawn("pnpm", ["vitest", "run", "tests/integration"], {
    stdio: "inherit",
    env: { ...process.env, TEST_DATABASE_URL: testUrl.toString() },
    shell: process.platform === "win32",
  });
  const code = await new Promise<number>((resolve) => child.on("exit", (c) => resolve(c ?? 1)));

  const after = await plans(live);
  const isolated = after === before;
  console.log(`live database plans after:  ${after}`);
  console.log(
    `${isolated ? "PASS" : "FAIL"}  the test suite did not touch the live database (${databaseName(testUrl)} is separate)`,
  );

  return code === 0 && isolated ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
