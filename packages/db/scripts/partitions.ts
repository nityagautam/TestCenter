import { createClient } from "../src/client.js";
import { drainDefaultPartition, listPartitions, maintainPartitions } from "../src/partitions.js";
import { requireDatabaseUrl } from "./load-env.js";

/**
 * `pnpm db:partitions`            create lookahead partitions, drop expired ones
 * `pnpm db:partitions --dry-run`  show what would change
 * `pnpm db:partitions --drain`    move DEFAULT-partition rows into monthly ones
 * `pnpm db:partitions --list`     list current partitions
 *
 * Scheduled from the worker's maintenance queue in production; the CLI exists for
 * operators and for the backup/restore drill.
 */
async function main(): Promise<void> {
  const databaseUrl = requireDatabaseUrl();
  const dryRun = process.argv.includes("--dry-run");
  const drain = process.argv.includes("--drain");
  const listOnly = process.argv.includes("--list");

  const { sql } = createClient({ databaseUrl, maxConnections: 2 });
  try {
    if (listOnly) {
      for (const name of await listPartitions(sql)) console.log(`  ${name}`);
      return;
    }

    const plan = await maintainPartitions(sql, {
      dryRun,
      lookaheadMonths: Number(process.env.TESTCENTER_PARTITION_LOOKAHEAD ?? 2),
      retentionMonths: Number(process.env.TESTCENTER_RETENTION_MONTHS ?? 12),
    });

    const prefix = dryRun ? "[dry-run] " : "";
    for (const name of plan.created) console.log(`${prefix}+ ${name}`);
    for (const name of plan.dropped) console.log(`${prefix}- ${name}`);
    if (plan.created.length === 0 && plan.dropped.length === 0) {
      console.log(`${prefix}partitions already correct`);
    }

    if (plan.defaultPartitionRows > 0) {
      console.warn(
        `! ${plan.defaultPartitionRows} row(s) in test_results_default — partition ` +
          `maintenance was not running. Re-run with --drain to relocate them.`,
      );
    }

    if (drain && !dryRun) {
      const moved = await drainDefaultPartition(sql);
      console.log(`✓ relocated ${moved} row(s) out of the DEFAULT partition`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
