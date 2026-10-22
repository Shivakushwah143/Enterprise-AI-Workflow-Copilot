/**
 * Seed the durable knowledge layer with two tenants, a role matrix, the two
 * demo applications, and an SOP document per application.
 *
 *   pnpm seed
 *
 * The fixtures themselves live in `seed-data.ts` so the end-to-end scenario
 * runner can seed an isolated database with exactly the same world.
 */
import path from "node:path";
import { KnowledgeEngine, Store, openDb } from "@copilot/knowledge";
import { loadProjectEnv } from "@copilot/shared";
import { DEMO_APPS } from "@copilot/workflow";
import { seedDemo } from "./seed-data.js";

loadProjectEnv();

const log = (event: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
};

const sql = await openDb();
const store = new Store(sql, log);
const knowledge = new KnowledgeEngine(store);

const world = await seedDemo(store, knowledge, log);

log({
  event: "seed.done",
  tenants: ["acme-demo", "other-tenant"],
  users: [world.users.admin, world.users.employee, world.users.outsider],
  applications: world.applications.map((a) => ({
    id: a.application.id,
    name: a.application.name,
    baseUrl: a.application.baseUrl,
  })),
  database: sql.kind,
  vector: sql.vectorAvailable(),
  artifacts: path.resolve(process.env.COPILOT_ARTIFACTS ?? ".copilot-data"),
  note: "No skills are seeded: approval is an explicit admin action.",
  demoApps: DEMO_APPS.map((d) => d.baseUrl),
});

await sql.close();
