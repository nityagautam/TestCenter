import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

/**
 * Postgres client.
 *
 * Two shapes are exported on purpose:
 *   - `db`  — Drizzle, for typed application queries
 *   - `sql` — the raw postgres.js handle, for DDL (partition maintenance) and for
 *             bulk COPY-style inserts during ingest, where the query builder gets
 *             in the way
 *
 * Both share one pool. Callers outside packages/db must not import a driver
 * directly; an ESLint rule enforces that so the hosting decision stays open.
 */
export interface DbConfig {
  databaseUrl: string;
  /** Web serves many short queries; the worker runs few long ones. */
  maxConnections?: number;
  statementTimeoutMs?: number;
  applicationName?: string;
}

export type Sql = ReturnType<typeof postgres>;
export type Database = ReturnType<typeof drizzle<typeof schema>>;

let cached: { sql: Sql; db: Database } | null = null;

export function createClient(config: DbConfig): { sql: Sql; db: Database } {
  const sql = postgres(config.databaseUrl, {
    max: config.maxConnections ?? 10,
    idle_timeout: 30,
    connect_timeout: 10,
    // A runaway dashboard query must not pin a connection indefinitely.
    connection: {
      application_name: config.applicationName ?? "test-center",
      statement_timeout: config.statementTimeoutMs ?? 30_000,
    },
    onnotice: () => {},
    transform: { undefined: null },
  });

  const db = drizzle(sql, { schema, casing: "snake_case" });
  return { sql, db };
}

/** Process-wide singleton. Safe under Next.js hot reload. */
export function getClient(config?: Partial<DbConfig>): { sql: Sql; db: Database } {
  if (cached) return cached;
  const databaseUrl = config?.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  cached = createClient({ ...config, databaseUrl });
  return cached;
}

export async function closeClient(): Promise<void> {
  if (!cached) return;
  await cached.sql.end({ timeout: 5 });
  cached = null;
}

/** Liveness probe for /api/health. Cheap enough to call per request. */
export async function ping(sql: Sql): Promise<{ ok: boolean; latencyMs: number }> {
  const startedAt = Date.now();
  try {
    await sql`SELECT 1`;
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch {
    return { ok: false, latencyMs: Date.now() - startedAt };
  }
}
