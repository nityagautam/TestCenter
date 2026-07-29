import { performance } from "node:perf_hooks";
import { createClient } from "../src/client.js";
import { bootstrap } from "../src/bootstrap.js";
import {
  addRunTotals,
  finalizeRun,
  persistResultBatch,
  refreshTestCaseStats,
} from "../src/ingest.js";
import {
  listRunResults,
  listRuns,
  runFilterOptions,
  summarizeRunSuites,
  tagFacets,
} from "../src/queries.js";
import * as schema from "../src/schema.js";
import { requireDatabaseUrl } from "./load-env.js";

/**
 * Performance seed and budget check.
 *
 * The plan's read-path targets are only meaningful against a realistic amount of
 * data — every query here is fast on six runs. This seeds a body of history and then
 * measures the queries the UI actually issues, so a regression shows up as a number
 * rather than as a vague feeling that the dashboard got slower.
 *
 *   pnpm --filter @testcenter/db seed-perf [runs] [testsPerRun]
 */
const BUDGETS_MS = {
  runList: 400,
  tagFacets: 400,
  filterOptions: 400,
  runResults: 400,
  suiteSummary: 400,
};

/** Deterministic pseudo-random so repeated runs are comparable. */
function makeRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

async function main(): Promise<void> {
  const databaseUrl = requireDatabaseUrl();
  const runCount = Number(process.argv[2] ?? 200);
  const testsPerRun = Number(process.argv[3] ?? 500);
  const random = makeRandom(42);

  const client = createClient({ databaseUrl, maxConnections: 6, statementTimeoutMs: 120_000 });
  const { sql, db } = client;

  try {
    const boot = await bootstrap(db, { projectKey: "perf", projectName: "Perf Harness" });
    const { orgId, projectId } = boot;

    const existing = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM runs WHERE project_id = ${projectId}
    `;
    console.log(
      `→ seeding ${runCount} run(s) x ${testsPerRun} test(s) = ${runCount * testsPerRun} results ` +
        `(project already has ${existing[0]?.n ?? 0} run(s))`,
    );

    const branches = ["main", "develop", "release/24.9", "feature/checkout"];
    const suites = Array.from({ length: 40 }, (_, i) => `tests/suite_${i}/spec_${i}.py`);
    const startedAt = performance.now();
    let written = 0;

    for (let runIndex = 0; runIndex < runCount; runIndex += 1) {
      const branch = branches[runIndex % branches.length] as string;
      // Spread runs over the past 60 days so partition pruning and the time-ordered
      // index are actually exercised.
      const runStartedAt = new Date(Date.now() - Math.floor(random() * 60 * 86_400_000));

      const inserted = await db
        .insert(schema.runs)
        .values({
          orgId,
          projectId,
          name: `nightly #${runIndex}`,
          framework: "junit",
          status: "parsing",
          startedAt: runStartedAt,
          branch,
          environment: runIndex % 3 === 0 ? "staging" : "production",
          commitSha: Math.floor(random() * 1e16)
            .toString(16)
            .padStart(40, "0"),
          tags: {
            suite: runIndex % 2 === 0 ? "regression" : "smoke",
            browser: runIndex % 3 === 0 ? "chromium" : "firefox",
            env: runIndex % 3 === 0 ? "staging" : "production",
          },
        })
        .returning({ id: schema.runs.id });
      const runId = inserted[0]?.id as string;

      // Emit in batches, exactly as the ingest pipeline does.
      const BATCH = 500;
      for (let offset = 0; offset < testsPerRun; offset += BATCH) {
        const size = Math.min(BATCH, testsPerRun - offset);
        const results = Array.from({ length: size }, (_, i) => {
          const index = offset + i;
          const roll = random();
          const failed = roll < 0.04;
          const skipped = !failed && roll < 0.07;
          const flaky = !failed && !skipped && roll < 0.09;
          return {
            name: `test_case_${index}`,
            suite: suites[index % suites.length] as string,
            classname: `tests.suite_${index % 40}`,
            status: (failed ? "failed" : skipped ? "skipped" : "passed") as
              "failed" | "skipped" | "passed",
            durationMs: Math.floor(random() * 3000),
            startedAt: runStartedAt,
            ...(failed
              ? {
                  failure: {
                    type: "AssertionError",
                    message: `expected ${Math.floor(random() * 100)} to equal 42`,
                    stackTrace: `at tests/suite_${index % 40}/spec.py:${index % 200}`,
                  },
                }
              : {}),
            ...(flaky
              ? {
                  retries: [
                    { attempt: 1, status: "failed" as const },
                    { attempt: 2, status: "passed" as const },
                  ],
                }
              : {}),
          };
        });

        const outcome = await persistResultBatch(sql, {
          orgId,
          projectId,
          runId,
          results,
          runStartedAt,
        });
        await addRunTotals(sql, runId, outcome.totals);
        written += outcome.written;
      }

      await finalizeRun(sql, { runId, status: "complete", durationMs: 60_000 });
      // Only refresh stats occasionally: it is the most expensive rollup and doing it
      // per run would dominate seed time without changing what we are measuring.
      if (runIndex % 25 === 0) await refreshTestCaseStats(sql, { projectId, runId });

      if (runIndex > 0 && runIndex % 25 === 0) {
        console.log(`  ${runIndex}/${runCount} runs · ${written} results`);
      }
    }

    const seedSeconds = (performance.now() - startedAt) / 1000;
    console.log(
      `✓ seeded ${written} results in ${seedSeconds.toFixed(1)}s ` +
        `(${Math.round(written / seedSeconds)} results/sec)`,
    );

    const totals = await sql<{ results: string; cases: string; runs: string }[]>`
      SELECT
        (SELECT count(*)::text FROM test_results) AS results,
        (SELECT count(*)::text FROM test_cases) AS cases,
        (SELECT count(*)::text FROM runs) AS runs
    `;
    console.log(
      `  database now holds ${totals[0]?.results} results, ${totals[0]?.cases} test cases, ` +
        `${totals[0]?.runs} runs`,
    );

    // ── measure the queries the UI issues ────────────────────────────────────
    const biggest = await sql<{ id: string; total: number }[]>`
      SELECT id, total FROM runs WHERE project_id = ${projectId} ORDER BY total DESC LIMIT 1
    `;
    const busiestRunId = biggest[0]?.id as string;

    console.log("\n→ read-path timings (p95 of 20 iterations)");
    const measurements: Record<string, number> = {
      runList: await measure(() => listRuns(sql, { orgId }, { limit: 25 })),
      tagFacets: await measure(() => tagFacets(sql, { orgId }, { limit: 24 })),
      filterOptions: await measure(() => runFilterOptions(sql, { orgId })),
      runResults: await measure(() => listRunResults(sql, { runId: busiestRunId }, { limit: 200 })),
      suiteSummary: await measure(() => summarizeRunSuites(sql, busiestRunId)),
    };

    let failures = 0;
    for (const [name, p95] of Object.entries(measurements)) {
      const budget = BUDGETS_MS[name as keyof typeof BUDGETS_MS];
      const ok = p95 <= budget;
      if (!ok) failures += 1;
      console.log(
        `  ${ok ? "✓" : "✗"} ${name.padEnd(15)} ${p95.toFixed(0).padStart(5)}ms  (budget ${budget}ms)`,
      );
    }

    if (failures > 0) {
      console.error(`\n✗ ${failures} query/queries exceeded the budget`);
      process.exitCode = 1;
      return;
    }
    console.log("\n✓ all read-path queries within budget");
  } finally {
    await sql.end({ timeout: 10 });
  }
}

async function measure(run: () => Promise<unknown>, iterations = 20): Promise<number> {
  // One warm-up so the measurement reflects a prepared plan and warm cache, which is
  // the steady state a user experiences.
  await run();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const start = performance.now();
    await run();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length * 0.95)] ?? samples.at(-1) ?? 0;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
