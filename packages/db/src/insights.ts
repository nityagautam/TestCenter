import type { Sql } from "./client.js";

/**
 * Dashboard aggregates, test search, and test history.
 *
 * The rollups these read (`project_daily_stats`, `test_cases.flake_score` and
 * friends) are maintained at ingest, so a dashboard covering months of history is a
 * scan of one small table rather than an aggregation over millions of results. That
 * is the whole reason those tables exist.
 *
 * Everything is org-scoped through an explicit `orgId` argument. There is no variant
 * that omits it.
 */

// ─── Dashboard ───────────────────────────────────────────────────────────────

export interface DailyPoint {
  day: string;
  runs: number;
  tests: number;
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  passRate: number | null;
  avgDurationMs: number | null;
}

/**
 * Daily series for the trend charts.
 *
 * `generate_series` fills days with no runs so a quiet weekend shows as a gap rather
 * than silently compressing the x-axis and making a 5-day trend look continuous.
 */
export async function dailySeries(
  sql: Sql,
  input: { orgId: string; projectId?: string | undefined; days?: number },
): Promise<DailyPoint[]> {
  const days = Math.min(Math.max(input.days ?? 30, 1), 365);

  return sql<DailyPoint[]>`
    WITH calendar AS (
      SELECT generate_series(
        (now() - (${days - 1} || ' days')::interval)::date,
        now()::date,
        '1 day'
      )::date AS day
    ),
    stats AS (
      SELECT
        day,
        sum(runs)::int    AS runs,
        sum(tests)::int   AS tests,
        sum(passed)::int  AS passed,
        sum(failed)::int  AS failed,
        sum(skipped)::int AS skipped,
        sum(flaky)::int   AS flaky,
        CASE
          WHEN sum(passed + failed) = 0 THEN NULL
          ELSE ROUND(sum(passed)::numeric * 100 / sum(passed + failed), 2)
        END AS pass_rate,
        -- Mean of run durations, not per-test durations: project_daily_stats stores
        -- AVG(runs.duration_ms). Labelled as run duration in the UI to match.
        AVG(avg_duration_ms)::int AS avg_duration_ms
      FROM project_daily_stats
      WHERE org_id = ${input.orgId}
        ${input.projectId ? sql`AND project_id = ${input.projectId}` : sql``}
        AND day >= (now() - (${days - 1} || ' days')::interval)::date
      GROUP BY day
    )
    SELECT
      to_char(calendar.day, 'Mon DD')          AS day,
      COALESCE(stats.runs, 0)                  AS runs,
      COALESCE(stats.tests, 0)                 AS tests,
      COALESCE(stats.passed, 0)                AS passed,
      COALESCE(stats.failed, 0)                AS failed,
      COALESCE(stats.skipped, 0)               AS skipped,
      COALESCE(stats.flaky, 0)                 AS flaky,
      stats.pass_rate                          AS "passRate",
      stats.avg_duration_ms                    AS "avgDurationMs"
    FROM calendar
    LEFT JOIN stats ON stats.day = calendar.day
    ORDER BY calendar.day ASC
  `;
}

export interface OrgSummary {
  projects: number;
  runs30d: number;
  tests30d: number;
  failing30d: number;
  flaky30d: number;
  passRate30d: number | null;
  runsToday: number;
  lastRunAt: Date | null;
  quarantined: number;
  flakyTests: number;
}

export async function orgSummary(
  sql: Sql,
  input: { orgId: string; projectId?: string | undefined },
): Promise<OrgSummary> {
  const rows = await sql<OrgSummary[]>`
    SELECT
      (SELECT count(*)::int FROM projects
        WHERE org_id = ${input.orgId} AND archived_at IS NULL
        ${input.projectId ? sql`AND id = ${input.projectId}` : sql``}) AS projects,
      COALESCE(sum(r.total) FILTER (WHERE r.started_at >= now() - INTERVAL '30 days'), 0)::int
        AS "tests30d",
      count(*) FILTER (WHERE r.started_at >= now() - INTERVAL '30 days')::int AS "runs30d",
      COALESCE(sum(r.failed + r.errored) FILTER (WHERE r.started_at >= now() - INTERVAL '30 days'), 0)::int
        AS "failing30d",
      COALESCE(sum(r.flaky) FILTER (WHERE r.started_at >= now() - INTERVAL '30 days'), 0)::int
        AS "flaky30d",
      CASE
        WHEN COALESCE(sum(r.passed + r.failed + r.errored)
              FILTER (WHERE r.started_at >= now() - INTERVAL '30 days'), 0) = 0 THEN NULL
        ELSE ROUND(
          sum(r.passed) FILTER (WHERE r.started_at >= now() - INTERVAL '30 days')::numeric * 100 /
          sum(r.passed + r.failed + r.errored) FILTER (WHERE r.started_at >= now() - INTERVAL '30 days'),
          2)
      END AS "passRate30d",
      count(*) FILTER (WHERE r.started_at >= date_trunc('day', now()))::int AS "runsToday",
      max(r.started_at) AS "lastRunAt",
      (SELECT count(*)::int FROM test_cases tc
        WHERE tc.org_id = ${input.orgId} AND tc.quarantined
        ${input.projectId ? sql`AND tc.project_id = ${input.projectId}` : sql``}) AS quarantined,
      (SELECT count(*)::int FROM test_cases tc
        WHERE tc.org_id = ${input.orgId} AND tc.flake_score >= 20
        ${input.projectId ? sql`AND tc.project_id = ${input.projectId}` : sql``}) AS "flakyTests"
    FROM runs r
    WHERE r.org_id = ${input.orgId}
      ${input.projectId ? sql`AND r.project_id = ${input.projectId}` : sql``}
  `;

  return (
    rows[0] ?? {
      projects: 0,
      runs30d: 0,
      tests30d: 0,
      failing30d: 0,
      flaky30d: 0,
      passRate30d: null,
      runsToday: 0,
      lastRunAt: null,
      quarantined: 0,
      flakyTests: 0,
    }
  );
}

// ─── Test search ─────────────────────────────────────────────────────────────

export interface TestSearchFilter {
  orgId: string;
  projectId?: string | undefined;
  /** Free text over name, classname and suite. */
  query?: string | undefined;
  /** "failing" means it failed at least once in the window. */
  status?: "failing" | "passing" | "flaky" | "quarantined" | "skipped" | undefined;
  /*
   * Note: there is deliberately no `tags` field here yet.
   *
   * Tags are recorded per *result* (test_results.tags), not per test identity, so
   * filtering test_cases by tag needs an EXISTS subquery against results within the
   * window. A field was declared here before that query existed, which meant callers
   * could pass tags and receive unfiltered results believing the filter had applied —
   * strictly worse than the feature being absent. It stays absent until implemented.
   */
  minFlakeScore?: number | undefined;
  slowerThanMs?: number | undefined;
  suite?: string | undefined;
  quarantinedOnly?: boolean | undefined;
  sort?: "recent" | "flakiest" | "slowest" | "most-failed" | "name" | undefined;
}

export interface TestSearchRow {
  id: number;
  projectId: string;
  projectKey: string;
  name: string;
  classname: string | null;
  suite: string | null;
  lastStatus: string | null;
  lastSeenAt: Date;
  runs30d: number;
  failures30d: number;
  failRate30d: string;
  flakeScore: string;
  avgDurationMs: number | null;
  p95DurationMs: number | null;
  quarantined: boolean;
}

export interface TestSearchPage {
  tests: TestSearchRow[];
  total: number;
}

/**
 * Test search.
 *
 * Uses trigram matching rather than only full-text, because people search for
 * fragments — "payment" should find `test_declines_expired_payment_card`, which
 * tokenised full-text search alone will not do. The GIN trigram index added in
 * migration 0004 is what keeps that affordable.
 *
 * A total count is returned here (unlike the run list's keyset pagination) because a
 * search UI genuinely needs "312 tests match" to be useful, and the count is over
 * `test_cases` — one row per distinct test, thousands not millions.
 */
export async function searchTests(
  sql: Sql,
  filter: TestSearchFilter,
  options: { limit?: number; offset?: number } = {},
): Promise<TestSearchPage> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);

  const conditions = [sql`tc.org_id = ${filter.orgId}`];
  if (filter.projectId) conditions.push(sql`tc.project_id = ${filter.projectId}`);
  if (filter.suite) conditions.push(sql`tc.suite = ${filter.suite}`);
  if (filter.quarantinedOnly) conditions.push(sql`tc.quarantined`);

  if (filter.query?.trim()) {
    const pattern = `%${filter.query.trim()}%`;
    conditions.push(
      sql`(tc.name ILIKE ${pattern} OR tc.classname ILIKE ${pattern} OR tc.suite ILIKE ${pattern})`,
    );
  }

  switch (filter.status) {
    case "failing":
      conditions.push(sql`tc.failures_30d > 0`);
      break;
    case "passing":
      conditions.push(sql`tc.failures_30d = 0 AND tc.runs_30d > 0`);
      break;
    case "flaky":
      conditions.push(sql`tc.flake_score >= 20`);
      break;
    case "quarantined":
      conditions.push(sql`tc.quarantined`);
      break;
    case "skipped":
      conditions.push(sql`tc.last_status = 'skipped'`);
      break;
    default:
      break;
  }

  if (filter.minFlakeScore !== undefined) {
    conditions.push(sql`tc.flake_score >= ${filter.minFlakeScore}`);
  }
  if (filter.slowerThanMs !== undefined) {
    conditions.push(sql`tc.p95_duration_ms >= ${filter.slowerThanMs}`);
  }

  const where = conditions.reduce((combined, condition) => sql`${combined} AND ${condition}`);

  const order =
    filter.sort === "flakiest"
      ? sql`tc.flake_score DESC, tc.last_seen_at DESC`
      : filter.sort === "slowest"
        ? sql`tc.p95_duration_ms DESC NULLS LAST`
        : filter.sort === "most-failed"
          ? sql`tc.failures_30d DESC, tc.fail_rate_30d DESC`
          : filter.sort === "name"
            ? sql`tc.name ASC`
            : sql`tc.last_seen_at DESC`;

  const tests = await sql<TestSearchRow[]>`
    SELECT
      tc.id,
      tc.project_id       AS "projectId",
      p.key               AS "projectKey",
      tc.name,
      tc.classname,
      tc.suite,
      tc.last_status      AS "lastStatus",
      tc.last_seen_at     AS "lastSeenAt",
      tc.runs_30d         AS "runs30d",
      tc.failures_30d     AS "failures30d",
      tc.fail_rate_30d    AS "failRate30d",
      tc.flake_score      AS "flakeScore",
      tc.avg_duration_ms  AS "avgDurationMs",
      tc.p95_duration_ms  AS "p95DurationMs",
      tc.quarantined
    FROM test_cases tc
    JOIN projects p ON p.id = tc.project_id
    WHERE ${where}
    ORDER BY ${order}
    LIMIT ${limit} OFFSET ${offset}
  `;

  const counted = await sql<{ total: number }[]>`
    SELECT count(*)::int AS total
    FROM test_cases tc
    WHERE ${where}
  `;

  return { tests, total: counted[0]?.total ?? 0 };
}

/** Suites present, for the search filter sidebar. */
export async function listSuites(
  sql: Sql,
  input: { orgId: string; projectId?: string | undefined; limit?: number },
): Promise<{ suite: string; tests: number }[]> {
  return sql<{ suite: string; tests: number }[]>`
    SELECT suite, count(*)::int AS tests
    FROM test_cases
    WHERE org_id = ${input.orgId}
      AND suite IS NOT NULL
      ${input.projectId ? sql`AND project_id = ${input.projectId}` : sql``}
    GROUP BY suite
    ORDER BY tests DESC
    LIMIT ${input.limit ?? 40}
  `;
}

// ─── Test detail and history ─────────────────────────────────────────────────

export interface TestCaseDetail {
  id: number;
  projectId: string;
  projectKey: string;
  projectName: string;
  name: string;
  classname: string | null;
  suite: string | null;
  parameters: Record<string, unknown> | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  lastStatus: string | null;
  runs30d: number;
  failures30d: number;
  failRate30d: string;
  flakeScore: string;
  avgDurationMs: number | null;
  p95DurationMs: number | null;
  quarantined: boolean;
  quarantineReason: string | null;
}

export async function getTestCase(
  sql: Sql,
  input: { orgId: string; testCaseId: number },
): Promise<TestCaseDetail | null> {
  const rows = await sql<TestCaseDetail[]>`
    SELECT
      tc.id,
      tc.project_id      AS "projectId",
      p.key              AS "projectKey",
      p.name             AS "projectName",
      tc.name, tc.classname, tc.suite, tc.parameters,
      tc.first_seen_at   AS "firstSeenAt",
      tc.last_seen_at    AS "lastSeenAt",
      tc.last_status     AS "lastStatus",
      tc.runs_30d        AS "runs30d",
      tc.failures_30d    AS "failures30d",
      tc.fail_rate_30d   AS "failRate30d",
      tc.flake_score     AS "flakeScore",
      tc.avg_duration_ms AS "avgDurationMs",
      tc.p95_duration_ms AS "p95DurationMs",
      tc.quarantined,
      tc.quarantine_reason AS "quarantineReason"
    FROM test_cases tc
    JOIN projects p ON p.id = tc.project_id
    WHERE tc.id = ${input.testCaseId} AND tc.org_id = ${input.orgId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export interface TestExecution {
  resultId: number;
  runId: string;
  runName: string | null;
  status: string;
  wasFlaky: boolean;
  durationMs: number | null;
  retryCount: number;
  startedAt: Date;
  branch: string | null;
  environment: string | null;
  commitSha: string | null;
  ciJobUrl: string | null;
  failureType: string | null;
  failureMessage: string | null;
  failureSignatureHex: string | null;
}

/**
 * Every execution of one test, newest first.
 *
 * This is the query behind "it ran 5 times and failed 3 — show me each failure".
 * Served by the (test_case_id, started_at DESC) index, and the failures-only variant
 * by the partial index added in migration 0004.
 */
export async function testExecutions(
  sql: Sql,
  input: {
    orgId: string;
    testCaseId: number;
    limit?: number;
    onlyFailures?: boolean;
    branch?: string | undefined;
  },
): Promise<TestExecution[]> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);

  return sql<TestExecution[]>`
    SELECT
      r.id             AS "resultId",
      r.run_id         AS "runId",
      run.name         AS "runName",
      r.status,
      r.was_flaky      AS "wasFlaky",
      r.duration_ms    AS "durationMs",
      r.retry_count    AS "retryCount",
      r.started_at     AS "startedAt",
      run.branch,
      run.environment,
      run.commit_sha   AS "commitSha",
      run.ci_job_url   AS "ciJobUrl",
      r.failure_type   AS "failureType",
      r.failure_message AS "failureMessage",
      encode(r.failure_signature, 'hex') AS "failureSignatureHex"
    FROM test_results r
    JOIN runs run ON run.id = r.run_id
    WHERE r.test_case_id = ${input.testCaseId}
      AND r.org_id = ${input.orgId}
      ${input.onlyFailures ? sql`AND r.status IN ('failed', 'error')` : sql``}
      ${input.branch ? sql`AND run.branch = ${input.branch}` : sql``}
    ORDER BY r.started_at DESC
    LIMIT ${limit}
  `;
}

export interface FailureDetail extends TestExecution {
  stackTrace: string | null;
  stdout: string | null;
  stderr: string | null;
  message: string | null;
}

/**
 * Full detail for a test's failures, including stack traces and captured output.
 *
 * Separate from `testExecutions` because these columns are large: loading them for
 * every execution of a long-lived test would move megabytes to render a timeline.
 */
export async function testFailureDetails(
  sql: Sql,
  input: { orgId: string; testCaseId: number; limit?: number },
): Promise<FailureDetail[]> {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);

  return sql<FailureDetail[]>`
    SELECT
      r.id             AS "resultId",
      r.run_id         AS "runId",
      run.name         AS "runName",
      r.status,
      r.was_flaky      AS "wasFlaky",
      r.duration_ms    AS "durationMs",
      r.retry_count    AS "retryCount",
      r.started_at     AS "startedAt",
      run.branch, run.environment,
      run.commit_sha   AS "commitSha",
      run.ci_job_url   AS "ciJobUrl",
      r.failure_type   AS "failureType",
      r.failure_message AS "failureMessage",
      encode(r.failure_signature, 'hex') AS "failureSignatureHex",
      r.stack_trace    AS "stackTrace",
      r.stdout, r.stderr, r.message
    FROM test_results r
    JOIN runs run ON run.id = r.run_id
    WHERE r.test_case_id = ${input.testCaseId}
      AND r.org_id = ${input.orgId}
      AND r.status IN ('failed', 'error')
    ORDER BY r.started_at DESC
    LIMIT ${limit}
  `;
}

export interface FailureMode {
  signatureHex: string | null;
  failureType: string | null;
  sampleMessage: string | null;
  occurrences: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  sampleResultId: number;
  sampleRunId: string;
}

/**
 * Distinct failure modes for one test.
 *
 * The first question after "this failed three times" is "is that one bug or three?".
 * Grouping by the failure signature computed at ingest answers it directly, which a
 * flat list of failures cannot.
 */
export async function testFailureModes(
  sql: Sql,
  input: { orgId: string; testCaseId: number },
): Promise<FailureMode[]> {
  return sql<FailureMode[]>`
    SELECT
      encode(r.failure_signature, 'hex')                          AS "signatureHex",
      (array_agg(r.failure_type ORDER BY r.started_at DESC))[1]    AS "failureType",
      (array_agg(r.failure_message ORDER BY r.started_at DESC))[1] AS "sampleMessage",
      count(*)::int                                                AS occurrences,
      min(r.started_at)                                            AS "firstSeenAt",
      max(r.started_at)                                            AS "lastSeenAt",
      (array_agg(r.id ORDER BY r.started_at DESC))[1]              AS "sampleResultId",
      (array_agg(r.run_id ORDER BY r.started_at DESC))[1]          AS "sampleRunId"
    FROM test_results r
    WHERE r.test_case_id = ${input.testCaseId}
      AND r.org_id = ${input.orgId}
      AND r.status IN ('failed', 'error')
    GROUP BY r.failure_signature
    ORDER BY occurrences DESC, "lastSeenAt" DESC
  `;
}

/** Duration history for the per-test trend, oldest first. */
export async function testDurationHistory(
  sql: Sql,
  input: { orgId: string; testCaseId: number; limit?: number },
): Promise<{ startedAt: Date; durationMs: number | null; status: string }[]> {
  const limit = Math.min(Math.max(input.limit ?? 40, 2), 200);
  const rows = await sql<{ startedAt: Date; durationMs: number | null; status: string }[]>`
    SELECT r.started_at AS "startedAt", r.duration_ms AS "durationMs", r.status
    FROM test_results r
    WHERE r.test_case_id = ${input.testCaseId} AND r.org_id = ${input.orgId}
    ORDER BY r.started_at DESC
    LIMIT ${limit}
  `;
  return rows.reverse();
}

// ─── Flaky leaderboard ───────────────────────────────────────────────────────

export interface FlakyTest {
  id: number;
  projectKey: string;
  name: string;
  suite: string | null;
  flakeScore: string;
  failRate30d: string;
  runs30d: number;
  failures30d: number;
  avgDurationMs: number | null;
  quarantined: boolean;
  /** Rough CI time spent on runs of this test in the window. */
  wastedMs: number | null;
}

/**
 * Flakiest tests first.
 *
 * A consistently broken test scores zero — it is not flaky, it is failing, and mixing
 * the two is what makes most flake dashboards useless. `wastedMs` is included because
 * "this test has burned 4 hours of CI" is the argument that actually gets a flake
 * fixed.
 */
export async function flakyLeaderboard(
  sql: Sql,
  input: {
    orgId: string;
    projectId?: string | undefined;
    limit?: number;
    minScore?: number;
    includeQuarantined?: boolean;
  },
): Promise<FlakyTest[]> {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  const minScore = input.minScore ?? 1;

  return sql<FlakyTest[]>`
    SELECT
      tc.id,
      p.key              AS "projectKey",
      tc.name,
      tc.suite,
      tc.flake_score     AS "flakeScore",
      tc.fail_rate_30d   AS "failRate30d",
      tc.runs_30d        AS "runs30d",
      tc.failures_30d    AS "failures30d",
      tc.avg_duration_ms AS "avgDurationMs",
      tc.quarantined,
      (tc.avg_duration_ms::bigint * tc.runs_30d) AS "wastedMs"
    FROM test_cases tc
    JOIN projects p ON p.id = tc.project_id
    WHERE tc.org_id = ${input.orgId}
      AND tc.flake_score >= ${minScore}
      ${input.projectId ? sql`AND tc.project_id = ${input.projectId}` : sql``}
      ${input.includeQuarantined ? sql`` : sql`AND NOT tc.quarantined`}
    ORDER BY tc.flake_score DESC, tc.runs_30d DESC
    LIMIT ${limit}
  `;
}

export interface FailingTest {
  id: number;
  projectKey: string;
  name: string;
  suite: string | null;
  failures30d: number;
  failRate30d: string;
  runs30d: number;
  lastStatus: string | null;
  lastSeenAt: Date;
}

export async function topFailingTests(
  sql: Sql,
  input: { orgId: string; projectId?: string | undefined; limit?: number },
): Promise<FailingTest[]> {
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 100);
  return sql<FailingTest[]>`
    SELECT
      tc.id,
      p.key            AS "projectKey",
      tc.name,
      tc.suite,
      tc.failures_30d  AS "failures30d",
      tc.fail_rate_30d AS "failRate30d",
      tc.runs_30d      AS "runs30d",
      tc.last_status   AS "lastStatus",
      tc.last_seen_at  AS "lastSeenAt"
    FROM test_cases tc
    JOIN projects p ON p.id = tc.project_id
    WHERE tc.org_id = ${input.orgId}
      AND tc.failures_30d > 0
      ${input.projectId ? sql`AND tc.project_id = ${input.projectId}` : sql``}
    ORDER BY tc.failures_30d DESC, tc.fail_rate_30d DESC
    LIMIT ${limit}
  `;
}

/** Marks a test quarantined so a known flake stops polluting dashboards. */
export async function setQuarantine(
  sql: Sql,
  input: { orgId: string; testCaseId: number; quarantined: boolean; reason?: string | undefined },
): Promise<boolean> {
  const updated = await sql`
    UPDATE test_cases SET
      quarantined = ${input.quarantined},
      quarantined_at = ${input.quarantined ? new Date() : null},
      quarantine_reason = ${input.quarantined ? (input.reason ?? null) : null}
    WHERE id = ${input.testCaseId} AND org_id = ${input.orgId}
  `;
  return (updated.count ?? 0) > 0;
}
