import { defineConfig } from "vitest/config";

/**
 * Node built-ins are imported natively, never bundled.
 *
 * `node:sqlite` (used by the disposable demo apps) is newer than the Vite
 * version pinned by WXT, so Vite does not recognise it as a built-in and would
 * otherwise try to resolve it as a package.
 */
export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 60_000,
    server: { deps: { external: ["node:sqlite"] } },
  },
  ssr: { external: ["node:sqlite"] },
});
