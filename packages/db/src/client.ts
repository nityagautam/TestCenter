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

/**
 * Anything a query can run on: the pool, or a transaction inside `sql.begin()`.
 *
 * postgres.js hands the `begin` callback a `TransactionSql`, which is deliberately
 * *not* assignable to `Sql` — it lacks the pool-level members (END, CLOSE, options)
 * that would be wrong to call mid-transaction. Every query form is identical, so a
 * helper that needs to participate in a caller's transaction takes this instead of
 * `Sql`, rather than the caller casting and losing the distinction.
 */
export type Queryable = Sql | postgres.TransactionSql<Record<string, never>>;

let cached: { sql: Sql; db: Database } | null = null;

/**
 * Two pools, deliberately.
 *
 * `drizzle(sql)` mutates the postgres.js instance it is handed: it installs its own
 * type handling so it can do the mapping itself. A side effect is that the raw
 * template path on that same instance can no longer serialize a `Date` — it throws
 * `Buffer.byteLength received an instance of Date` when binding a timestamptz.
 *
 * That matters here because the ingest hot path uses raw SQL for multi-row inserts
 * (the query builder is a poor fit for bulk writes) while the rest of the app uses
 * drizzle. Sharing one instance silently broke every bulk insert. Separate pools
 * keep both paths correct; the cost is a handful of extra connections, which is
 * nothing next to a category of write bug that only appears at runtime.
 */
function connect(config: DbConfig, max: number, role: string): Sql {
  return postgres(config.databaseUrl, {
    max,
    idle_timeout: 30,
    connect_timeout: 10,
    // A runaway dashboard query must not pin a connection indefinitely.
    connection: {
      application_name: `${config.applicationName ?? "test-center"}-${role}`,
      statement_timeout: config.statementTimeoutMs ?? 30_000,
    },
    onnotice: () => {},
    transform: { undefined: null },
  });
}

export function createClient(config: DbConfig): { sql: Sql; db: Database } {
  const total = config.maxConnections ?? 10;
  const drizzleMax = Math.max(2, Math.floor(total / 2));
  const rawMax = Math.max(2, total - drizzleMax);

  const sql = connect(config, rawMax, "sql");
  const drizzleSql = connect(config, drizzleMax, "orm");
  const db = drizzle(drizzleSql, { schema, casing: "snake_case" });

  // Tracked so closeClient can drain both pools; a leaked pool keeps the process
  // alive and makes graceful shutdown hang.
  ownedPools.set(sql, drizzleSql);
  return { sql, db };
}

const ownedPools = new WeakMap<Sql, Sql>();

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
  const ormPool = ownedPools.get(cached.sql);
  await Promise.all([
    cached.sql.end({ timeout: 5 }),
    ormPool ? ormPool.end({ timeout: 5 }) : Promise.resolve(),
  ]);
  cached = null;
}

/** Drains both pools of a client obtained from `createClient`. */
export async function closeCreatedClient(client: { sql: Sql }): Promise<void> {
  const ormPool = ownedPools.get(client.sql);
  await Promise.all([
    client.sql.end({ timeout: 5 }),
    ormPool ? ormPool.end({ timeout: 5 }) : Promise.resolve(),
  ]);
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
