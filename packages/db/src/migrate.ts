import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

/**
 * Migration runner.
 *
 * Hand-written SQL rather than a generated diff, because the schema uses features
 * an ORM generator does not express: range partitioning, partial and expression
 * indexes, generated tsvector columns, and plpgsql functions. Drizzle is still
 * used for typed queries — it just does not own the DDL.
 *
 * Guarantees:
 *   - a session advisory lock, so two app instances booting at once cannot race
 *   - checksums, so an already-applied migration cannot be edited unnoticed
 *   - one transaction per migration, so a failure leaves no half-applied schema
 */
const MIGRATION_LOCK_ID = 8_274_119_004;

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

function checksumOf(sql: string): string {
  // Normalize line endings so the same file checked out on Windows still matches.
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

export function migrationsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "sql");
}

export async function loadMigrations(dir = migrationsDir()): Promise<MigrationFile[]> {
  const entries = await readdir(dir);
  const files = entries.filter((entry) => entry.endsWith(".sql")).sort();
  const migrations: MigrationFile[] = [];
  for (const file of files) {
    const sql = await readFile(join(dir, file), "utf8");
    migrations.push({ name: file, sql, checksum: checksumOf(sql) });
  }
  return migrations;
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

export async function migrate(databaseUrl: string, dir = migrationsDir()): Promise<MigrateResult> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  const result: MigrateResult = { applied: [], skipped: [] };

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        text PRIMARY KEY,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now(),
        duration_ms integer
      )
    `;

    // Serialize concurrent boots. Released implicitly when the session ends, but
    // released explicitly below so a long-lived pool would not hold it.
    await sql`SELECT pg_advisory_lock(${MIGRATION_LOCK_ID}::bigint)`;

    try {
      const applied = await sql<{ name: string; checksum: string }[]>`
        SELECT name, checksum FROM schema_migrations
      `;
      const appliedByName = new Map(applied.map((row) => [row.name, row.checksum]));

      for (const migration of await loadMigrations(dir)) {
        const existing = appliedByName.get(migration.name);
        if (existing) {
          if (existing !== migration.checksum) {
            throw new Error(
              `Migration ${migration.name} was modified after being applied ` +
                `(recorded ${existing.slice(0, 12)}, found ${migration.checksum.slice(0, 12)}). ` +
                `Applied migrations are immutable — add a new migration instead.`,
            );
          }
          result.skipped.push(migration.name);
          continue;
        }

        const startedAt = Date.now();
        await sql.begin(async (tx) => {
          await tx.unsafe(migration.sql);
          await tx`
            INSERT INTO schema_migrations (name, checksum, duration_ms)
            VALUES (${migration.name}, ${migration.checksum}, ${Date.now() - startedAt})
          `;
        });
        result.applied.push(migration.name);
        console.log(`  applied ${migration.name} (${Date.now() - startedAt}ms)`);
      }
    } finally {
      await sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK_ID}::bigint)`;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }

  return result;
}

/** CI check: fails if any migration is unapplied, without applying anything. */
export async function pendingMigrations(
  databaseUrl: string,
  dir = migrationsDir(),
): Promise<string[]> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    const exists = await sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'schema_migrations'
      ) AS exists
    `;
    const migrations = await loadMigrations(dir);
    if (!exists[0]?.exists) return migrations.map((migration) => migration.name);

    const applied = await sql<{ name: string }[]>`SELECT name FROM schema_migrations`;
    const appliedNames = new Set(applied.map((row) => row.name));
    return migrations.filter((m) => !appliedNames.has(m.name)).map((m) => m.name);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
