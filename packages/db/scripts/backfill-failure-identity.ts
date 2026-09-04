import { extractFailureIdentity, FAILURE_IDENTITY_VERSION } from "@testcenter/core";
import { createClient } from "../src/client.js";
import { requireDatabaseUrl } from "./load-env.js";

/**
 * Fills `failure_class`, `failure_summary`, `failure_category` and `failure_source` for failing
 * rows written before extraction existed, or by an older rule set.
 *
 *   pnpm --filter @testcenter/db backfill-identity            # report what is stale
 *   pnpm --filter @testcenter/db backfill-identity --apply
 *   pnpm --filter @testcenter/db backfill-identity --apply --batch 2000
 *
 * Safe for the same reason the signature backfill is: these columns are derived, nothing durable
 * hangs off them, and every input needed to recompute them is still on the row. Unlike
 * `fingerprint`, which flake scores, quarantine and ownership all key on, rewriting these changes
 * only how failures are grouped and displayed.
 *
 * Batched rather than one statement, so each commit is small and the job is resumable — the
 * version column is the progress marker. A single UPDATE across a partitioned table of millions
 * would hold locks for its duration and discard everything if it failed at 90%.
 *
 * Read-only by default. A job that rewrites history should be asked for twice.
 */

const BATCH_DEFAULT = 1_000;

interface StaleRow {
  id: string;
  started_at: Date;
  failure_type: string | null;
  failure_message: string | null;
  stack_trace: string | null;
}

async function main(): Promise<void> {
  const databaseUrl = requireDatabaseUrl();
  const apply = process.argv.includes("--apply");
  const batch_index = process.argv.indexOf("--batch");
  const batch_size = Math.min(
    Math.max(batch_index > -1 ? Number(process.argv[batch_index + 1]) : BATCH_DEFAULT, 100),
    10_000,
  );

  const { sql } = createClient({ databaseUrl, maxConnections: 4 });
  try {
    const [counts] = await sql<{ stale: string; current: string; total: string }[]>`
      SELECT
        count(*) FILTER (WHERE failure_identity_version IS DISTINCT FROM ${FAILURE_IDENTITY_VERSION})::text AS stale,
        count(*) FILTER (WHERE failure_identity_version = ${FAILURE_IDENTITY_VERSION})::text AS current,
        count(*)::text AS total
      FROM test_results
      WHERE status IN ('failed', 'error')
    `;
    const stale = Number(counts?.stale ?? 0);
    console.log(`failure identity version ${FAILURE_IDENTITY_VERSION}`);
    console.log(`  failing rows    : ${Number(counts?.total ?? 0).toLocaleString("en-US")}`);
    console.log(`  already current : ${Number(counts?.current ?? 0).toLocaleString("en-US")}`);
    console.log(`  stale           : ${stale.toLocaleString("en-US")}`);

    if (stale === 0) {
      console.log("nothing to do");
      return;
    }
    if (!apply) {
      console.log("\ndry run — pass --apply to rewrite. Nothing has been changed.");
      return;
    }

    let visited = 0;
    const by_category = new Map<string, number>();
    const by_source = new Map<string, number>();

    for (;;) {
      const rows = await sql<StaleRow[]>`
        SELECT id::text, started_at, failure_type, failure_message, stack_trace
        FROM test_results
        WHERE status IN ('failed', 'error')
          AND failure_identity_version IS DISTINCT FROM ${FAILURE_IDENTITY_VERSION}
        ORDER BY started_at, id
        LIMIT ${batch_size}
      `;
      if (rows.length === 0) break;

      await sql.begin(async (tx) => {
        for (const row of rows) {
          const identity = extractFailureIdentity({
            type: row.failure_type ?? undefined,
            message: row.failure_message ?? undefined,
            stackTrace: row.stack_trace ?? undefined,
          });
          by_category.set(identity.category, (by_category.get(identity.category) ?? 0) + 1);
          by_source.set(identity.source, (by_source.get(identity.source) ?? 0) + 1);

          // Keyed on (id, started_at): that is the primary key of a partitioned table, and `id`
          // alone is not unique across partitions — an UPDATE without it scans every one.
          await tx`
            UPDATE test_results
            SET failure_class = ${identity.errorClass},
                failure_summary = ${identity.summary},
                failure_category = ${identity.category},
                failure_source = ${identity.source},
                failure_identity_version = ${FAILURE_IDENTITY_VERSION}
            WHERE id = ${row.id}::bigint AND started_at = ${row.started_at}
          `;
        }
      });

      visited += rows.length;
      process.stdout.write(
        `\r  visited ${visited.toLocaleString("en-US")} of ${stale.toLocaleString("en-US")}…`,
      );
    }

    process.stdout.write("\n");
    console.log(`✓ extracted ${visited.toLocaleString("en-US")} failure identities`);
    console.log(
      `  by category : ${[...by_category]
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}=${v}`)
        .join("  ")}`,
    );
    // Reported because it diagnoses the reporter rather than the tests: all-'stack' means a
    // reporter putting errors in the <failure> body, 'none' means it sent no error at all.
    console.log(
      `  found in    : ${[...by_source]
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}=${v}`)
        .join("  ")}`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

await main();
