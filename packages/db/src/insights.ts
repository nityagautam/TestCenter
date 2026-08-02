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
  /** Summed run duration for the day — CI spend, as opposed to per-run speed. */
  totalDurationMs: number | null;
}

/**
 * When runs actually start, bucketed by calendar day and hour of day.
 *
 * Read from `runs` directly rather than from `project_daily_stats`, because the rollup is
 * keyed by day and the question here is specifically *within* the day — no aggregate that
 * already exists can answer it. It counts runs rather than results: this measures CI
 * cadence, not test volume, and one 5,000-test run is one event.
 *
 * Bucketed in the *viewer's* zone, which the caller supplies. It has to happen here rather
 * than by shifting UTC buckets afterwards: India is UTC+5:30, so a UTC hour bucket spans two
 * local hours and cannot be reassigned to one of them. Postgres also gets DST right across
 * the window, which arithmetic on a fixed offset would not.
 *
 * Defaults to UTC — the first render before the browser has reported its zone.
 *
 * Sparse on purpose: only buckets with runs come back. A full 24 × 90 grid is 2,160 rows to
 * ship for what is usually a few dozen non-empty ones, and the caller has to build the
 * lattice anyway to draw it.
 */
export interface ActivityBucket {
  /** `YYYY-MM-DD` in the requested zone. A real date, unlike `DailyPoint.day`. */
  day: string;
  /** 0–23 in the requested zone. */
  hour: number;
  runs: number;
}

export async function runActivity(
  sql: Sql,
  input: {
    orgId: string;
    projectId?: string | undefined;
    days?: number;
    /** IANA zone. Validated by the caller — Postgres raises on an unknown one. */
    timeZone?: string | undefined;
  },
): Promise<ActivityBucket[]> {
  const days = Math.min(Math.max(input.days ?? 30, 1), 365);
  const zone = input.timeZone ?? "UTC";

  const rows = await sql<{ day: string; hour: number; runs: number }[]>`
    SELECT
      to_char(started_at AT TIME ZONE ${zone}, 'YYYY-MM-DD')      AS day,
      EXTRACT(HOUR FROM started_at AT TIME ZONE ${zone})::int      AS hour,
      count(*)::int                                               AS runs
    FROM runs
    WHERE org_id = ${input.orgId}
      ${input.projectId ? sql`AND project_id = ${input.projectId}` : sql``}
      AND started_at >= (now() - (${days - 1} || ' days')::interval)::date
    GROUP BY 1, 2
    ORDER BY 1, 2
  `;

  // `count(*)` is bigint, and postgres.js hands int8 back as a string — the ::int cast in
  // the query is what keeps that from reaching the caller as "3" instead of 3.
  return rows.map((row) => ({ day: row.day, hour: row.hour, runs: Number(row.runs) }));
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

  const rows = await sql<
    (Omit<DailyPoint, "totalDurationMs"> & {
      totalDurationMs: string | number | null;
    })[]
  >`
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
        AVG(avg_duration_ms)::int AS avg_duration_ms,
        sum(total_duration_ms)::bigint AS total_duration_ms
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
      stats.avg_duration_ms                    AS "avgDurationMs",
      stats.total_duration_ms                  AS "totalDurationMs"
    FROM calendar
    LEFT JOIN stats ON stats.day = calendar.day
    ORDER BY calendar.day ASC
  `;

  /*
   * `total_duration_ms` is summed from a bigint column, and postgres.js hands int8 back
   * as a *string* rather than silently narrowing it to a JS number. Returned raw it would
   * satisfy the `number` in DailyPoint at compile time and be a string at runtime, so
   * `formatDuration` would receive "2687693" and any arithmetic on it would concatenate.
   * Coerced here so callers get the type this function advertises — the same reason
   * `upsertTestCases` coerces the ids it returns.
   */
  return rows.map((row) => ({
    ...row,
    totalDurationMs: row.totalDurationMs === null ? null : Number(row.totalDurationMs),
  }));
}

export interface RunVerdictRow {
  id: string;
  runId: string;
  verdict: string;
  note: string | null;
  createdAt: Date;
  /** Null once the account that recorded it has been deleted. */
  authorName: string | null;
  authorEmail: string | null;
}

/**
 * Records a verdict. Append-only — a correction is a new row, not an update.
 *
 * Scoped by org on the way in: the run id is checked against the caller's organisation
 * before the insert, so a run id from another tenant records nothing rather than
 * attaching a judgement to someone else's run.
 */
export async function addRunVerdict(
  sql: Sql,
  input: {
    orgId: string;
    runId: string;
    verdict: string;
    note?: string | null;
    userId: string | null;
  },
): Promise<RunVerdictRow | null> {
  const inserted = await sql<{ id: string }[]>`
    INSERT INTO run_verdicts (org_id, run_id, verdict, note, created_by)
    SELECT ${input.orgId}, r.id, ${input.verdict}, ${input.note ?? null}, ${input.userId}
    FROM runs r
    WHERE r.id = ${input.runId} AND r.org_id = ${input.orgId}
    RETURNING id
  `;
  if (!inserted[0]) return null;

  const rows = await sql<RunVerdictRow[]>`
    SELECT
      v.id, v.run_id AS "runId", v.verdict, v.note, v.created_at AS "createdAt",
      u.name AS "authorName", u.email AS "authorEmail"
    FROM run_verdicts v
    LEFT JOIN users u ON u.id = v.created_by
    WHERE v.id = ${inserted[0].id}
  `;
  return rows[0] ?? null;
}

/**
 * The newest verdict for each of many runs, for list views.
 *
 * LATERAL with LIMIT 1 per run rather than a window over the whole table: the work is
 * then bounded by the rows on screen and served by (run_id, created_at DESC), which is
 * the same reason `recentOutcomes` is shaped this way.
 */
export async function latestRunVerdicts(
  sql: Sql,
  input: { orgId: string; runIds: readonly string[] },
): Promise<Map<string, RunVerdictRow>> {
  const byRun = new Map<string, RunVerdictRow>();
  if (input.runIds.length === 0) return byRun;

  const rows = await sql<RunVerdictRow[]>`
    SELECT
      latest.id, ids.run_id AS "runId", latest.verdict, latest.note,
      latest.created_at AS "createdAt",
      u.name AS "authorName", u.email AS "authorEmail"
    FROM unnest(${input.runIds as string[]}::uuid[]) AS ids(run_id)
    CROSS JOIN LATERAL (
      SELECT v.id, v.verdict, v.note, v.created_at, v.created_by
      FROM run_verdicts v
      WHERE v.run_id = ids.run_id AND v.org_id = ${input.orgId}
      -- id breaks the tie: two verdicts recorded in the same millisecond would
      -- otherwise make "latest" arbitrary, and uuidv7 is time-ordered so this is
      -- the same ordering the timestamps intend.
      ORDER BY v.created_at DESC, v.id DESC
      LIMIT 1
    ) latest
    LEFT JOIN users u ON u.id = latest.created_by
  `;

  for (const row of rows) byRun.set(row.runId, row);
  return byRun;
}

/** Every verdict on one run, newest first — the audit trail the run page shows. */
export async function runVerdictHistory(
  sql: Sql,
  input: { orgId: string; runId: string; limit?: number },
): Promise<RunVerdictRow[]> {
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);

  return sql<RunVerdictRow[]>`
    SELECT
      v.id, v.run_id AS "runId", v.verdict, v.note, v.created_at AS "createdAt",
      u.name AS "authorName", u.email AS "authorEmail"
    FROM run_verdicts v
    LEFT JOIN users u ON u.id = v.created_by
    WHERE v.run_id = ${input.runId} AND v.org_id = ${input.orgId}
    ORDER BY v.created_at DESC, v.id DESC
    LIMIT ${limit}
  `;
}

export interface BranchPassRate {
  branch: string;
  passRate: number | null;
  runs: number;
  tests: number;
  failed: number;
}

/**
 * Pass rate per branch over the window, one row per branch.
 *
 * A bar per branch, not a line per branch. The question is "which branch is healthy?",
 * which is a comparison of magnitude across a handful of named categories — bars answer
 * that at a glance and stay readable with a single day of history, where a multi-line
 * trend degenerates into one dot per series floating in an empty plot.
 *
 * Not a pie either: these are independent ratios, not parts of a whole. Two branches at
 * 96% and 90% would occupy slices summing to 186%, which a pie cannot express without
 * lying about what the slices mean.
 *
 * Ordered worst-first, because the branch that needs attention is the answer.
 */
export async function branchPassRates(
  sql: Sql,
  input: { orgId: string; projectId?: string | undefined; days?: number; limit?: number },
): Promise<BranchPassRate[]> {
  const days = Math.min(Math.max(input.days ?? 30, 1), 365);
  const limit = Math.min(Math.max(input.limit ?? 8, 1), 30);

  return sql<BranchPassRate[]>`
    SELECT
      COALESCE(NULLIF(branch, ''), '(no branch)') AS branch,
      sum(runs)::int  AS runs,
      sum(tests)::int AS tests,
      sum(failed)::int AS failed,
      CASE
        WHEN sum(passed + failed) = 0 THEN NULL
        ELSE ROUND(sum(passed)::numeric * 100 / sum(passed + failed), 2)
      END AS "passRate"
    FROM project_daily_stats
    WHERE org_id = ${input.orgId}
      ${input.projectId ? sql`AND project_id = ${input.projectId}` : sql``}
      AND day >= (now() - (${days - 1} || ' days')::interval)::date
    GROUP BY 1
    HAVING sum(runs) > 0
    -- Worst pass rate first; ties broken by volume so the busier branch leads.
    ORDER BY "passRate" ASC NULLS LAST, sum(runs) DESC
    LIMIT ${limit}
  `;
}

export interface TodayRun {
  id: string;
  label: string;
  name: string | null;
  branch: string | null;
  status: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  passRate: number | null;
}

/**
 * Today's runs, oldest first, one row per run.
 *
 * Every other chart here is keyed by *day*, which is the wrong axis for the question
 * someone actually has while a suite is running: "is the run that just finished worse
 * than the one before it?" A daily rollup answers that only tomorrow, and by then it has
 * averaged the two together.
 *
 * So this reads `runs` directly rather than `project_daily_stats` — the point of the
 * rollup is to avoid scanning results for long windows, and a single day of runs is a
 * handful of rows on the (org, started_at) path. Ordered ascending so the newest run is
 * the rightmost column, matching every other time axis in the app.
 */
export async function todaysRuns(
  sql: Sql,
  input: { orgId: string; projectId?: string | undefined; limit?: number },
): Promise<TodayRun[]> {
  const limit = Math.min(Math.max(input.limit ?? 24, 1), 100);

  const rows = await sql<TodayRun[]>`
    SELECT * FROM (
      SELECT
        r.id,
        to_char(r.started_at, 'HH24:MI') AS label,
        r.name, r.branch, r.status,
        r.total, r.passed, r.skipped, r.flaky,
        (r.failed + r.errored) AS failed,
        CASE
          WHEN (r.passed + r.failed + r.errored) = 0 THEN NULL
          ELSE ROUND(r.passed::numeric * 100 / (r.passed + r.failed + r.errored), 2)
        END AS "passRate"
      FROM runs r
      WHERE r.org_id = ${input.orgId}
        ${input.projectId ? sql`AND r.project_id = ${input.projectId}` : sql``}
        AND r.started_at >= date_trunc('day', now())
      -- Newest first for the LIMIT, so a busy day keeps the *latest* runs, not the
      -- first few of the morning.
      ORDER BY r.started_at DESC
      LIMIT ${limit}
    ) recent
    ORDER BY label ASC
  `;

  return rows;
}

/**
 * Every run in the window, oldest first — one row per execution.
 *
 * The per-*day* series answers "how did the month go"; this answers "how did each run go",
 * and they are not the same question. A day that rolled up to 96% can hide one run at 40%
 * beside four at 100%, and the rollup will never show it — the bad run is averaged away the
 * moment it lands. Plotting executions puts every one of them on the axis.
 *
 * Reads `runs` rather than `project_daily_stats` for the same reason `todaysRuns` does: the
 * rollup has already thrown away the distinction being asked about. The denormalised counts
 * on `runs` mean this is still one index scan on (org, started_at) with no join to results.
 *
 * Runs with no results are excluded. A pending or parsing run has nothing to plot yet, and a
 * report that parsed to zero tests would otherwise draw a column of height zero — a visual
 * claim that everything failed, when in fact nothing was measured.
 */
export interface RunPoint {
  id: string;
  /** `Mon DD HH:MM` in the requested zone — the axis is time, so the label carries both. */
  label: string;
  name: string | null;
  branch: string | null;
  status: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
}

export async function runSeries(
  sql: Sql,
  input: {
    orgId: string;
    projectId?: string | undefined;
    days?: number;
    limit?: number;
    /** IANA zone for the point labels, so the axis agrees with the heatmap beside it. */
    timeZone?: string | undefined;
  },
): Promise<RunPoint[]> {
  const days = Math.min(Math.max(input.days ?? 30, 1), 365);
  const zone = input.timeZone ?? "UTC";
  /*
   * Capped, and the cap keeps the *newest* runs.
   *
   * A busy organisation can publish a few thousand runs in ninety days, and every point
   * becomes a hover target in the chart. Truncating the far end of the window degrades the
   * axis gracefully — the recent history stays complete, which is the part anyone is looking
   * at — whereas keeping the oldest would show a chart that stops before today.
   */
  const limit = Math.min(Math.max(input.limit ?? 300, 1), 1000);

  const rows = await sql<RunPoint[]>`
    SELECT id, label, name, branch, status, total, passed, failed, skipped, flaky
    FROM (
      SELECT
        r.id,
        r.started_at,
        to_char(r.started_at AT TIME ZONE ${zone}, 'Mon DD HH24:MI') AS label,
        r.name, r.branch, r.status,
        r.total, r.passed, r.skipped, r.flaky,
        (r.failed + r.errored) AS failed
      FROM runs r
      WHERE r.org_id = ${input.orgId}
        ${input.projectId ? sql`AND r.project_id = ${input.projectId}` : sql``}
        AND r.started_at >= (now() - (${days - 1} || ' days')::interval)::date
        AND r.total > 0
      ORDER BY r.started_at DESC
      LIMIT ${limit}
    ) recent
    -- Re-sorted ascending after the LIMIT, so the newest run is the rightmost point. Sorted
    -- on the timestamp rather than the label: "Aug 01" sorts before "Jul 31" as text.
    ORDER BY recent.started_at ASC
  `;

  return rows;
}

export interface SlowTest {
  id: number;
  name: string;
  suite: string | null;
  projectKey: string;
  p95DurationMs: number;
  avgDurationMs: number | null;
  runs30d: number;
}

/**
 * The slowest tests by p95, which is where CI time actually goes.
 *
 * p95 rather than average: a test that is usually fast and occasionally takes a minute
 * is the one worth finding, and the mean hides exactly that. Reads the per-test rollup,
 * so it costs one indexed scan of `test_cases` rather than touching results.
 */
export async function slowestTests(
  sql: Sql,
  input: { orgId: string; projectId?: string | undefined; limit?: number },
): Promise<SlowTest[]> {
  const limit = Math.min(Math.max(input.limit ?? 8, 1), 50);

  return sql<SlowTest[]>`
    SELECT
      tc.id, tc.name, tc.suite,
      p.key AS "projectKey",
      tc.p95_duration_ms AS "p95DurationMs",
      tc.avg_duration_ms AS "avgDurationMs",
      tc.runs_30d        AS "runs30d"
    FROM test_cases tc
    JOIN projects p ON p.id = tc.project_id
    WHERE tc.org_id = ${input.orgId}
      ${input.projectId ? sql`AND tc.project_id = ${input.projectId}` : sql``}
      AND tc.p95_duration_ms IS NOT NULL
      AND NOT tc.quarantined
    ORDER BY tc.p95_duration_ms DESC
    LIMIT ${limit}
  `;
}

export interface FailureConcentration {
  tests: { id: number; name: string; failures30d: number; share: number }[];
  /** Failures across every test in scope, so the listed share means something. */
  totalFailures: number;
  /** How many distinct tests failed at all. */
  failingTests: number;
}

/**
 * How concentrated failures are in a few tests.
 *
 * The question this answers is "one bad test, or systemic?", and it is the first thing
 * worth knowing about a red dashboard. A count of failures alone cannot answer it: 200
 * failures from one test and 200 from ninety tests are the same number and completely
 * different problems.
 */
export async function failureConcentration(
  sql: Sql,
  input: { orgId: string; projectId?: string | undefined; limit?: number },
): Promise<FailureConcentration> {
  const limit = Math.min(Math.max(input.limit ?? 6, 1), 20);

  const rows = await sql<{ id: number; name: string; failures30d: number }[]>`
    SELECT tc.id, tc.name, tc.failures_30d AS "failures30d"
    FROM test_cases tc
    WHERE tc.org_id = ${input.orgId}
      ${input.projectId ? sql`AND tc.project_id = ${input.projectId}` : sql``}
      AND tc.failures_30d > 0
    ORDER BY tc.failures_30d DESC
    LIMIT ${limit}
  `;

  const totals = await sql<{ total: number; failing: number }[]>`
    SELECT
      COALESCE(sum(tc.failures_30d), 0)::int AS total,
      count(*)::int AS failing
    FROM test_cases tc
    WHERE tc.org_id = ${input.orgId}
      ${input.projectId ? sql`AND tc.project_id = ${input.projectId}` : sql``}
      AND tc.failures_30d > 0
  `;

  const totalFailures = totals[0]?.total ?? 0;
  return {
    tests: rows.map((row) => ({
      id: row.id,
      name: row.name,
      failures30d: row.failures30d,
      share: totalFailures === 0 ? 0 : (row.failures30d * 100) / totalFailures,
    })),
    totalFailures,
    failingTests: totals[0]?.failing ?? 0,
  };
}

export interface FlakeBucket {
  label: string;
  tests: number;
}

/**
 * Flake scores grouped into bands.
 *
 * Bands rather than a raw histogram because the score is calibrated, not linear: the
 * dashboard's own threshold is 20, so "under 20" and "20–49" are the distinction that
 * changes what you do. Buckets are generated from a fixed list so an empty band still
 * appears — a missing bar reads as "no data" when it means "none in this band".
 */
export async function flakeDistribution(
  sql: Sql,
  input: { orgId: string; projectId?: string | undefined },
): Promise<FlakeBucket[]> {
  return sql<FlakeBucket[]>`
    WITH bands(label, lo, hi, ord) AS (
      VALUES
        ('stable (0)',      0,   0.001, 1),
        ('low (1–19)',      0.001, 20,  2),
        ('flaky (20–49)',   20,  50,    3),
        ('bad (50–79)',     50,  80,    4),
        ('severe (80+)',    80,  1000,  5)
    )
    SELECT
      b.label,
      count(tc.id)::int AS tests
    FROM bands b
    LEFT JOIN test_cases tc
      ON tc.org_id = ${input.orgId}
      ${input.projectId ? sql`AND tc.project_id = ${input.projectId}` : sql``}
      AND tc.flake_score >= b.lo
      AND tc.flake_score < b.hi
    GROUP BY b.label, b.ord
    ORDER BY b.ord
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

export interface RecentOutcome {
  testCaseId: number;
  resultId: number;
  runId: string;
  status: string;
  wasFlaky: boolean;
  startedAt: Date;
}

/**
 * The last N outcomes for each of many tests, oldest first within each test.
 *
 * One query for a whole page of rows rather than N queries: a list view that fired a
 * query per row would put fifty round trips behind one page.
 *
 * LATERAL with a per-test LIMIT, not `row_number() … WHERE rn <= n`. The window form
 * reads *every* retained row for every test on the page and discards all but the last
 * few — for 200 tests with a year of history that is ~100k rows scanned and sorted to
 * return 1,600. The LATERAL form walks the (test_case_id, started_at DESC) index
 * backwards and stops after N, so the work is bounded by what is displayed rather than
 * by how much history exists. Only the small result set is sorted, to put each test's
 * marks in oldest → newest order for rendering.
 *
 * Returned as a Map because the caller is rendering rows in its own order and wants a
 * lookup, not a list to group itself.
 */
export async function recentOutcomes(
  sql: Sql,
  input: { orgId: string; testCaseIds: readonly number[]; perTest?: number },
): Promise<Map<number, RecentOutcome[]>> {
  const byTest = new Map<number, RecentOutcome[]>();
  if (input.testCaseIds.length === 0) return byTest;

  const perTest = Math.min(Math.max(input.perTest ?? 8, 1), 30);

  const rows = await sql<RecentOutcome[]>`
    SELECT
      ids.test_case_id AS "testCaseId",
      recent.id        AS "resultId",
      recent.run_id    AS "runId",
      recent.status,
      recent.was_flaky AS "wasFlaky",
      recent.started_at AS "startedAt"
    FROM unnest(${input.testCaseIds as number[]}::bigint[]) AS ids(test_case_id)
    CROSS JOIN LATERAL (
      SELECT r.id, r.run_id, r.status, r.was_flaky, r.started_at
      FROM test_results r
      WHERE r.test_case_id = ids.test_case_id
        AND r.org_id = ${input.orgId}
      ORDER BY r.started_at DESC
      LIMIT ${perTest}
    ) recent
    -- Ascending, so the caller renders oldest → newest without reversing per row.
    ORDER BY "testCaseId", "startedAt" ASC
  `;

  for (const row of rows) {
    // `testCaseId` is int8. The client parses int8 to a number, so this key matches the
    // declared Map<number, …> and a caller looking up by a numeric id finds its row.
    const existing = byTest.get(row.testCaseId);
    if (existing) existing.push(row);
    else byTest.set(row.testCaseId, [row]);
  }
  return byTest;
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

export interface ExecutionDetail extends TestExecution {
  stackTrace: string | null;
  stdout: string | null;
  stderr: string | null;
  message: string | null;
  /** True when `stdout` was cut short by `maxOutputChars`, so the UI can say so. */
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

/** @deprecated Kept for callers written before passed executions were included. */
export type FailureDetail = ExecutionDetail;

/** The parser caps one row's captured output at 64k chars; never read more than that. */
const MAX_OUTPUT_CHARS = 64_000;

/**
 * Full detail for a test's executions, including stack traces and captured output.
 *
 * Separate from `testExecutions` because these columns are large: loading them for
 * every execution of a long-lived test would move megabytes to render a timeline.
 *
 * `statuses` defaults to failures because that is the triage path, but passing all
 * statuses is what powers "show me the steps of a run that passed" — Cucumber and
 * friends write their step log to `<system-out>` on success too, and that log is the
 * only record of what a green test actually did. Cap `maxOutputChars` when widening
 * the status filter: 20 rows × the parser's 64k ceiling is 1.3 MB of text otherwise.
 */
export async function testExecutionDetails(
  sql: Sql,
  input: {
    orgId: string;
    testCaseId: number;
    limit?: number;
    statuses?: readonly string[];
    maxOutputChars?: number;
  },
): Promise<ExecutionDetail[]> {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  const statuses = input.statuses ?? ["failed", "error"];
  const cap = Math.min(Math.max(input.maxOutputChars ?? MAX_OUTPUT_CHARS, 200), MAX_OUTPUT_CHARS);

  return sql<ExecutionDetail[]>`
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
      left(r.stdout, ${cap}) AS stdout,
      left(r.stderr, ${cap}) AS stderr,
      r.message,
      -- length() is NULL for a NULL column, which would make the flag NULL, not false.
      COALESCE(length(r.stdout) > ${cap}, false) AS "stdoutTruncated",
      COALESCE(length(r.stderr) > ${cap}, false) AS "stderrTruncated"
    FROM test_results r
    JOIN runs run ON run.id = r.run_id
    WHERE r.test_case_id = ${input.testCaseId}
      AND r.org_id = ${input.orgId}
      AND r.status = ANY(${statuses as string[]}::text[])
    ORDER BY r.started_at DESC
    LIMIT ${limit}
  `;
}

/** Failures only — the default triage list. See `testExecutionDetails`. */
export async function testFailureDetails(
  sql: Sql,
  input: { orgId: string; testCaseId: number; limit?: number },
): Promise<ExecutionDetail[]> {
  return testExecutionDetails(sql, input);
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
