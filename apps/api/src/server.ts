/**
 * API server.
 *
 *   pnpm dev:api
 *
 * Environment:
 *   PORT                 default 4000
 *   DATABASE_URL         PostgreSQL; when unset, embedded PostgreSQL (PGlite)
 *   COPILOT_ARTIFACTS    recordings/bundles/run reports (default .copilot-data)
 *   PYTHON_BIN           interpreter that has openadapt-flow installed
 */
import path from "node:path";
import { serve } from "@hono/node-server";
import { KnowledgeEngine, Store, openDb } from "@copilot/knowledge";
import { loadProjectEnv } from "@copilot/shared";
import { OpenAdaptEngine } from "@copilot/workflow";
import { createApp } from "./app.js";
import { createLogger } from "./log.js";

// Before anything reads configuration: the nearest `.env` (the project root),
// with real environment variables taking precedence.
const env = loadProjectEnv();

const log = createLogger("api");
const port = Number(process.env.PORT ?? 4000);
const artifactRoot = path.resolve(process.env.COPILOT_ARTIFACTS ?? ".copilot-data");

const sql = await openDb();
const store = new Store(sql, log);
const knowledge = new KnowledgeEngine(store);
const engine = new OpenAdaptEngine();

const app = createApp({ store, engine, knowledge, artifactRoot, log });

serve({ fetch: app.fetch, port }, (info) => {
  log({
    event: "api.listening",
    port: info.port,
    database: sql.kind,
    vector: sql.vectorAvailable(),
    envFile: env.path,
    envKeys: env.keys.length,
    artifacts: artifactRoot,
  });
});

const shutdown = async (): Promise<void> => {
  await sql.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
