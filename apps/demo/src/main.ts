/**
 * Starts both disposable demo applications.
 *
 *   pnpm dev:demo        # AcmeDesk CRM on :4300, StockDesk on :4400
 *
 * `DEMO_DATA_DIR` overrides where the SQLite files live (default
 * `.copilot-data/demo`). Both databases are ours to wipe: `POST /api/reset`
 * clears the records, and deleting the directory starts from scratch.
 */
import path from "node:path";
import { startAcmeDesk, startStockDesk } from "./apps.js";

const dataDir = path.resolve(process.env.DEMO_DATA_DIR ?? ".copilot-data/demo");
const crmPort = Number(process.env.DEMO_CRM_PORT ?? 4300);
const stockPort = Number(process.env.DEMO_STOCK_PORT ?? 4400);

const crm = await startAcmeDesk({ port: crmPort, dataDir });
const stock = await startStockDesk({ port: stockPort, dataDir });

console.log(`${crm.name}           ${crm.url}`);
console.log(`${stock.name}              ${stock.url}`);
console.log(`data: ${dataDir}`);

const shutdown = async (): Promise<void> => {
  await Promise.all([crm.close(), stock.close()]);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
