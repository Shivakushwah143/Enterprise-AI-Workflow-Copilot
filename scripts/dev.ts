/**
 * One command to run the whole local stack.
 *
 *   pnpm dev
 *
 * Starts the two demo applications and then the API, with their output on the
 * same terminal. Ctrl-C stops both. The extension is separate: load
 * `apps/extension/.output/chrome-mv3` (after `pnpm build:extension`) or run
 * `pnpm dev:extension`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

const tsxCli = path.resolve("node_modules/tsx/dist/cli.mjs");
const children: ChildProcess[] = [];

function start(name: string, entry: string): ChildProcess {
  const child = spawn(process.execPath, [tsxCli, entry], {
    stdio: "inherit",
    env: process.env,
    windowsHide: true,
  });
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.error(`${name} exited with code ${code}`);
    }
  });
  children.push(child);
  return child;
}

start("demo", "apps/demo/src/main.ts");

// The API's readiness probe shells out to Python; it tolerates the demo apps
// still booting, so a short fixed delay is enough.
setTimeout(() => {
  start("api", "apps/api/src/server.ts");
  console.log(
    `\ndemo apps: ${process.env.DEMO_CRM_URL ?? "http://127.0.0.1:4300"}, ${process.env.DEMO_STOCK_URL ?? "http://127.0.0.1:4400"}`,
  );
  console.log(`api:       http://127.0.0.1:${process.env.PORT ?? 4000}`);
}, 1200);

const shutdown = (): void => {
  for (const child of children) child.kill();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
