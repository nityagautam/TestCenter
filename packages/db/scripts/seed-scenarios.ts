import { eq } from "drizzle-orm";
import type { CanonicalTestResult } from "@testcenter/core";
import { createClient } from "../src/client.js";
import { createProject, requireOrgAccess, findViewerByEmail } from "../src/access.js";
import {
  addRunTotals,
  finalizeRun,
  persistResultBatch,
  refreshTestCaseStats,
  rollupProjectDay,
} from "../src/ingest.js";
import { setQuarantine } from "../src/insights.js";
import { drainDefaultPartition, maintainPartitions } from "../src/partitions.js";
import * as schema from "../src/schema.js";
import { requireDatabaseUrl } from "./load-env.js";

/**
 * Seeds the awkward cases, so every UI state is reachable without contriving one by hand.
 *
 * `seed-test-org` produces believable *average* history — that is what dashboards and
 * flakiness need. This produces the opposite: the states that break layouts and reveal
 * unhandled branches. A parsing spinner, a failed import, a run with no tests, a test
 * name long enough to blow out a table cell, a 200-line stack trace, ten thousand results
 * in one run, unicode, and a quarantined test.
 *
 *   pnpm --filter @testcenter/db seed-scenarios [org-slug]
 *
 * Idempotent by project key: re-running replaces the scenario projects rather than
 * stacking duplicates on top of them.
 */
const SCENARIO_PROJECTS = {
  states: { key: "scenario-states", name: "Scenarios · Run states" },
  content: { key: "scenario-content", name: "Scenarios · Awkward content" },
  scale: { key: "scenario-scale", name: "Scenarios · Scale" },
  empty: { key: "scenario-empty", name: "Scenarios · No data" },
} as const;

const LONG_NAME =
  "test_that_the_checkout_flow_correctly_applies_a_percentage_discount_when_the_" +
  "customer_has_a_loyalty_tier_of_gold_and_the_cart_contains_more_than_three_" +
  "eligible_items_across_two_or_more_distinct_merchant_categories";

const LONG_SUITE =
  "packages/checkout/src/features/discounts/__tests__/integration/loyalty/" +
  "tier-based-percentage-discounts.integration.spec.ts";

const DEEP_STACK = Array.from(
  { length: 60 },
  (_, i) =>
    `    at ${["resolve", "apply", "validate", "compute", "reduce"][i % 5]}Discount ` +
    `(packages/checkout/src/features/discounts/engine/step-${i}.ts:${40 + i * 7}:${11 + (i % 9)})`,
).join("\n");

const NOISY_STDOUT = Array.from(
  { length: 120 },
  (_, i) =>
    `[${new Date(Date.UTC(2026, 6, 20, 2, i % 60)).toISOString()}] gateway poll #${i} → 503`,
).join("\n");

interface RunSpec {
  name: string;
  status: "pending" | "parsing" | "complete" | "partial" | "failed";
  branch?: string;
  environment?: string;
  tags?: Record<string, string>;
  warnings?: { code: string; message: string }[];
  prNumber?: number;
  ciJobUrl?: string;
  shard?: { groupId: string; index: number; total: number };
  attempt?: number;
  hoursAgo: number;
  results: CanonicalTestResult[];
}

async function main(): Promise<void> {
  const databaseUrl = requireDatabaseUrl();
  const orgSlug = process.argv[2] ?? "test-organisation";

  const { sql, db } = createClient({
    databaseUrl,
    maxConnections: 4,
    statementTimeoutMs: 300_000,
    applicationName: "testcenter-scenarios",
  });

  try {
    const owner = await findViewerByEmail(db, "admin@testcenter.dev");
    if (!owner) {
      console.error("✗ admin@testcenter.dev not found. Run `seed-users` first.");
      process.exit(1);
    }
    const context = await requireOrgAccess(db, owner, orgSlug);
    console.log(`→ ${context.org.name} (${orgSlug})\n`);

    await maintainPartitions(sql, { lookaheadMonths: 2, retentionMonths: 24 });

    // Replace rather than append, so the scenario set stays exactly as described.
    for (const spec of Object.values(SCENARIO_PROJECTS)) {
      const existing = await db
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(eq(schema.projects.key, spec.key))
        .limit(1);
      if (existing[0]) {
        await db.delete(schema.projects).where(eq(schema.projects.id, existing[0].id));
        console.log(`  reset ${spec.key}`);
      }
    }

    const projectIds = new Map<string, string>();
    for (const spec of Object.values(SCENARIO_PROJECTS)) {
      const created = await createProject(db, { context, key: spec.key, name: spec.name });
      projectIds.set(spec.key, created.projectId);
    }
    console.log(`✓ created ${Object.keys(SCENARIO_PROJECTS).length} scenario projects\n`);

    // ── every run state the UI can render ────────────────────────────────────
    const stateRuns: RunSpec[] = [
      {
        name: "pending — created, awaiting upload",
        status: "pending",
        hoursAgo: 0,
        branch: "main",
        results: [],
      },
      {
        name: "parsing — worker in progress",
        status: "parsing",
        hoursAgo: 0,
        branch: "main",
        // Exercises the live progress banner and the SSE stream.
        results: [],
      },
      {
        name: "failed — report could not be parsed",
        status: "failed",
        hoursAgo: 1,
        branch: "main",
        warnings: [
          {
            code: "xml_malformed",
            message: "malformed JUnit XML: unclosed tag: testsuite at line 4102",
          },
        ],
        results: [],
      },
      {
        name: "partial — parsed with warnings",
        status: "partial",
        hoursAgo: 2,
        branch: "main",
        warnings: [
          {
            code: "illegal_xml_chars",
            message:
              "removed 1,284 character(s) that are illegal in XML (usually ANSI colour codes captured in test output)",
          },
          {
            code: "truncated_document",
            message: "report ended unexpectedly (unclosed tag: testcase); parsed results were kept",
          },
          {
            code: "dedup_limit_reached",
            message:
              'suite "specs/mega.spec.ts" exceeded 20000 distinct tests; retry collapsing was disabled for the remainder to bound memory',
          },
        ],
        results: [
          {
            name: "survived_truncation",
            status: "passed",
            suite: "specs/partial.spec.ts",
            durationMs: 120,
          },
          {
            name: "failed_before_truncation",
            status: "failed",
            suite: "specs/partial.spec.ts",
            durationMs: 800,
            failure: { type: "AssertionError", message: "expected 200 to equal 500" },
          },
        ],
      },
      {
        name: "all green",
        status: "complete",
        hoursAgo: 3,
        branch: "main",
        environment: "production",
        tags: { suite: "smoke", env: "production" },
        results: Array.from({ length: 12 }, (_, i) => ({
          name: `green_case_${i}`,
          status: "passed" as const,
          suite: "specs/green.spec.ts",
          durationMs: 40 + i * 12,
        })),
      },
      {
        name: "all red",
        status: "complete",
        hoursAgo: 4,
        branch: "feature/broken-gateway",
        environment: "staging",
        tags: { suite: "regression", env: "staging" },
        results: Array.from({ length: 9 }, (_, i) => ({
          name: `red_case_${i}`,
          status: "failed" as const,
          suite: "specs/red.spec.ts",
          durationMs: 900 + i * 40,
          failure: {
            type: "ConnectionError",
            message: "connect ECONNREFUSED 10.0.0.4:5432",
            stackTrace: `    at connectGateway (specs/red.spec.ts:${20 + i}:9)`,
          },
        })),
      },
      {
        name: "mostly skipped",
        status: "complete",
        hoursAgo: 5,
        branch: "main",
        tags: { suite: "nightly" },
        results: [
          { name: "ran_anyway", status: "passed", suite: "specs/skip.spec.ts", durationMs: 60 },
          ...Array.from({ length: 14 }, (_, i) => ({
            name: `skipped_case_${i}`,
            status: "skipped" as const,
            suite: "specs/skip.spec.ts",
            message: i % 2 === 0 ? "requires staging credentials" : "flaky on CI, see PAY-1234",
          })),
        ],
      },
      {
        name: "errors, not failures",
        status: "complete",
        hoursAgo: 6,
        branch: "main",
        results: Array.from({ length: 5 }, (_, i) => ({
          name: `errored_case_${i}`,
          status: "error" as const,
          suite: "specs/error.spec.ts",
          durationMs: 15,
          failure: {
            type: "RuntimeError",
            message: "fixture 'db' not found",
            stackTrace: "    at conftest.py:12",
          },
        })),
      },
      {
        name: "retries everywhere",
        status: "complete",
        hoursAgo: 7,
        branch: "main",
        tags: { suite: "regression" },
        results: [
          {
            name: "passed_on_third_attempt",
            status: "passed",
            suite: "specs/retry.spec.ts",
            durationMs: 4200,
            retries: [
              {
                attempt: 1,
                status: "failed",
                failure: { type: "TimeoutError", message: "waiting for selector" },
              },
              {
                attempt: 2,
                status: "failed",
                failure: { type: "TimeoutError", message: "waiting for selector" },
              },
              { attempt: 3, status: "passed" },
            ],
          },
          {
            name: "never_recovered",
            status: "failed",
            suite: "specs/retry.spec.ts",
            durationMs: 9100,
            failure: {
              type: "TimeoutError",
              message: "waiting for selector timed out after 30000ms",
            },
            retries: [
              { attempt: 1, status: "failed" },
              { attempt: 2, status: "failed" },
              { attempt: 3, status: "failed" },
            ],
          },
        ],
      },
      // Sharded: one logical run reported by four CI jobs. Currently surfaces as four
      // runs, which is exactly the state the merge work in the backlog has to fix.
      ...Array.from({ length: 4 }, (_, shard) => ({
        name: `sharded nightly (${shard + 1}/4)`,
        status: "complete" as const,
        hoursAgo: 9,
        branch: "main",
        environment: "staging",
        tags: { suite: "regression", shard: String(shard + 1) },
        shard: { groupId: "gh-run-88213", index: shard, total: 4 },
        ciJobUrl: `https://github.example.com/acme/checkout/actions/runs/88213/job/${shard + 1}`,
        results: Array.from({ length: 6 }, (_, i) => ({
          name: `shard_${shard}_case_${i}`,
          status: (i === 0 && shard === 2 ? "failed" : "passed") as "failed" | "passed",
          suite: `specs/shard-${shard}.spec.ts`,
          durationMs: 100 + i * 30,
          ...(i === 0 && shard === 2
            ? { failure: { type: "AssertionError", message: "shard 3 disagreed" } }
            : {}),
        })),
      })),
      {
        name: "pull request check",
        status: "complete",
        hoursAgo: 11,
        branch: "feature/checkout-redesign",
        environment: "staging",
        prNumber: 4821,
        ciJobUrl: "https://github.example.com/acme/checkout/actions/runs/88190",
        tags: { suite: "pr", env: "staging" },
        results: [
          { name: "pr_case_ok", status: "passed", suite: "specs/pr.spec.ts", durationMs: 210 },
          {
            name: "pr_case_regressed",
            status: "failed",
            suite: "specs/pr.spec.ts",
            durationMs: 640,
            failure: {
              type: "AssertionError",
              message: "expected discount 10% to equal 15%",
              stackTrace: "    at applyDiscount (src/checkout/discount.ts:88:12)",
            },
          },
        ],
      },
      {
        name: "re-run of a failed build",
        status: "complete",
        hoursAgo: 12,
        branch: "main",
        attempt: 3,
        results: [
          {
            name: "eventually_green",
            status: "passed",
            suite: "specs/rerun.spec.ts",
            durationMs: 300,
          },
        ],
      },
      {
        name: "empty report — parsed, no tests",
        status: "partial",
        hoursAgo: 13,
        branch: "main",
        warnings: [{ code: "no_results", message: "the report contained no <testcase> elements" }],
        results: [],
      },
      {
        name: "heavily tagged",
        status: "complete",
        hoursAgo: 14,
        branch: "release/24.9",
        environment: "production",
        tags: {
          suite: "regression",
          env: "production",
          browser: "chromium",
          device: "pixel-8",
          platform: "android-14",
          release: "24.9.3",
          owner: "payments",
          severity: "p1",
          component: "checkout-discounts",
          shard: "1",
        },
        results: [
          { name: "tagged_case", status: "passed", suite: "specs/tags.spec.ts", durationMs: 150 },
        ],
      },
    ];

    await seedRuns(
      sql,
      db,
      context.org.id,
      projectIds.get(SCENARIO_PROJECTS.states.key) as string,
      stateRuns,
      owner.userId,
    );
    console.log(`  ${SCENARIO_PROJECTS.states.key}: ${stateRuns.length} runs covering every state`);

    // ── content that stresses layout ─────────────────────────────────────────
    const contentRuns: RunSpec[] = [
      {
        name: "long names, unicode, deep stacks",
        status: "complete",
        hoursAgo: 1,
        branch: "main",
        tags: { suite: "edge-cases" },
        results: [
          {
            name: LONG_NAME,
            status: "failed",
            suite: LONG_SUITE,
            classname: "LoyaltyTierDiscountIntegrationSpec",
            durationMs: 18_400,
            failure: {
              type: "org.junit.ComparisonFailure",
              message:
                'expected:<{"discount":0.15,"tier":"gold","items":4,"categories":2}> ' +
                'but was:<{"discount":0.10,"tier":"gold","items":4,"categories":2}>',
              stackTrace: DEEP_STACK,
            },
            stdout: NOISY_STDOUT,
          },
          {
            name: "測試付款流程 · العربية · тест · 🎯 emoji in a test name",
            status: "failed",
            suite: "specs/i18n/多言語.spec.ts",
            durationMs: 240,
            failure: { type: "AssertionError", message: "期待された値と一致しません" },
          },
          {
            name: "test_applies_discount[tier=gold-items=4-categories=2-currency=INR]",
            status: "passed",
            suite: "tests/cart/test_totals.py",
            parameters: { tier: "gold", items: 4, categories: 2, currency: "INR" },
            durationMs: 95,
          },
          { name: "sub_millisecond", status: "passed", suite: "specs/fast.spec.ts", durationMs: 0 },
          {
            name: "very_slow_soak_test",
            status: "passed",
            suite: "specs/soak.spec.ts",
            durationMs: 1_920_000,
          },
          {
            name: "no_message_only_a_stack",
            status: "failed",
            suite: "specs/bare.spec.ts",
            durationMs: 70,
            failure: { stackTrace: "    at unknown (specs/bare.spec.ts:1:1)" },
          },
          {
            name: "stderr_only",
            status: "failed",
            suite: "specs/bare.spec.ts",
            durationMs: 70,
            failure: { type: "Error", message: "process exited with code 137 (OOM)" },
            stderr: "Killed\nheap limit 2048MB exceeded\n",
          },
          {
            name: "result_level_tags",
            status: "failed",
            suite: "specs/tagged-result.spec.ts",
            durationMs: 300,
            tags: { severity: "p1", jira: "PAY-1234", owner: "payments" },
            failure: { type: "AssertionError", message: "tagged failure" },
          },
        ],
      },
      // A second run so these tests have history rather than a single data point.
      {
        name: "same suite, one day earlier",
        status: "complete",
        hoursAgo: 26,
        branch: "main",
        tags: { suite: "edge-cases" },
        results: [
          {
            name: LONG_NAME,
            status: "passed",
            suite: LONG_SUITE,
            classname: "LoyaltyTierDiscountIntegrationSpec",
            durationMs: 12_100,
          },
          {
            name: "測試付款流程 · العربية · тест · 🎯 emoji in a test name",
            status: "passed",
            suite: "specs/i18n/多言語.spec.ts",
            durationMs: 210,
          },
          {
            name: "no_message_only_a_stack",
            status: "passed",
            suite: "specs/bare.spec.ts",
            durationMs: 60,
          },
        ],
      },
      // Three distinct signatures on one test, so the failure-mode grouping has more
      // than two groups to separate.
      ...Array.from({ length: 9 }, (_, i) => {
        const modes = [
          {
            type: "ConnectionError",
            message: "connect ECONNREFUSED 10.0.0.4:5432",
            frame: "connectDb",
          },
          {
            type: "ValidationError",
            message: "amount must be greater than zero",
            frame: "validate",
          },
          {
            type: "TimeoutError",
            message: "gateway did not respond within 30000ms",
            frame: "awaitGateway",
          },
        ];
        const mode = modes[i % 3] as (typeof modes)[number];
        return {
          name: `three modes, occurrence ${i + 1}`,
          status: "complete" as const,
          hoursAgo: 30 + i * 6,
          branch: "main",
          results: [
            {
              name: "test_three_distinct_failure_modes",
              status: "failed" as const,
              suite: "specs/multi-mode.spec.ts",
              durationMs: 400 + i * 25,
              failure: {
                type: mode.type,
                message: mode.message,
                stackTrace: `    at ${mode.frame} (specs/multi-mode.spec.ts:${30 + i}:7)`,
              },
            },
          ],
        };
      }),
    ];

    await seedRuns(
      sql,
      db,
      context.org.id,
      projectIds.get(SCENARIO_PROJECTS.content.key) as string,
      contentRuns,
      owner.userId,
    );
    console.log(
      `  ${SCENARIO_PROJECTS.content.key}: ${contentRuns.length} runs of awkward content`,
    );

    // ── scale: one run big enough to hurt an unvirtualized table ─────────────
    const bigCount = Number(process.argv[3] ?? 5000);
    const scaleRun: RunSpec = {
      name: `wide run — ${bigCount.toLocaleString()} tests`,
      status: "complete",
      hoursAgo: 2,
      branch: "main",
      environment: "staging",
      tags: { suite: "regression", env: "staging" },
      results: Array.from({ length: bigCount }, (_, i) => {
        const failed = i % 97 === 0;
        const flaky = !failed && i % 503 === 0;
        return {
          name: `scale_case_${String(i).padStart(5, "0")}`,
          status: (failed ? "failed" : "passed") as "failed" | "passed",
          suite: `specs/scale/group-${String(i % 40).padStart(2, "0")}.spec.ts`,
          classname: `ScaleGroup${i % 40}`,
          durationMs: 5 + (i % 400),
          ...(failed
            ? {
                failure: {
                  type: "AssertionError",
                  message: `expected ${i} to equal ${i + 1}`,
                  stackTrace: `    at check (specs/scale/group-${i % 40}.spec.ts:${i % 200}:5)`,
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
      }),
    };
    await seedRuns(
      sql,
      db,
      context.org.id,
      projectIds.get(SCENARIO_PROJECTS.scale.key) as string,
      [scaleRun],
      owner.userId,
    );
    console.log(
      `  ${SCENARIO_PROJECTS.scale.key}: 1 run with ${bigCount.toLocaleString()} results`,
    );

    console.log(`  ${SCENARIO_PROJECTS.empty.key}: no runs (empty-state project)`);

    // ── quarantine two tests so that filter and badge have subjects ──────────
    for (const key of [SCENARIO_PROJECTS.content.key, SCENARIO_PROJECTS.states.key]) {
      const projectId = projectIds.get(key) as string;
      await refreshAll(sql, projectId);
      const candidates = await sql<{ id: number }[]>`
        SELECT id FROM test_cases
        WHERE project_id = ${projectId} AND failures_30d > 0
        ORDER BY failures_30d DESC LIMIT 1
      `;
      if (candidates[0]) {
        await setQuarantine(sql, {
          orgId: context.org.id,
          testCaseId: candidates[0].id,
          quarantined: true,
          reason: "known flaky under parallel load — tracked in PAY-1291",
        });
      }
    }
    console.log(`✓ quarantined 2 tests`);

    const moved = await drainDefaultPartition(sql);
    if (moved > 0) console.log(`✓ relocated ${moved} backdated row(s) into monthly partitions`);

    const shape = await sql<{ label: string; value: string }[]>`
      SELECT 'runs'         AS label, count(*)::text AS value FROM runs WHERE org_id = ${context.org.id}
      UNION ALL SELECT 'results',    count(*)::text FROM test_results WHERE org_id = ${context.org.id}
      UNION ALL SELECT 'test cases', count(*)::text FROM test_cases   WHERE org_id = ${context.org.id}
      UNION ALL SELECT 'quarantined',count(*)::text FROM test_cases   WHERE org_id = ${context.org.id} AND quarantined
      UNION ALL SELECT 'flaky >=20', count(*)::text FROM test_cases   WHERE org_id = ${context.org.id} AND flake_score >= 20
      UNION ALL SELECT 'with warnings', count(*)::text FROM runs      WHERE org_id = ${context.org.id} AND warnings <> '[]'::jsonb
    `;
    console.log("");
    for (const row of shape) console.log(`  ${row.label.padEnd(14)} ${row.value}`);
  } finally {
    await sql.end({ timeout: 10 });
  }
}

/** Writes a batch of runs, keeping non-terminal states genuinely non-terminal. */
async function seedRuns(
  sql: ReturnType<typeof createClient>["sql"],
  db: ReturnType<typeof createClient>["db"],
  orgId: string,
  projectId: string,
  specs: RunSpec[],
  userId: string,
): Promise<void> {
  for (const spec of specs) {
    const startedAt = new Date(Date.now() - spec.hoursAgo * 3_600_000);

    const inserted = await db
      .insert(schema.runs)
      .values({
        orgId,
        projectId,
        name: spec.name,
        framework: "junit",
        // pending and parsing are stored as-is: the point is to render those states.
        status: spec.status === "complete" || spec.status === "partial" ? "parsing" : spec.status,
        startedAt,
        branch: spec.branch ?? null,
        environment: spec.environment ?? null,
        commitSha: Math.floor(Math.random() * 1e15)
          .toString(16)
          .padStart(40, "0"),
        prNumber: spec.prNumber ?? null,
        ciProvider: "github",
        ciJobUrl: spec.ciJobUrl ?? null,
        runGroupId: spec.shard?.groupId ?? null,
        shardIndex: spec.shard?.index ?? null,
        shardTotal: spec.shard?.total ?? null,
        attempt: spec.attempt ?? 1,
        tags: spec.tags ?? {},
        createdByUserId: userId,
      })
      .returning({ id: schema.runs.id });
    const runId = inserted[0]?.id as string;

    let testDurationMs = 0;
    if (spec.results.length > 0) {
      // Chunked so a 5,000-test run exercises the same batched path as a real ingest.
      const BATCH = 500;
      for (let offset = 0; offset < spec.results.length; offset += BATCH) {
        const outcome = await persistResultBatch(sql, {
          orgId,
          projectId,
          runId,
          results: spec.results.slice(offset, offset + BATCH),
          runStartedAt: startedAt,
        });
        await addRunTotals(sql, runId, outcome.totals);
        testDurationMs += outcome.totals.durationMs;
      }
    }

    if (spec.status === "complete" || spec.status === "partial" || spec.status === "failed") {
      /*
       * Both the duration and the finish time are stated explicitly.
       *
       * `finalizeRun` defaults to now() and derives the duration from started_at, which
       * is right for a live ingest and wrong for backdated seed data: a run placed 30
       * hours in the past came out with a 30-hour duration, and the dashboard duly
       * reported an average run duration of 3h 18m. Wall clock is the wrong measure here
       * anyway — the honest number is the time the tests took, plus a little fixed
       * overhead for setup and teardown.
       */
      const durationMs = testDurationMs + 4_000;
      await finalizeRun(sql, {
        runId,
        status: spec.status,
        framework: "junit",
        durationMs,
        finishedAt: new Date(startedAt.getTime() + durationMs),
        warnings: spec.warnings ?? [],
      });
      await rollupProjectDay(sql, {
        orgId,
        projectId,
        day: startedAt,
        branch: spec.branch ?? null,
      });
    }
  }
  await refreshAll(sql, projectId);
}

/**
 * Refreshes per-test rollups across every run in a project.
 *
 * `refreshTestCaseStats` scopes itself to the test cases touched by the run it is handed,
 * which is right in production — an ingest only needs to recompute what it just changed.
 * Here it needs coaxing twice over. Refreshing from the *latest* run picked one of the
 * deliberately empty ones (pending, parsing, failed-to-parse) and touched nothing at all;
 * refreshing from the largest run covered that run's tests but left every test appearing
 * only in the other runs with a zero fail rate and zero flake score. Since these projects
 * hold tens of runs rather than thousands, walking all of them is both cheap and exact.
 */
async function refreshAll(
  sql: ReturnType<typeof createClient>["sql"],
  projectId: string,
): Promise<void> {
  const runs = await sql<{ id: string }[]>`
    SELECT id FROM runs WHERE project_id = ${projectId} AND total > 0 ORDER BY started_at
  `;
  for (const run of runs) {
    await refreshTestCaseStats(sql, { projectId, runId: run.id, windowDays: 90 });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
