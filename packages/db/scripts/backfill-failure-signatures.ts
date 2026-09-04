import { computeFailureSignature, FAILURE_SIGNATURE_VERSION } from "@testcenter/core";
import { createClient } from "../src/client.js";
import { requireDatabaseUrl } from "./load-env.js";

/**
 * Recomputes `test_results.failure_signature` for rows written by an older clustering algorithm.
 *
 *   pnpm --filter @testcenter/db backfill-signatures            # report what is stale, change nothing
 *   pnpm --filter @testcenter/db backfill-signatures --apply
 *   pnpm --filter @testcenter/db backfill-signatures --apply --batch 2000
 *
 * WHY THIS IS SAFE, AND WHY THE EQUIVALENT FOR TEST IDENTITY WOULD NOT BE
 *
 * A failure signature is a grouping key and nothing more: no rollup, no aggregate, no
 * user-visible state keyed on it — one `GROUP BY` in `testFailureModes`. Rewriting it changes
 * how failures are *grouped* and nothing else, and every input needed to recompute it is still
 * on the row. `test_cases.fingerprint` is the opposite: flake scores, quarantine, ownership and
 * "when did this start failing" all hang off it, which is why `FINGERPRINT_VERSION` deliberately
 * does not move for this change.
 *
 * Deliberately NOT a transaction over everything. A single statement across a partitioned table
 * of millions of rows holds locks for the duration and, if it fails at 90%, discards the 90%.
 * Batching by id keeps each commit small and makes the job resumable: the version column is the
 * progress marker, so re-running after an interruption picks up exactly where it stopped.
 *
 * Read-only by default. A migration that rewrites history should have to be asked for twice —
 * once by running it, once by meaning it.
 */

const BATCH_DEFAULT = 1_000;

interface StaleRow {
  id: string;
  started_at: Date;
  project_id: string;
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
        count(*) FILTER (WHERE failure_signature_version IS DISTINCT FROM ${FAILURE_SIGNATURE_VERSION})::text AS stale,
        count(*) FILTER (WHERE failure_signature_version = ${FAILURE_SIGNATURE_VERSION})::text AS current,
        count(*)::text AS total
      FROM test_results
      WHERE failure_signature IS NOT NULL
    `;
    // int8 arrives as a string from postgres.js and will not narrow on its own.
    const stale = Number(counts?.stale ?? 0);
    console.log(`signature version ${FAILURE_SIGNATURE_VERSION}`);
    console.log(`  rows with a signature : ${Number(counts?.total ?? 0).toLocaleString("en-US")}`);
    console.log(
      `  already current       : ${Number(counts?.current ?? 0).toLocaleString("en-US")}`,
    );
    console.log(`  stale                 : ${stale.toLocaleString("en-US")}`);

    if (stale === 0) {
      console.log("nothing to do");
      return;
    }
    if (!apply) {
      console.log("\ndry run — pass --apply to rewrite. Nothing has been changed.");
      return;
    }

    let visited = 0;
    let rewritten = 0;
    let cleared = 0;

    for (;;) {
      /*
       * Keyed on `(id, started_at)` because that is the primary key of a partitioned table —
       * `id` alone is not unique across partitions, and an UPDATE without the partition key
       * would scan every one of them.
       */
      const rows = await sql<StaleRow[]>`
        SELECT id::text, started_at, project_id::text, failure_type, failure_message, stack_trace
        FROM test_results
        WHERE failure_signature IS NOT NULL
          AND failure_signature_version IS DISTINCT FROM ${FAILURE_SIGNATURE_VERSION}
        ORDER BY started_at, id
        LIMIT ${batch_size}
      `;
      if (rows.length === 0) break;

      await sql.begin(async (tx) => {
        for (const row of rows) {
          const signature = computeFailureSignature(row.project_id, {
            type: row.failure_type ?? undefined,
            message: row.failure_message ?? undefined,
            stackTrace: row.stack_trace ?? undefined,
          });

          /*
           * A row can legitimately stop having a signature: v1 hashed content that v2 strips
           * away entirely, so a failure whose only detail was a reporter preamble now has
           * nothing to cluster on. Writing NULL is the honest outcome — better than keeping a
           * v1 digest that groups by scenario title. The version is still stamped, so the row
           * is not revisited forever.
           */
          if (signature === null) cleared += 1;
          else rewritten += 1;

          await tx`
            UPDATE test_results
            SET failure_signature = ${signature?.digest ?? null},
                failure_signature_version = ${FAILURE_SIGNATURE_VERSION}
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
    console.log(
      `✓ rewrote ${rewritten.toLocaleString("en-US")} signature(s), cleared ${cleared.toLocaleString("en-US")} that no longer cluster`,
    );
    console.log("  `testFailureModes` and the failure-signature tile now group by the v2 key.");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

await main();
