/**
 * One SQL surface, two PostgreSQL implementations.
 *
 * - `DATABASE_URL` set  -> real PostgreSQL (pg), the production path in
 *   docker-compose.yml.
 * - otherwise           -> PGlite, PostgreSQL compiled to WASM, persisted under
 *   `.copilot-data/pg`. Same SQL, no daemon, so the demo and the test suite run
 *   without Docker.
 *
 * Both use `$n` placeholders, so every query below is portable.
 */
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export interface Sql {
  readonly kind: "postgres" | "pglite";
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<T[]>;
  exec(text: string): Promise<void>;
  close(): Promise<void>;
  /** True once `CREATE EXTENSION vector` succeeded. */
  vectorAvailable(): boolean;
}

const SCHEMA_PATH = fileURLToPath(new URL("./schema.sql", import.meta.url));

async function loadSchema(): Promise<string> {
  return readFile(SCHEMA_PATH, "utf8");
}

/**
 * Split on statement boundaries, then drop comment lines.
 *
 * The leading comment block belongs to the first statement, so filtering whole
 * chunks that *start* with `--` would silently drop the first CREATE TABLE.
 */
function splitStatements(sql: string): string[] {
  return sql
    .split(/;\s*\n/)
    .map((chunk) =>
      chunk
        .split(/\r?\n/)
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter((s) => s.length > 0);
}

class PostgresSql implements Sql {
  readonly kind = "postgres" as const;
  private vector = false;

  constructor(private readonly pool: import("pg").Pool) {}

  async query<T = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const result = await this.pool.query(text, params);
    return result.rows as T[];
  }

  async exec(text: string): Promise<void> {
    await this.pool.query(text);
  }

  vectorAvailable(): boolean {
    return this.vector;
  }

  markVector(): void {
    this.vector = true;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

class PgliteSql implements Sql {
  readonly kind = "pglite" as const;
  private vector = false;

  constructor(private readonly db: import("@electric-sql/pglite").PGlite) {}

  async query<T = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const result = await this.db.query<T>(text, params);
    return result.rows;
  }

  async exec(text: string): Promise<void> {
    await this.db.exec(text);
  }

  vectorAvailable(): boolean {
    return this.vector;
  }

  markVector(): void {
    this.vector = true;
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

export interface OpenDbOptions {
  /** Defaults to `process.env.DATABASE_URL`, then PGlite on disk. */
  url?: string | undefined;
  /** PGlite data directory (ignored when a URL is given). */
  dataDir?: string | undefined;
  /** Add `doc_chunks.embedding` when pgvector is present. */
  enableVector?: boolean;
}

export async function openDb(options: OpenDbOptions = {}): Promise<Sql> {
  const url = options.url ?? process.env.DATABASE_URL ?? "";
  const schema = await loadSchema();
  let sql: Sql;

  if (url) {
    const { Pool } = await import("pg");
    sql = new PostgresSql(new Pool({ connectionString: url, max: 5 }));
  } else {
    const { PGlite } = await import("@electric-sql/pglite");
    const dataDir =
      options.dataDir ??
      process.env.COPILOT_DB_DIR ??
      path.resolve(".copilot-data", "pg");
    // PGlite creates its own directory but not the parent, so make the path
    // first: a fresh checkout has no `.copilot-data` yet.
    await mkdir(dataDir, { recursive: true });
    sql = new PgliteSql(new PGlite(dataDir));
  }

  for (const statement of splitStatements(schema)) {
    await sql.exec(statement);
  }

  if (options.enableVector !== false) {
    await maybeEnableVector(sql);
  }

  return sql;
}

/**
 * pgvector is best-effort and reported, never assumed. If the extension is
 * missing the column simply does not exist and retrieval stays keyword-only.
 */
export async function maybeEnableVector(sql: Sql): Promise<boolean> {
  try {
    await sql.exec("CREATE EXTENSION IF NOT EXISTS vector");
    await sql.exec(
      "ALTER TABLE doc_chunks ADD COLUMN IF NOT EXISTS embedding vector(1536)",
    );
    if (sql instanceof PgliteSql) sql.markVector();
    if (sql instanceof PostgresSql) sql.markVector();
    return true;
  } catch {
    return false;
  }
}
