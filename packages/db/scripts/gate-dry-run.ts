import { evaluateGate, resolveGateConfig } from "@testcenter/core";
import { createClient } from "../src/client.js";
import { gateFactsForRun } from "../src/quality-gate.js";
import { requireDatabaseUrl } from "./load-env.js";

/**
 * Replay a candidate quality gate over runs that already happened.
 *
 * This is the question anybody sensible asks before switching a gate on — "what would this have
 * said about the last N runs" — and it is answerable only because evaluation is a pure function
 * rather than a step in the ingest pipeline. It writes nothing.
 */
async function main(): Promise<void> {
  const databaseUrl = requireDatabaseUrl();
  const args = process.argv.slice(2);
  const projectKey = args.find((a) => a.startsWith("--project="))?.split("=")[1];
  const limit = Number(args.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? 20);

  /*
   * The resolved default — what a project with no policy row of its own is now judged by. Passing
   * no layers is exactly what the worker does for an unconfigured project.
   */
  const { config } = resolveGateConfig([]);

  const { sql } = createClient({ databaseUrl, maxConnections: 4 });
  const selectors = config.rules
    .filter((r) => r.rule === "max_failed_matching")
    .map((r) => (r as { tag: string }).tag);

  const runs = await sql<
    { id: string; name: string | null; branch: string | null; startedAt: Date; project: string }[]
  >`
    SELECT r.id, r.name, r.branch, r.started_at AS "startedAt", p.key AS project
    FROM runs r JOIN projects p ON p.id = r.project_id
    WHERE r.status IN ('complete', 'partial')
      ${projectKey ? sql`AND p.key = ${projectKey}` : sql``}
    ORDER BY r.started_at DESC
    LIMIT ${limit}
  `;

  console.log(`\ncandidate gate (advisory), ${runs.length} most recent runs\n`);
  for (const rule of config.rules) console.log(`  · ${JSON.stringify(rule)}`);
  console.log();

  const tally: Record<string, number> = {};
  const breachedBy: Record<string, number> = {};

  for (const run of runs) {
    const assembled = await gateFactsForRun(sql, {
      orgId: (
        await sql<{ orgId: string }[]>`SELECT org_id AS "orgId" FROM runs WHERE id = ${run.id}`
      )[0]!.orgId,
      runId: run.id,
      tagSelectors: selectors,
      ignoreQuarantined: config.modifiers.ignoreQuarantined,
    });
    if (!assembled) continue;

    const evaluation = evaluateGate(config, assembled.facts);
    tally[evaluation.outcome] = (tally[evaluation.outcome] ?? 0) + 1;

    const failedRules = evaluation.results.filter((r) => r.outcome === "failed");
    for (const rule of failedRules) breachedBy[rule.rule] = (breachedBy[rule.rule] ?? 0) + 1;

    const mark =
      evaluation.outcome === "passed"
        ? "PASS"
        : evaluation.outcome === "warned"
          ? "WARN"
          : evaluation.outcome.toUpperCase();
    const when = run.startedAt.toISOString().slice(0, 16).replace("T", " ");
    console.log(
      `${mark.padEnd(5)} ${when}  ${(run.branch ?? "—").slice(0, 14).padEnd(14)} ${(run.name ?? run.id.slice(0, 8)).slice(0, 34).padEnd(34)} ` +
        `prior=${String(assembled.context.priorRuns).padStart(3)} firstSeen=${String(assembled.context.firstSeen).padStart(3)}` +
        (assembled.context.quarantinedExcluded
          ? ` q-excl=${assembled.context.quarantinedExcluded}`
          : ""),
    );
    for (const rule of evaluation.results) {
      if (rule.outcome === "passed") continue;
      console.log(`        ${rule.outcome === "failed" ? "x" : "-"} ${rule.message}`);
    }
  }

  console.log("\noutcome:", JSON.stringify(tally));
  console.log("breached by rule:", JSON.stringify(breachedBy), "\n");
  await sql.end({ timeout: 5 });
}

void main();
