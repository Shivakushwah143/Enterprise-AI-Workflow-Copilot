/**
 * Environment loading.
 *
 * Small on purpose: no dependency, no magic. A `.env` at the project root is
 * read into `process.env` once, and real environment variables always win, so
 * `PORT=5000 pnpm dev` still beats the file.
 *
 * Two rules exist because they have already caused real failures:
 *
 *   1. **Placeholders are not configuration.** `.env.example` ships strings
 *      like `YOUR_SEPARATE_TEST_DATABASE_URL`; treating one as a URL produces a
 *      connection error that looks like an outage. `envUrl`/`envValue` return
 *      `undefined` for those, and callers fall back to the documented local
 *      path.
 *   2. **Nothing here is for the browser.** Only the API, the scripts and the
 *      demo servers call this. The extension is built by WXT, which inlines
 *      only `WXT_`/`VITE_`-prefixed values, and imports none of this module.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface EnvFileResult {
  /** Absolute path of the file that was read, or null when there was none. */
  path: string | null;
  /** Variable names loaded from the file. Never the values. */
  keys: string[];
}

/** Values that look like documentation, not configuration. */
const PLACEHOLDER =
  /^(your[_-]|change[_-]?me|replace[_-]?me|placeholder|example[_-]|todo|tbd|<.*>|x{4,}|\.{3,}|-+$)/i;

/**
 * Minimal dotenv: `KEY=value`, `#` comments, optional `export` prefix, and
 * single/double quoted values (double quotes honour `\n`).
 */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = withoutExport.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\"/g, '"');
    }
    out[key] = value;
  }
  return out;
}

/** True when a value is real configuration rather than a placeholder. */
export function isConfiguredValue(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  const trimmed = value.trim().replace(/^["']|["']$/g, "");
  if (!trimmed) return false;
  if (PLACEHOLDER.test(trimmed)) return false;
  return /[a-z0-9]/i.test(trimmed);
}

/** A configured variable, or `undefined` when absent/blank/a placeholder. */
export function envValue(name: string): string | undefined {
  const raw = process.env[name];
  return isConfiguredValue(raw) ? raw!.trim() : undefined;
}

/** A configured PostgreSQL URL, or `undefined`. Anything else is unconfigured. */
export function envUrl(name: string): string | undefined {
  const raw = envValue(name);
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") return undefined;
    if (!parsed.hostname) return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

/** Walk up from `startDir` looking for the nearest `.env`. */
export function findEnvFile(startDir: string = process.cwd()): string | null {
  let dir = path.resolve(startDir);
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(dir, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Load the nearest `.env` (project root in practice) into `process.env`.
 * Idempotent, never overrides an already-set variable, never throws.
 */
export function loadProjectEnv(
  options: { startDir?: string; file?: string } = {},
): EnvFileResult {
  const file = options.file ?? findEnvFile(options.startDir);
  if (!file) return { path: null, keys: [] };
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { path: null, keys: [] };
  }
  const parsed = parseDotEnv(text);
  const keys: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    keys.push(key);
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return { path: file, keys };
}

/**
 * Redact a connection string for logs: keep the host and database, which is
 * what diagnoses a problem, and drop the credentials entirely.
 */
export function describeUrl(url: string | undefined): string {
  if (!url) return "unset";
  try {
    const parsed = new URL(url);
    const database = parsed.pathname.replace(/^\//, "") || "(default)";
    return `${parsed.hostname}/${database} ssl=${parsed.searchParams.get("sslmode") ?? "default"}`;
  } catch {
    return "invalid-url";
  }
}
