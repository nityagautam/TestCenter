import { createClient } from "../src/client.js";
import * as schema from "../src/schema.js";
import { migrate, pendingMigrations } from "../src/migrate.js";
import { maintainPartitions } from "../src/partitions.js";
import { requireDatabaseUrl } from "./load-env.js";

/**
 * `pnpm db:migrate`          apply migrations, provision partitions, bootstrap org
 * `pnpm db:migrate:check`    exit non-zero if anything is unapplied (used in CI)
 */
async function main(): Promise<void> {
  const databaseUrl = requireDatabaseUrl();
  const checkOnly = process.argv.includes("--check");

  if (checkOnly) {
    const pending = await pendingMigrations(databaseUrl);
    if (pending.length > 0) {
      console.error(`✗ ${pending.length} unapplied migration(s):`);
      for (const name of pending) console.error(`    ${name}`);
      process.exitCode = 1;
      return;
    }
    console.log("✓ schema up to date");
    return;
  }

  console.log("→ applying migrations");
  const result = await migrate(databaseUrl);
  if (result.applied.length === 0) {
    console.log(`✓ nothing to apply (${result.skipped.length} already applied)`);
  } else {
    console.log(`✓ applied ${result.applied.length} migration(s)`);
  }

  // Provision partitions immediately: without them every insert falls into the
  // DEFAULT partition, which works but defeats the retention story.
  const { sql, db } = createClient({ databaseUrl, maxConnections: 2 });
  try {
    console.log("→ provisioning partitions");
    const plan = await maintainPartitions(sql, {
      lookaheadMonths: Number(process.env.TESTCENTER_PARTITION_LOOKAHEAD ?? 2),
      retentionMonths: Number(process.env.TESTCENTER_RETENTION_MONTHS ?? 12),
    });
    console.log(
      `✓ partitions: ${plan.created.length} created, ${plan.dropped.length} dropped` +
        (plan.defaultPartitionRows > 0
          ? `, ${plan.defaultPartitionRows} row(s) in DEFAULT (run \`pnpm db:partitions --drain\`)`
          : ""),
    );

    /*
     * No organisation is created here on purpose.
     *
     * This used to bootstrap a default org and project so a fresh database had somewhere
     * to accept a run before sign-in existed. Onboarding now does that properly, so
     * bootstrapping only manufactures an organisation nobody is a member of — and
     * recreated it on every migrate, so deleting it never stuck.
     *
     * Use `seed-test-org` for development data, or sign in and create one.
     */
    const orgs = await db.select({ id: schema.organizations.id }).from(schema.organizations);
    console.log(
      orgs.length === 0
        ? "✓ no organisations yet — sign in to create one, or run `pnpm --filter @testcenter/db seed-test-org`"
        : `✓ ${orgs.length} organisation(s) present`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
