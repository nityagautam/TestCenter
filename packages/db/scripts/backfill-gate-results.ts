import { createClient } from "../src/client.js";
import { evaluateAndRecordGate } from "../src/quality-gate.js";
import { requireDatabaseUrl } from "./load-env.js";

/**
 * Evaluate the quality gate over runs that finished before the gate existed.
 *
 * Without this the feature is invisible on any real installation: evaluation happens at ingest,
 * so a database full of history shows no verdict anywhere and the badge correctly renders nothing
 * on every single run. The same argument as `backfill-identity` — a feature that only applies to
 * data arriving after the deploy takes as long to become useful as it takes to accumulate runs.
 *
 * Safe to re-run. `run_gate_results` is unique per run and the insert upserts, so a second pass
 * re-judges rather than duplicating — which is also how you apply a changed policy to history.
 *
 * Dry run by default.
 */
async function main(): Promise<void> {
  const databaseUrl = requireDatabaseUrl();
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const projectKey = args.find((a) => a.startsWith("--project="))?.split("=")[1];
  /** Re-judge runs that already have a result, e.g. after editing a policy. */
  const force = args.includes("--force");

  const { sql } = createClient({ databaseUrl, maxConnections: 4 });
  try {
    const runs = await sql<
      { id: string; orgId: string; projectId: string; branch: string | null; name: string | null }[]
    >`
      SELECT r.id, r.org_id AS "orgId", r.project_id AS "projectId", r.branch, r.name
      FROM runs r
      JOIN projects p ON p.id = r.project_id
      WHERE r.status IN ('complete', 'partial')
        ${projectKey ? sql`AND p.key = ${projectKey}` : sql``}
        ${force ? sql`` : sql`AND NOT EXISTS (SELECT 1 FROM run_gate_results g WHERE g.run_id = r.id)`}
      ORDER BY r.started_at ASC
    `;

    console.log(`runs to evaluate : ${runs.length.toLocaleString()}`);
    if (runs.length === 0) {
      console.log("nothing to do");
      return;
    }
    if (!apply) {
      console.log("\ndry run — pass --apply to write. Nothing has been changed.");
      return;
    }

    /*
     * Oldest first, and one at a time. `no_new_failures` reads each test's own prior results, so
     * the order does not change any single answer — but evaluating chronologically means a run
     * being judged sees the same history it would have seen live, which keeps a backfilled
     * verdict comparable with one produced at ingest.
     */
    const tally: Record<string, number> = {};
    let done = 0;
    for (const run of runs) {
      const result = await evaluateAndRecordGate(sql, {
        orgId: run.orgId,
        projectId: run.projectId,
        runId: run.id,
        branch: run.branch,
      });
      const key = result?.outcome ?? "no-gate";
      tally[key] = (tally[key] ?? 0) + 1;
      done += 1;
      if (done % 100 === 0) process.stdout.write(`  evaluated ${done}/${runs.length}…\r`);
    }

    console.log(`\n✓ evaluated ${done.toLocaleString()} run(s)`);
    console.log(
      "  outcomes  :",
      Object.entries(tally)
        .sort((a, b) => b[1] - a[1])
        .map(([key, count]) => `${key}=${count}`)
        .join("  "),
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

void main();
