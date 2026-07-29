import type { Sql } from "postgres";

/**
 * Partition maintenance for test_results.
 *
 * The reason this exists: retention. Dropping a monthly partition is instant DDL,
 * whereas `DELETE FROM test_results WHERE started_at < ...` would rewrite the
 * table, bloat it, and hold locks while the product is being used. At the planned
 * volume (<50k tests/day) partitioning buys us nothing on the read path — it buys
 * us a delete story.
 *
 * Runs on a schedule from the worker's maintenance queue and is idempotent, so
 * running it twice or ten times a day is harmless.
 */
const PARENT_TABLE = "test_results";

export interface PartitionPlan {
  created: string[];
  dropped: string[];
  /** Rows in the DEFAULT partition mean maintenance stopped running — alertable. */
  defaultPartitionRows: number;
}

function monthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function addMonths(date: Date, months: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
}

function partitionName(monthStartDate: Date): string {
  const year = monthStartDate.getUTCFullYear();
  const month = String(monthStartDate.getUTCMonth() + 1).padStart(2, "0");
  return `${PARENT_TABLE}_${year}_${month}`;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface MaintainPartitionsOptions {
  /** How many future months to pre-create so ingest never hits a missing range. */
  lookaheadMonths?: number;
  /** How many months of results to keep. Older partitions are dropped. */
  retentionMonths?: number;
  /** Report what would change without touching anything. */
  dryRun?: boolean;
  now?: Date;
}

export async function maintainPartitions(
  sql: Sql,
  options: MaintainPartitionsOptions = {},
): Promise<PartitionPlan> {
  const lookaheadMonths = options.lookaheadMonths ?? 2;
  const retentionMonths = options.retentionMonths ?? 12;
  const dryRun = options.dryRun ?? false;
  const now = options.now ?? new Date();

  const plan: PartitionPlan = { created: [], dropped: [], defaultPartitionRows: 0 };

  const existing = await listPartitions(sql);
  const existingNames = new Set(existing);

  // Create the current month plus lookahead. Backfilled uploads land in the
  // DEFAULT partition rather than failing, and are swept up next run.
  const current = monthStart(now);
  for (let offset = 0; offset <= lookaheadMonths; offset += 1) {
    const start = addMonths(current, offset);
    const end = addMonths(start, 1);
    const name = partitionName(start);
    if (existingNames.has(name)) continue;

    if (!dryRun) {
      // Guarded by IF NOT EXISTS as well as the set check: two workers may run
      // maintenance concurrently after a deploy.
      await sql.unsafe(
        `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF ${PARENT_TABLE}
         FOR VALUES FROM ('${isoDate(start)}') TO ('${isoDate(end)}')`,
      );
    }
    plan.created.push(name);
  }

  // Drop partitions entirely older than the retention window.
  const cutoff = addMonths(current, -retentionMonths);
  for (const name of existing) {
    const match = /_(\d{4})_(\d{2})$/.exec(name);
    if (!match) continue; // skips test_results_default
    const [, year, month] = match;
    if (!year || !month) continue;
    const start = new Date(Date.UTC(Number(year), Number(month) - 1, 1));
    if (start >= cutoff) continue;

    if (!dryRun) {
      await sql.unsafe(`DROP TABLE IF EXISTS ${name}`);
    }
    plan.dropped.push(name);
  }

  const defaultRows = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM test_results_default
  `;
  plan.defaultPartitionRows = Number(defaultRows[0]?.count ?? 0);

  return plan;
}

export async function listPartitions(sql: Sql): Promise<string[]> {
  const rows = await sql<{ relname: string }[]>`
    SELECT child.relname
    FROM pg_inherits
    JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
    JOIN pg_class child ON child.oid = pg_inherits.inhrelid
    WHERE parent.relname = ${PARENT_TABLE}
    ORDER BY child.relname
  `;
  return rows.map((row) => row.relname);
}

/**
 * Moves any rows that landed in the DEFAULT partition into their proper monthly
 * partition. Needed after a backfill or after maintenance was down: a row in
 * DEFAULT is invisible to partition pruning and immune to retention drops.
 */
export async function drainDefaultPartition(sql: Sql): Promise<number> {
  const months = await sql<{ month: Date }[]>`
    SELECT DISTINCT date_trunc('month', started_at)::date AS month
    FROM test_results_default
    ORDER BY month
  `;
  if (months.length === 0) return 0;

  let moved = 0;
  for (const { month } of months) {
    const start = monthStart(new Date(month));
    const end = addMonths(start, 1);
    const name = partitionName(start);
    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF ${PARENT_TABLE}
       FOR VALUES FROM ('${isoDate(start)}') TO ('${isoDate(end)}')`,
    );
    // Delete-and-reinsert in one statement so the rows are never missing.
    const result = await sql.unsafe(
      `WITH moved AS (
         DELETE FROM test_results_default
         WHERE started_at >= '${isoDate(start)}' AND started_at < '${isoDate(end)}'
         RETURNING *
       )
       INSERT INTO ${PARENT_TABLE} SELECT * FROM moved`,
    );
    moved += result.count ?? 0;
  }
  return moved;
}
