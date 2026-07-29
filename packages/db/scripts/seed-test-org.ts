import { eq } from "drizzle-orm";
import type { CanonicalTestResult } from "@testcenter/core";
import { createClient } from "../src/client.js";
import {
  createOrganization,
  createProject,
  requireOrgAccess,
  upsertUserOnSignIn,
} from "../src/access.js";
import { generateApiToken } from "../src/bootstrap.js";
import {
  addRunTotals,
  finalizeRun,
  persistResultBatch,
  refreshTestCaseStats,
  rollupProjectDay,
} from "../src/ingest.js";
import { maintainPartitions, drainDefaultPartition } from "../src/partitions.js";
import * as schema from "../src/schema.js";
import { requireDatabaseUrl } from "./load-env.js";

/**
 * Seeds a Test Organisation to develop and judge the product against.
 *
 * The point is *believable* data, not merely a lot of it. Dashboards and flakiness
 * views look fine on random noise and fall apart on real shapes, so this generates
 * the shapes that actually occur:
 *
 *   - a genuinely flaky test that passes on retry perhaps a fifth of the time
 *   - a test that broke on a specific day and has failed consistently since
 *   - a test with two distinct failure modes, so the grouping view has something
 *     real to separate
 *   - a test whose duration regresses steadily, for the duration trend
 *   - weekends with no runs, so gaps in the charts are exercised
 *   - several projects across different frameworks, and multiple branches
 *
 * Re-running is safe: it targets a fixed org slug and skips seeding if runs already
 * exist, so it will not silently double the history.
 */
const ORG_NAME = "Test Organisation";
const ORG_SLUG = "test-organisation";

interface ProjectSpec {
  key: string;
  name: string;
  framework: string;
  suites: string[];
  testsPerSuite: number;
  /** Runs per weekday. */
  runsPerDay: number;
}

const PROJECTS: ProjectSpec[] = [
  {
    key: "checkout-web",
    name: "Checkout Web",
    framework: "playwright",
    suites: [
      "specs/checkout/payment.spec.ts",
      "specs/checkout/cart.spec.ts",
      "specs/checkout/address.spec.ts",
      "specs/auth/login.spec.ts",
    ],
    testsPerSuite: 12,
    runsPerDay: 3,
  },
  {
    key: "orders-api",
    name: "Orders API",
    framework: "pytest",
    suites: [
      "tests/orders/test_create.py",
      "tests/orders/test_refund.py",
      "tests/orders/test_search.py",
    ],
    testsPerSuite: 18,
    runsPerDay: 4,
  },
  {
    key: "payments-service",
    name: "Payments Service",
    framework: "junit",
    suites: ["com.acme.payments.GatewayTest", "com.acme.payments.SettlementTest"],
    testsPerSuite: 15,
    runsPerDay: 2,
  },
  {
    key: "mobile-app",
    name: "Mobile App",
    framework: "jest",
    suites: ["src/screens/Cart.test.tsx", "src/screens/Profile.test.tsx"],
    testsPerSuite: 10,
    runsPerDay: 1,
  },
];

const BRANCHES = ["main", "main", "main", "develop", "release/24.9", "feature/checkout-redesign"];
const ENVIRONMENTS = ["production", "staging", "staging"];

/** Deterministic PRNG so a reseed produces the same story. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x100000000;
  };
}

interface TestPersona {
  kind: "stable" | "flaky" | "broken-since" | "two-modes" | "slowing" | "occasional";
  /** Day index (from the start of the window) at which a break begins. */
  brokeOnDay?: number;
}

function personaFor(index: number): TestPersona {
  // A realistic suite is mostly stable with a handful of problem tests. Making a
  // third of them flaky would produce a dashboard nobody would believe.
  if (index % 37 === 3) return { kind: "flaky" };
  if (index % 53 === 7) return { kind: "broken-since", brokeOnDay: 18 };
  if (index % 61 === 11) return { kind: "two-modes" };
  if (index % 71 === 13) return { kind: "slowing" };
  if (index % 29 === 5) return { kind: "occasional" };
  return { kind: "stable" };
}

async function main(): Promise<void> {
  const databaseUrl = requireDatabaseUrl();
  const windowDays = Number(process.argv[2] ?? 45);
  const random = makeRandom(20260729);

  const client = createClient({
    databaseUrl,
    maxConnections: 6,
    statementTimeoutMs: 300_000,
    applicationName: "testcenter-seed",
  });
  const { sql, db } = client;

  try {
    // ── people ───────────────────────────────────────────────────────────────
    const owner = (
      await upsertUserOnSignIn(db, {
        email: "admin@testcenter.dev",
        name: "admin",
        // Platform admin comes from TESTCENTER_ADMIN_EMAILS, never from a seed.
        adminEmails: [],
      })
    ).viewer;

    const existingOrg = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(eq(schema.organizations.slug, ORG_SLUG))
      .limit(1);

    let orgId: string;
    if (existingOrg[0]) {
      orgId = existingOrg[0].id;
      console.log(`→ reusing existing ${ORG_SLUG}`);
    } else {
      const created = await createOrganization(db, { name: ORG_NAME, createdBy: owner });
      orgId = created.orgId;
      console.log(`✓ created organisation ${created.slug}`);
    }

    const context = await requireOrgAccess(db, owner, ORG_SLUG);

    // The account roster lives in seed-users.ts so there is one definition of who
    // exists at which role, rather than two lists that drift apart.
    console.log("→ applying the account roster (see scripts/seed-users.ts)");

    const alreadySeeded = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM runs WHERE org_id = ${orgId}
    `;
    if ((alreadySeeded[0]?.n ?? 0) > 0) {
      console.log(
        `✓ ${alreadySeeded[0]?.n} run(s) already present — skipping generation so history is not duplicated`,
      );
      console.log(`\nRun \`pnpm --filter @testcenter/db seed-users\` to apply the account roster.`);
      return;
    }

    // ── projects and tokens ──────────────────────────────────────────────────
    const projectIds = new Map<string, string>();
    for (const spec of PROJECTS) {
      const created = await createProject(db, {
        context,
        key: spec.key,
        name: spec.name,
        description: `${spec.framework} suite`,
      });
      projectIds.set(spec.key, created.projectId);

      const token = generateApiToken();
      await db.insert(schema.apiTokens).values({
        orgId,
        projectId: created.projectId,
        name: "ci",
        tokenHash: token.hash,
        tokenPrefix: token.prefix,
        scopes: ["runs:write", "runs:read"],
        createdBy: owner.userId,
      });
    }
    console.log(`✓ created ${PROJECTS.length} projects with CI tokens`);

    // Partitions must cover the whole backdated window, or every result lands in
    // DEFAULT and the retention story quietly stops working.
    await maintainPartitions(sql, { lookaheadMonths: 2, retentionMonths: 24 });

    // ── history ──────────────────────────────────────────────────────────────
    const startedAt = Date.now();
    let runsCreated = 0;
    let resultsWritten = 0;

    for (const spec of PROJECTS) {
      const projectId = projectIds.get(spec.key) as string;
      const testNames = spec.suites.flatMap((suite) =>
        Array.from({ length: spec.testsPerSuite }, (_, i) => ({ suite, index: i })),
      );

      for (let dayOffset = windowDays - 1; dayOffset >= 0; dayOffset -= 1) {
        const day = new Date(Date.now() - dayOffset * 86_400_000);
        const weekday = day.getUTCDay();
        // Weekends are quiet — this is what puts real gaps in the charts.
        const runsToday = weekday === 0 || weekday === 6 ? 0 : spec.runsPerDay;

        for (let runIndex = 0; runIndex < runsToday; runIndex += 1) {
          const runStartedAt = new Date(day);
          runStartedAt.setUTCHours(2 + runIndex * 5, Math.floor(random() * 60), 0, 0);

          const branch = BRANCHES[Math.floor(random() * BRANCHES.length)] as string;
          const environment = ENVIRONMENTS[Math.floor(random() * ENVIRONMENTS.length)] as string;
          const dayIndex = windowDays - 1 - dayOffset;

          const inserted = await db
            .insert(schema.runs)
            .values({
              orgId,
              projectId,
              name: runIndex === 0 ? "nightly" : `ci #${runIndex}`,
              framework: spec.framework,
              status: "parsing",
              startedAt: runStartedAt,
              branch,
              environment,
              commitSha: Math.floor(random() * 1e15)
                .toString(16)
                .padStart(40, "0"),
              ciProvider: "github",
              ciBuildId: String(100000 + runsCreated),
              tags: {
                suite: runIndex === 0 ? "regression" : "smoke",
                env: environment,
                browser: spec.framework === "playwright" ? "chromium" : "n/a",
              },
              createdByUserId: owner.userId,
            })
            .returning({ id: schema.runs.id });
          const runId = inserted[0]?.id as string;

          const results: CanonicalTestResult[] = testNames.map(({ suite, index }) => {
            const globalIndex = spec.suites.indexOf(suite) * spec.testsPerSuite + index;
            const persona = personaFor(globalIndex);
            const baseName = `${suite.includes("Test") ? "should" : "test"}_case_${index}`;
            const roll = random();

            let status: CanonicalTestResult["status"] = "passed";
            let retries: CanonicalTestResult["retries"];
            let failure: CanonicalTestResult["failure"];
            let durationMs = 40 + Math.floor(random() * 800);

            switch (persona.kind) {
              case "flaky":
                // Passes on retry about a fifth of the time; occasionally fails outright.
                if (roll < 0.2) {
                  retries = [
                    { attempt: 1, status: "failed" },
                    { attempt: 2, status: "passed" },
                  ];
                } else if (roll < 0.24) {
                  status = "failed";
                  failure = {
                    type: "TimeoutError",
                    message: `waiting for selector timed out after ${1000 + Math.floor(random() * 4000)}ms`,
                    stackTrace: `at ${suite}:${20 + index}\n    at runTest (${suite}:8)`,
                  };
                }
                break;

              case "broken-since":
                if (dayIndex >= (persona.brokeOnDay ?? 0)) {
                  status = "failed";
                  failure = {
                    type: "AssertionError",
                    message: `expected 'Approved' to equal 'Declined'`,
                    stackTrace: `at ${suite}:${45 + index}\n    at assertStatus (${suite}:12)`,
                  };
                }
                break;

              case "two-modes":
                // Two genuinely different causes, so failure-mode grouping has real work.
                if (roll < 0.18) {
                  status = "failed";
                  failure =
                    roll < 0.09
                      ? {
                          type: "ConnectionError",
                          message: "connect ECONNREFUSED 10.0.0.4:5432",
                          stackTrace: `at connectDb (${suite}:31)`,
                        }
                      : {
                          type: "ValidationError",
                          message: "amount must be greater than zero",
                          stackTrace: `at validate (${suite}:77)`,
                        };
                }
                break;

              case "slowing":
                // Steady regression, so the duration trend has a real slope.
                durationMs = 200 + dayIndex * 45 + Math.floor(random() * 60);
                break;

              case "occasional":
                if (roll < 0.03) {
                  status = "failed";
                  failure = {
                    type: "ElementNotFound",
                    message: "#submit not found in the document",
                    stackTrace: `at click (${suite}:${60 + index})`,
                  };
                } else if (roll < 0.06) {
                  status = "skipped";
                }
                break;

              default:
                if (roll < 0.01) status = "skipped";
                break;
            }

            const result: CanonicalTestResult = {
              name: baseName,
              suite,
              classname: suite.replace(/[/.]/g, "."),
              status,
              durationMs,
              startedAt: runStartedAt,
            };
            if (failure) result.failure = failure;
            if (retries) result.retries = retries;
            return result;
          });

          const outcome = await persistResultBatch(sql, {
            orgId,
            projectId,
            runId,
            results,
            runStartedAt,
          });
          await addRunTotals(sql, runId, outcome.totals);
          // finishedAt is stated rather than defaulted, otherwise every backdated run
          // records a finish time of now() and a 40-day-old run reads as "finished just
          // now" on its detail page.
          await finalizeRun(sql, {
            runId,
            status: "complete",
            durationMs: outcome.totals.durationMs,
            finishedAt: new Date(runStartedAt.getTime() + outcome.totals.durationMs),
            framework: spec.framework,
          });
          await rollupProjectDay(sql, { orgId, projectId, day: runStartedAt, branch });

          runsCreated += 1;
          resultsWritten += outcome.written;
        }
      }

      // Stats are refreshed once per project rather than per run: the rollup is the
      // expensive part and only the final state is meaningful.
      const lastRun = await sql<{ id: string }[]>`
        SELECT id FROM runs WHERE project_id = ${projectId} ORDER BY started_at DESC LIMIT 1
      `;
      if (lastRun[0]) {
        await refreshTestCaseStats(sql, { projectId, runId: lastRun[0].id, windowDays: 30 });
      }
      console.log(`  ${spec.key}: seeded`);
    }

    // Backdated rows land in DEFAULT if a month was unprovisioned; sweep them into
    // their real partitions so pruning and retention behave.
    const moved = await drainDefaultPartition(sql);
    if (moved > 0) console.log(`✓ relocated ${moved} backdated row(s) into monthly partitions`);

    const seconds = (Date.now() - startedAt) / 1000;
    console.log(
      `\n✓ seeded ${runsCreated} runs and ${resultsWritten.toLocaleString()} results ` +
        `over ${windowDays} days in ${seconds.toFixed(1)}s`,
    );

    const shape = await sql<{ label: string; value: string }[]>`
      SELECT 'flaky tests' AS label, count(*)::text AS value FROM test_cases
        WHERE org_id = ${orgId} AND flake_score >= 20
      UNION ALL
      SELECT 'tests failing now', count(*)::text FROM test_cases
        WHERE org_id = ${orgId} AND last_status IN ('failed','error')
      UNION ALL
      SELECT 'distinct tests', count(*)::text FROM test_cases WHERE org_id = ${orgId}
      UNION ALL
      SELECT 'days with runs', count(DISTINCT day)::text FROM project_daily_stats
        WHERE org_id = ${orgId}
    `;
    for (const row of shape) console.log(`  ${row.label.padEnd(20)} ${row.value}`);

    console.log(`\nNow run: pnpm --filter @testcenter/db seed-users`);
    console.log(`Then sign in at /signin — email only, no password.`);
  } finally {
    await sql.end({ timeout: 10 });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
