import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createClient, type Database, type Sql } from "./client.js";
import { bootstrap } from "./bootstrap.js";
import {
  addRunTotals,
  finalizeRun,
  persistResultBatch,
  refreshTestCaseStats,
  rollupProjectDay,
} from "./ingest.js";
import {
  branchPassRates,
  dailySeries,
  dailySeriesByBranch,
  failureConcentration,
  flakeDistribution,
  flakyLeaderboard,
  getTestCase,
  listSuites,
  orgSummary,
  recentOutcomes,
  searchTests,
  setQuarantine,
  slowestTests,
  testDurationHistory,
  testExecutionDetails,
  testExecutions,
  testFailureDetails,
  testFailureModes,
  todaysRuns,
  topFailingTests,
} from "./insights.js";
import * as schema from "./schema.js";

/**
 * Read-path tests for insights.ts against a real Postgres.
 *
 * Every query in this module is built by string composition, which means its failure mode
 * is a syntax or semantics error that only appears when it runs. That is not hypothetical
 * here: `runFilterOptions` shipped with a bare `ORDER BY` inside a `UNION` branch and took
 * the run list down with a 500. `queries.test.ts` exists because of that, but it covers
 * `queries.ts` — this module, which is every dashboard tile, every chart, the test history
 * page, the flaky leaderboard and test search, had no test importing it at all.
 *
 * So the first job of this file is coverage: call each exported function at least once, so a
 * query that cannot even parse fails here rather than on someone's dashboard.
 *
 * The second job is arithmetic. "It did not throw" would have missed the bugs this project
 * actually had — a pass rate that counted skips in its denominator, a flake score that
 * ranked a one-run test above a test flaking for weeks. So the fixture below is a *known
 * shape* and the assertions check the numbers that come out of it.
 *
 * The fixture, built once in `beforeAll`:
 *
 *   3 runs on `main` and 1 on `release/1.0`, all today, one project.
 *   - `steady`      passes in every run
 *   - `broken`      fails in every run, with one failure type — consistently broken
 *   - `flaky`       passes on retry in 3 of 4 runs — genuinely flaky
 *   - `two-modes`   fails in 2 runs with two *different* failure signatures
 *   - `skipper`     skipped in every run, so it must stay out of pass-rate denominators
 *   - `slowpoke`    passes, but two orders of magnitude slower than anything else
 */
const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

/** Its own organisation, dropped afterwards — see the note in queries.test.ts (A17). */
const testOrgSlug = `test-insights-${Math.random().toString(36).slice(2, 10)}`;

const STEADY = "insights_steady";
const BROKEN = "insights_broken";
const FLAKY = "insights_flaky";
const TWO_MODES = "insights_two_modes";
const SKIPPER = "insights_skipper";
const SLOWPOKE = "insights_slowpoke";

describeIfDb("insights read path", () => {
  let sql: Sql;
  let db: Database;
  let orgId: string;
  let projectId: string;
  const runIds: string[] = [];

  beforeAll(async () => {
    const client = createClient({ databaseUrl: databaseUrl as string, maxConnections: 4 });
    sql = client.sql;
    db = client.db;
    const boot = await bootstrap(db, {
      orgSlug: testOrgSlug,
      orgName: "Insights Test Org",
      projectKey: "insights-test",
      projectName: "Insights Test",
    });
    orgId = boot.orgId;
    projectId = boot.projectId;

    const retry = [
      { attempt: 1, status: "failed" as const },
      { attempt: 2, status: "passed" as const },
    ];

    for (let index = 0; index < 4; index += 1) {
      const branch = index === 3 ? "release/1.0" : "main";
      // Spread across today so `todaysRuns` and `runsToday` have several to order.
      const startedAt = new Date(Date.now() - (4 - index) * 60 * 60 * 1000);

      const results = [
        { name: STEADY, status: "passed" as const, suite: "specs/a.spec.ts", durationMs: 100 },
        {
          name: BROKEN,
          status: "failed" as const,
          suite: "specs/a.spec.ts",
          durationMs: 200,
          failure: {
            type: "AssertionError",
            message: "expected 1 to equal 2",
            stackTrace: "    at check (specs/a.spec.ts:10:3)",
          },
        },
        {
          name: FLAKY,
          status: "passed" as const,
          suite: "specs/b.spec.ts",
          durationMs: 150,
          // Flaky in 3 of 4 runs, so the score is well-evidenced rather than a single point.
          ...(index < 3 ? { retries: retry } : {}),
        },
        {
          name: SKIPPER,
          status: "skipped" as const,
          suite: "specs/b.spec.ts",
          message: "needs credentials",
        },
        {
          name: SLOWPOKE,
          status: "passed" as const,
          suite: "specs/slow.spec.ts",
          durationMs: 90_000,
        },
        // Two distinct signatures on one test, in two of the four runs.
        ...(index < 2
          ? [
              {
                name: TWO_MODES,
                status: "failed" as const,
                suite: "specs/c.spec.ts",
                durationMs: 300,
                failure:
                  index === 0
                    ? {
                        type: "TimeoutError",
                        message: "waited 30000ms",
                        stackTrace: "    at wait (specs/c.spec.ts:5:1)",
                      }
                    : {
                        type: "ConnectionError",
                        message: "ECONNREFUSED 10.0.0.1:5432",
                        stackTrace: "    at connect (specs/c.spec.ts:9:1)",
                      },
                stdout: "step one ok\nstep two ok\n",
              },
            ]
          : []),
      ];

      const inserted = await db
        .insert(schema.runs)
        .values({
          orgId,
          projectId,
          name: `insights run ${index}`,
          framework: "playwright",
          status: "parsing",
          branch,
          environment: "staging",
          startedAt,
        })
        .returning({ id: schema.runs.id });
      const runId = inserted[0]?.id as string;
      runIds.push(runId);

      const { totals } = await persistResultBatch(sql, {
        orgId,
        projectId,
        runId,
        results,
        runStartedAt: startedAt,
      });
      await addRunTotals(sql, runId, totals);
      await finalizeRun(sql, {
        runId,
        status: "complete",
        durationMs: 5_000,
        finishedAt: new Date(startedAt.getTime() + 5_000),
      });
      await rollupProjectDay(sql, { orgId, projectId, day: startedAt, branch });
      await refreshTestCaseStats(sql, { projectId, runId, windowDays: 30 });
    }
  });

  afterAll(async () => {
    if (!sql) return;
    await db.delete(schema.organizations).where(eq(schema.organizations.slug, testOrgSlug));
    await sql.end({ timeout: 5 });
  });

  async function idOf(name: string): Promise<number> {
    const rows = await sql<{ id: number }[]>`
      SELECT id FROM test_cases WHERE project_id = ${projectId} AND name = ${name} LIMIT 1
    `;
    return Number(rows[0]?.id);
  }

  // ── headline numbers ──────────────────────────────────────────────────────

  describe("orgSummary", () => {
    it("counts runs and tests, and keeps skips out of the pass rate", async () => {
      const summary = await orgSummary(sql, { orgId });

      expect(summary.projects).toBe(1);
      expect(summary.runs30d).toBe(4);
      expect(summary.runsToday).toBe(4);
      expect(summary.lastRunAt).not.toBeNull();

      /*
       * 4 runs: two of 6 results and two of 5 (two-modes only appears twice) = 22 results.
       * Of those, 4 are skipped. A skipped test is not a failure and not a pass, so the
       * denominator is 18 — counting skips would make a suite that skips look broken, which
       * is the bug this assertion exists to prevent.
       */
      expect(summary.tests30d).toBe(22);

      const failures = 4 /* broken */ + 2; /* two-modes */
      const expectedPassRate = ((18 - failures) / 18) * 100;
      expect(Number(summary.passRate30d)).toBeCloseTo(expectedPassRate, 1);
    });

    it("reports the flaky and quarantined test counts", async () => {
      const summary = await orgSummary(sql, { orgId });
      // `flaky` retried in 3 of 4 runs; nothing else did.
      expect(summary.flakyTests).toBeGreaterThanOrEqual(1);
      expect(summary.quarantined).toBe(0);
    });

    it("scopes to a project when asked", async () => {
      const scoped = await orgSummary(sql, { orgId, projectId });
      const wide = await orgSummary(sql, { orgId });
      // One project, so the two must agree — a mismatch means the project predicate is
      // applied to some counters and not others.
      expect(scoped.runs30d).toBe(wide.runs30d);
      expect(scoped.tests30d).toBe(wide.tests30d);
    });
  });

  // ── charts ────────────────────────────────────────────────────────────────

  describe("charts", () => {
    it("returns a dense daily series with today populated", async () => {
      const series = await dailySeries(sql, { orgId, days: 30 });
      // Dense, not sparse: a chart needs a point per day or the x-axis lies about gaps.
      expect(series.length).toBe(30);

      const today = series.at(-1);
      expect(today?.runs).toBe(4);
      expect(today?.tests).toBe(22);
      expect(today?.skipped).toBe(4);
      expect(today?.totalDurationMs).toBe(4 * 5_000);
    });

    it("splits the series by branch and caps the branch count", async () => {
      const byBranch = await dailySeriesByBranch(sql, { orgId, days: 30, maxBranches: 5 });
      const names = byBranch.map((entry) => entry.branch);
      expect(names).toContain("main");
      expect(names).toContain("release/1.0");
      expect(byBranch.length).toBeLessThanOrEqual(5);
      for (const entry of byBranch) expect(entry.points.length).toBe(30);
    });

    it("ranks pass rate per branch", async () => {
      const rates = await branchPassRates(sql, { orgId, days: 30 });
      const main = rates.find((entry) => entry.branch === "main");
      expect(main).toBeDefined();
      // main carries 3 of the 4 runs.
      expect(main?.runs).toBe(3);
    });

    it("lists today's runs with a label and per-run outcome counts", async () => {
      // `TodayRun` carries a pre-formatted `label` rather than a timestamp — the chart
      // plots one bar per run of the day, so it needs an axis label, not a Date.
      const runs = await todaysRuns(sql, { orgId, limit: 10 });
      expect(runs.length).toBe(4);
      for (const run of runs) {
        expect(run.label).toBeTruthy();
        expect(run.total).toBeGreaterThan(0);
        // Skips stay out of the denominator here too, as they do everywhere else.
        expect(run.passed + run.failed + run.skipped).toBeLessThanOrEqual(run.total);
      }
      expect(runs.some((run) => run.branch === "release/1.0")).toBe(true);
    });

    it("puts the slowest test first", async () => {
      const slow = await slowestTests(sql, { orgId, limit: 5 });
      expect(slow.length).toBeGreaterThan(0);
      expect(slow[0]?.name).toBe(SLOWPOKE);
    });

    it("concentrates failures onto the tests actually failing", async () => {
      const concentration = await failureConcentration(sql, { orgId, limit: 5 });
      // 4 failures from `broken` plus 2 from `two-modes`.
      expect(concentration.totalFailures).toBe(6);
      expect(concentration.failingTests).toBe(2);
      expect(concentration.tests[0]?.name).toBe(BROKEN);
      // Shares are a proportion of the total, so they cannot exceed it.
      const shareSum = concentration.tests.reduce((sum, test) => sum + Number(test.share), 0);
      expect(shareSum).toBeLessThanOrEqual(100.01);
    });

    it("buckets tests by flake score", async () => {
      const buckets = await flakeDistribution(sql, { orgId });
      expect(buckets.length).toBeGreaterThan(0);
      const total = buckets.reduce((sum, bucket) => sum + bucket.tests, 0);
      // Every test in the project lands in exactly one bucket.
      expect(total).toBe(6);
    });
  });

  // ── search ────────────────────────────────────────────────────────────────

  describe("searchTests", () => {
    it("finds a test by a fragment of its name", async () => {
      const page = await searchTests(sql, { orgId, query: "steady" }, { limit: 10 });
      expect(page.tests.map((test) => test.name)).toContain(STEADY);
      expect(page.total).toBeGreaterThanOrEqual(1);
    });

    it("filters by status", async () => {
      const failing = await searchTests(sql, { orgId, status: "failing" }, { limit: 50 });
      const names = failing.tests.map((test) => test.name);
      expect(names).toContain(BROKEN);
      expect(names).not.toContain(STEADY);

      const flaky = await searchTests(sql, { orgId, status: "flaky" }, { limit: 50 });
      expect(flaky.tests.map((test) => test.name)).toContain(FLAKY);
    });

    it("orders by each supported sort without error", async () => {
      // Every sort is a different ORDER BY spliced into the same statement, so each one is
      // its own chance to be invalid SQL.
      for (const sort of ["recent", "most-failed", "flakiest", "slowest", "name"] as const) {
        const page = await searchTests(sql, { orgId, sort }, { limit: 5 });
        expect(page.tests.length).toBeGreaterThan(0);
      }

      const bySlowest = await searchTests(sql, { orgId, sort: "slowest" }, { limit: 5 });
      expect(bySlowest.tests[0]?.name).toBe(SLOWPOKE);

      const byName = await searchTests(sql, { orgId, sort: "name" }, { limit: 50 });
      const names = byName.tests.map((test) => test.name);
      expect([...names].sort()).toEqual(names);
    });

    it("paginates by offset without repeating a row", async () => {
      const first = await searchTests(sql, { orgId, sort: "name" }, { limit: 2, offset: 0 });
      const second = await searchTests(sql, { orgId, sort: "name" }, { limit: 2, offset: 2 });
      expect(first.tests).toHaveLength(2);
      const overlap = first.tests.filter((a) => second.tests.some((b) => b.id === a.id));
      expect(overlap).toHaveLength(0);
      // `total` describes the whole result set, not the page.
      expect(first.total).toBe(6);
    });

    it("filters by suite", async () => {
      const page = await searchTests(sql, { orgId, suite: "specs/slow.spec.ts" }, { limit: 10 });
      expect(page.tests.map((test) => test.name)).toEqual([SLOWPOKE]);
    });

    it("returns an empty page rather than throwing when nothing matches", async () => {
      const page = await searchTests(sql, { orgId, query: "no-such-test-xyz" }, { limit: 10 });
      expect(page.tests).toEqual([]);
      expect(page.total).toBe(0);
    });
  });

  it("lists suites with their test counts", async () => {
    const suites = await listSuites(sql, { orgId, limit: 25 });
    const byName = new Map(suites.map((entry) => [entry.suite, entry.tests]));
    expect(byName.get("specs/a.spec.ts")).toBe(2);
    expect(byName.get("specs/slow.spec.ts")).toBe(1);
  });

  // ── one test's history ────────────────────────────────────────────────────

  describe("a single test's history", () => {
    it("returns its detail, or null for an id that is not there", async () => {
      const detail = await getTestCase(sql, { orgId, testCaseId: await idOf(BROKEN) });
      expect(detail?.name).toBe(BROKEN);
      expect(detail?.runs30d).toBe(4);
      expect(Number(detail?.failRate30d)).toBe(100);

      // A missing id must be null, not an exception: the page turns it into a 404.
      expect(await getTestCase(sql, { orgId, testCaseId: 0 })).toBeNull();
    });

    it("refuses to read a test from another organisation", async () => {
      // The org predicate is the tenant boundary; without it any id would be readable.
      const otherOrg = "00000000-0000-7000-8000-0000000000ff";
      expect(
        await getTestCase(sql, { orgId: otherOrg, testCaseId: await idOf(BROKEN) }),
      ).toBeNull();
    });

    it("lists executions newest first, and can narrow to failures or a branch", async () => {
      const id = await idOf(BROKEN);
      const all = await testExecutions(sql, { orgId, testCaseId: id, limit: 60 });
      expect(all.length).toBe(4);
      const times = all.map((execution) => new Date(execution.startedAt).getTime());
      expect([...times].sort((a, b) => b - a)).toEqual(times);

      const failuresOnly = await testExecutions(sql, {
        orgId,
        testCaseId: id,
        onlyFailures: true,
      });
      expect(failuresOnly.every((execution) => execution.status === "failed")).toBe(true);

      const onRelease = await testExecutions(sql, {
        orgId,
        testCaseId: id,
        branch: "release/1.0",
      });
      expect(onRelease.length).toBe(1);
    });

    it("groups failures by signature, so two causes do not read as one", async () => {
      const modes = await testFailureModes(sql, { orgId, testCaseId: await idOf(TWO_MODES) });
      // The distinction the panel exists to draw: two signatures means two problems.
      expect(modes.length).toBe(2);
      expect(modes.map((mode) => mode.failureType).sort()).toEqual([
        "ConnectionError",
        "TimeoutError",
      ]);
      for (const mode of modes) {
        expect(mode.occurrences).toBe(1);
        expect(mode.sampleResultId).toBeGreaterThan(0);
        expect(mode.sampleRunId).toBeTruthy();
      }

      // One consistent cause stays one group, however many times it failed.
      const single = await testFailureModes(sql, { orgId, testCaseId: await idOf(BROKEN) });
      expect(single.length).toBe(1);
      expect(single[0]?.occurrences).toBe(4);
    });

    it("returns failure detail with the message and stack trace", async () => {
      const details = await testFailureDetails(sql, {
        orgId,
        testCaseId: await idOf(BROKEN),
        limit: 20,
      });
      expect(details.length).toBe(4);
      expect(details[0]?.failureMessage).toContain("expected 1 to equal 2");
      expect(details[0]?.stackTrace).toContain("specs/a.spec.ts");
    });

    it("widens to passing executions and truncates their output on request", async () => {
      const id = await idOf(TWO_MODES);
      const failuresOnly = await testExecutionDetails(sql, { orgId, testCaseId: id, limit: 20 });
      expect(failuresOnly.every((d) => d.status === "failed" || d.status === "error")).toBe(true);

      // `?show=all` on the page: a passing BDD run's step log is the only record of what it
      // did, so it has to be reachable.
      const everything = await testExecutionDetails(sql, {
        orgId,
        testCaseId: await idOf(STEADY),
        limit: 20,
        statuses: ["passed", "failed", "error", "skipped", "blocked"],
        maxOutputChars: 10,
      });
      expect(everything.length).toBe(4);
      for (const detail of everything) {
        expect((detail.stdout ?? "").length).toBeLessThanOrEqual(10);
      }
    });

    it("returns a duration history for the chart", async () => {
      const history = await testDurationHistory(sql, {
        orgId,
        testCaseId: await idOf(SLOWPOKE),
        limit: 40,
      });
      expect(history.length).toBe(4);
      expect(history.every((point) => point.durationMs === 90_000)).toBe(true);
    });

    it("batches recent outcomes per test, capped per test", async () => {
      const ids = [await idOf(STEADY), await idOf(BROKEN)];
      const map = await recentOutcomes(sql, { orgId, testCaseIds: ids, perTest: 2 });
      for (const id of ids) {
        expect(map.get(id)?.length).toBe(2);
      }
      // An empty request must not produce invalid SQL — an IN () list is a real hazard.
      const empty = await recentOutcomes(sql, { orgId, testCaseIds: [] });
      expect(empty.size).toBe(0);
    });
  });

  // ── leaderboards ──────────────────────────────────────────────────────────

  describe("leaderboards", () => {
    it("puts the genuinely flaky test on the flaky list and keeps the broken one off it", async () => {
      const flaky = await flakyLeaderboard(sql, { orgId, limit: 50 });
      const names = flaky.map((test) => test.name);
      expect(names).toContain(FLAKY);
      /*
       * The distinction the score exists for: `broken` fails every single run, which is a
       * failure rather than a flake. If it appeared here the flaky list would just be a
       * second copy of the failing list.
       */
      expect(names).not.toContain(BROKEN);
    });

    it("ranks most-failing by failure count", async () => {
      const failing = await topFailingTests(sql, { orgId, limit: 10 });
      expect(failing[0]?.name).toBe(BROKEN);
      expect(failing[0]?.failures30d).toBe(4);
    });

    it("excludes and re-includes a quarantined test", async () => {
      const id = await idOf(FLAKY);
      expect(
        await setQuarantine(sql, { orgId, testCaseId: id, quarantined: true, reason: "known" }),
      ).toBe(true);

      const hidden = await flakyLeaderboard(sql, { orgId, limit: 50 });
      expect(hidden.map((test) => test.name)).not.toContain(FLAKY);

      const shown = await flakyLeaderboard(sql, { orgId, limit: 50, includeQuarantined: true });
      expect(shown.map((test) => test.name)).toContain(FLAKY);

      // The reason is carried through to the detail page, not just the flag.
      const detail = await getTestCase(sql, { orgId, testCaseId: id });
      expect(detail?.quarantined).toBe(true);
      expect(detail?.quarantineReason).toBe("known");

      expect(await setQuarantine(sql, { orgId, testCaseId: id, quarantined: false })).toBe(true);
      const restored = await flakyLeaderboard(sql, { orgId, limit: 50 });
      expect(restored.map((test) => test.name)).toContain(FLAKY);
    });

    it("will not quarantine a test in another organisation", async () => {
      const otherOrg = "00000000-0000-7000-8000-0000000000ff";
      expect(
        await setQuarantine(sql, {
          orgId: otherOrg,
          testCaseId: await idOf(FLAKY),
          quarantined: true,
        }),
      ).toBe(false);
    });
  });

  // ── the empty case ────────────────────────────────────────────────────────

  it("answers for a project with no runs instead of throwing", async () => {
    /*
     * A brand-new project hits every one of these queries before a single report arrives.
     * Each has to return an empty or null answer, because the page renders an empty state
     * from it — and `avg` over no rows is null, which is the classic way this breaks.
     */
    const created = await db
      .insert(schema.projects)
      .values({ orgId, key: "insights-empty", name: "Empty" })
      .returning({ id: schema.projects.id });
    const emptyProjectId = created[0]?.id as string;
    const scope = { orgId, projectId: emptyProjectId };

    const summary = await orgSummary(sql, scope);
    expect(summary.runs30d).toBe(0);
    expect(summary.passRate30d).toBeNull();
    expect(summary.lastRunAt).toBeNull();

    expect((await dailySeries(sql, { ...scope, days: 7 })).length).toBe(7);
    expect(await dailySeriesByBranch(sql, { ...scope, days: 7 })).toEqual([]);
    expect(await branchPassRates(sql, scope)).toEqual([]);
    expect(await todaysRuns(sql, scope)).toEqual([]);
    expect(await slowestTests(sql, scope)).toEqual([]);
    expect(await flakyLeaderboard(sql, { ...scope, limit: 10 })).toEqual([]);
    expect(await topFailingTests(sql, { ...scope, limit: 10 })).toEqual([]);
    expect(await listSuites(sql, scope)).toEqual([]);

    const concentration = await failureConcentration(sql, scope);
    expect(concentration.totalFailures).toBe(0);
    expect(concentration.tests).toEqual([]);

    const page = await searchTests(sql, { orgId, projectId: emptyProjectId }, { limit: 10 });
    expect(page.tests).toEqual([]);
    expect(page.total).toBe(0);

    await db.delete(schema.projects).where(eq(schema.projects.id, emptyProjectId));
  });
});
