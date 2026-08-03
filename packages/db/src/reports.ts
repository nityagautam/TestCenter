import {
  fillTemplate,
  REPORT_DAY_OPTIONS,
  REPORT_TOP_N_OPTIONS,
  type BlankOptions,
  type QuestionDefinition,
  type ReportPanel,
  type ReportResult,
} from "@testcenter/core";
import type { Sql } from "./client.js";
import { listSuites } from "./insights.js";
import { listProjects, runFilterOptions } from "./queries.js";

/**
 * The report question catalog.
 *
 * Each question is a *sentence with blanks* plus one vetted query that answers it. That is
 * the opposite of a chart builder, deliberately: a builder asks the reader to know the
 * schema, and every report it produces has to have its intent reconstructed by whoever
 * reads it later. A question carries its intent in its own title.
 *
 * It also bounds the query space. Every question here runs against the same rollups the
 * dashboards use, so a report cannot invent an aggregation that breaks the read-path
 * budget — which an arbitrary group-by over `test_results` very much could.
 *
 * Questions emit `ReportPanel[]` and nothing else. The renderer knows only the panel
 * contract, so a free-form builder can later emit the same specs and reuse the entire view,
 * print stylesheet and export path.
 */

export const REPORT_QUESTIONS: readonly QuestionDefinition[] = [
  {
    id: "most-failing-tests",
    template: "Which tests failed most in the last {days} days on {branch}?",
    purpose:
      "Separates the handful of tests producing most of the red from the long tail, so effort goes where the failures actually are.",
    blanks: [
      { key: "days", kind: "days", placeholder: "30", required: true },
      { key: "branch", kind: "branch", placeholder: "any branch" },
    ],
    scope: "both",
  },
  {
    id: "newly-failing",
    template: "Which tests started failing in the last {days} days on {branch}?",
    purpose:
      "Tests that were clean in the preceding window and are not now — the ones a recent change probably broke.",
    blanks: [
      { key: "days", kind: "days", placeholder: "14", required: true },
      { key: "branch", kind: "branch", placeholder: "any branch" },
    ],
    scope: "both",
  },
  {
    id: "pass-rate-trend",
    template: "How has pass rate moved over the last {days} days on {branch}?",
    purpose:
      "Answers whether things are getting better or worse, which a single current percentage cannot.",
    blanks: [
      { key: "days", kind: "days", placeholder: "30", required: true },
      { key: "branch", kind: "branch", placeholder: "any branch" },
    ],
    scope: "both",
  },
  {
    id: "suite-regressions",
    template: "Which suites regressed most in the last {days} days against the {days} before?",
    purpose:
      "Compares each suite against its own recent past, so a suite that was always weak does not crowd out one that just got worse.",
    blanks: [{ key: "days", kind: "days", placeholder: "14", required: true }],
    scope: "both",
  },
  {
    id: "ci-time",
    template: "Where did CI time go in the last {days} days on {environment}?",
    purpose:
      "Total wall-clock consumed per test, so the tests worth optimising are the ones actually spending the budget.",
    blanks: [
      { key: "days", kind: "days", placeholder: "30", required: true },
      { key: "environment", kind: "environment", placeholder: "any environment" },
    ],
    scope: "both",
  },
  {
    id: "slowest-runs",
    template: "Which runs took longest in the last {days} days on {branch}?",
    purpose:
      "Run-level outliers, which per-test averages hide — one pathological run can dominate a day's CI bill.",
    blanks: [
      { key: "days", kind: "days", placeholder: "30", required: true },
      { key: "branch", kind: "branch", placeholder: "any branch" },
    ],
    scope: "both",
  },
  {
    id: "flipping-tests",
    template: "Which tests flip between pass and fail most in the last {days} days in {suite}?",
    purpose:
      "Measured over the window you choose rather than the fixed 30-day flake score, and counts flips rather than failures — a consistently failing test is broken, not flaky.",
    blanks: [
      { key: "days", kind: "days", placeholder: "30", required: true },
      { key: "suite", kind: "suite", placeholder: "any suite" },
    ],
    scope: "both",
  },
  {
    id: "environment-reliability",
    template: "Which environment was least reliable in the last {days} days?",
    purpose:
      "Splits pass rate by environment, which separates a flaky staging cluster from a genuinely failing suite.",
    blanks: [{ key: "days", kind: "days", placeholder: "30", required: true }],
    scope: "both",
  },
  {
    id: "unreviewed-runs",
    template: "Which runs are still unreviewed in the last {days} days on {branch}?",
    purpose:
      "Runs with failures and no verdict — the review queue. Nobody has said whether these were real.",
    blanks: [
      { key: "days", kind: "days", placeholder: "14", required: true },
      { key: "branch", kind: "branch", placeholder: "any branch" },
    ],
    scope: "both",
  },
  {
    id: "verdict-split",
    template: "How much of the red was infra versus a product bug in the last {days} days?",
    purpose:
      "Turns recorded verdicts into a number: what proportion of failing runs were the environment rather than the code. Only answerable because verdicts are recorded.",
    blanks: [{ key: "days", kind: "days", placeholder: "30", required: true }],
    scope: "both",
  },
  {
    id: "runs-by-verdict",
    template: "Which runs were marked {verdict} in the last {days} days?",
    purpose:
      "Pulls up every run carrying one judgement, with its note — how you find the pattern behind repeated infra failures.",
    blanks: [
      { key: "verdict", kind: "verdict", placeholder: "any verdict", required: true },
      { key: "days", kind: "days", placeholder: "30", required: true },
    ],
    scope: "both",
  },
  {
    id: "quarantine-audit",
    template: "What is quarantine hiding right now?",
    purpose:
      "Every quarantined test with its stated reason and whether it is still failing — so quarantine stays a decision rather than a place things go to be forgotten.",
    blanks: [],
    scope: "both",
  },
];

export function findQuestion(id: string | undefined): QuestionDefinition | undefined {
  return REPORT_QUESTIONS.find((question) => question.id === id);
}

/**
 * Resolves the choices for a question's blanks from data that exists.
 *
 * Branches, environments and suites come from the organisation's own runs, so a report can
 * never be built around a branch nobody pushed. A free-text blank would let a typo produce
 * an empty report, which reads as a broken feature rather than a mistyped filter.
 */
export async function resolveBlanks(
  sql: Sql,
  question: QuestionDefinition,
  scope: { orgId: string; projectId?: string | undefined },
): Promise<BlankOptions[]> {
  const resolved: BlankOptions[] = [];

  for (const blank of question.blanks) {
    switch (blank.kind) {
      case "days":
        resolved.push({
          key: blank.key,
          // Bare numbers: the template already supplies the word "days", so a "30 days"
          // label rendered "in the last 30 days days on …".
          options: REPORT_DAY_OPTIONS.map((days) => ({
            value: String(days),
            label: String(days),
          })),
          defaultValue: "30",
        });
        break;

      case "topN":
        resolved.push({
          key: blank.key,
          options: REPORT_TOP_N_OPTIONS.map((n) => ({ value: String(n), label: String(n) })),
          defaultValue: "10",
        });
        break;

      case "branch":
      case "environment": {
        const options = await runFilterOptions(sql, {
          orgId: scope.orgId,
          projectId: scope.projectId,
        });
        const values = blank.kind === "branch" ? options.branches : options.environments;
        resolved.push({
          key: blank.key,
          // No default: these blanks are optional, and "any branch" is usually the honest
          // starting point rather than whichever branch happens to sort first.
          options: values.map((value) => ({ value, label: value })),
        });
        break;
      }

      case "suite": {
        const suites = await listSuites(sql, {
          orgId: scope.orgId,
          projectId: scope.projectId,
          limit: 50,
        });
        resolved.push({
          key: blank.key,
          options: suites
            .filter((suite): suite is typeof suite & { suite: string } => suite.suite !== null)
            .map((suite) => ({ value: suite.suite, label: suite.suite })),
        });
        break;
      }

      case "project": {
        const projects = await listProjects(sql, scope.orgId);
        resolved.push({
          key: blank.key,
          options: projects.map((project) => ({ value: project.key, label: project.name })),
        });
        break;
      }

      case "verdict":
        resolved.push({
          key: blank.key,
          options: [
            { value: "pass", label: "Pass" },
            { value: "product-bug", label: "Product bug" },
            { value: "infra", label: "Infra" },
            { value: "flaky", label: "Flaky" },
            { value: "investigating", label: "Investigating" },
          ],
        });
        break;
    }
  }

  return resolved;
}

/** Clamped so a hand-edited URL cannot ask for an unbounded window. */
function daysFrom(params: Record<string, string | undefined>): number {
  const requested = Number(params.days);
  return REPORT_DAY_OPTIONS.find((option) => option === requested) ?? 30;
}

export interface ReportContext {
  orgId: string;
  projectId?: string | undefined;
  /** Named in the subtitle so a printed page states what it measured. */
  scopeLabel: string;
  /** Where a panel's rows link back to. */
  orgSlug: string;
}

/**
 * The project key to print on a row, or nothing when the report already names one project.
 *
 * Every question here runs at both scopes. At organisation scope a ranked list of test names
 * spans projects, so a row identifies a test the reader cannot place — and two projects with a
 * similarly-named test become indistinguishable. Inside one project the same string repeated
 * down the list says nothing and takes width from the names, which are what differ.
 */
function rowScope(ctx: ReportContext, projectKey: string): string | undefined {
  return ctx.projectId ? undefined : projectKey;
}

/**
 * Runs a question and returns finished panels.
 *
 * Every question produces a chart *and* a table over the same rows. The chart carries the
 * shape; the table carries the values, which is what someone quoting a number from a printed
 * report actually needs — and it doubles as the non-visual fallback the accessibility rules
 * require of any chart.
 */
export async function runReport(
  sql: Sql,
  question: QuestionDefinition,
  params: Record<string, string | undefined>,
  ctx: ReportContext,
): Promise<ReportResult> {
  const days = daysFrom(params);
  const branch = params.branch?.trim() || undefined;

  const title = fillTemplate(question.template, question.blanks, { ...params, days: String(days) });
  const subtitle = [
    ctx.scopeLabel,
    `last ${days} days`,
    branch ? `branch ${branch}` : "all branches",
  ].join(" · ");

  const runner = RUNNERS[question.id];
  if (!runner) throw new Error(`no runner registered for question "${question.id}"`);
  const panels = await runner(sql, { days, branch, ...params }, ctx);

  return {
    questionId: question.id,
    title,
    subtitle,
    panels,
    empty: panels.every((panel) => isPanelEmpty(panel)),
  };
}

/**
 * Question id → the function that answers it.
 *
 * A registry rather than a switch: adding a question is one catalog entry plus one entry
 * here, and a question whose runner is missing fails loudly at request time instead of
 * silently rendering somebody else's panels — which is what an `else` branch would do.
 */
type QuestionRunner = (sql: Sql, input: RunnerInput, ctx: ReportContext) => Promise<ReportPanel[]>;

interface RunnerInput extends Record<string, string | number | undefined> {
  days: number;
  branch?: string | undefined;
}

function isPanelEmpty(panel: ReportPanel): boolean {
  switch (panel.data.kind) {
    case "ranked":
      return panel.data.bars.length === 0;
    case "table":
      return panel.data.rows.length === 0;
    case "trend":
      return panel.data.points.every((point) => point.value === null);
    case "volume":
      return panel.data.days.length === 0;
    case "stat":
      // "0" is an answer — "nothing is quarantined" is worth printing. "—" means there was
      // nothing to measure, which is the genuine no-data case the empty state is for.
      return panel.data.value === "—";
  }
}

/**
 * Failures by test over the window, plus how concentrated they are.
 *
 * Counted from `test_results` rather than the `test_cases.failures_30d` rollup, because the
 * rollup's window is fixed at 30 days and this question's is not. Bounded by the window and
 * served by the (test_case_id, started_at) index.
 */
async function mostFailingTests(
  sql: Sql,
  input: { days: number; branch?: string | undefined },
  ctx: ReportContext,
): Promise<ReportPanel[]> {
  const rows = await sql<
    {
      id: number;
      name: string;
      suite: string | null;
      projectKey: string;
      failures: number;
      runs: number;
    }[]
  >`
    SELECT
      tc.id,
      tc.name,
      tc.suite,
      p.key AS "projectKey",
      count(*) FILTER (WHERE r.status IN ('failed', 'error'))::int AS failures,
      count(*)::int AS runs
    FROM test_results r
    JOIN test_cases tc ON tc.id = r.test_case_id
    JOIN projects p ON p.id = tc.project_id
    JOIN runs run ON run.id = r.run_id
    WHERE r.org_id = ${ctx.orgId}
      ${ctx.projectId ? sql`AND r.project_id = ${ctx.projectId}` : sql``}
      ${input.branch ? sql`AND run.branch = ${input.branch}` : sql``}
      AND r.started_at >= now() - (${input.days} || ' days')::interval
    GROUP BY tc.id, tc.name, tc.suite, p.key
    HAVING count(*) FILTER (WHERE r.status IN ('failed', 'error')) > 0
    ORDER BY failures DESC, tc.name ASC
    LIMIT 15
  `;

  const totalFailures = rows.reduce((sum, row) => sum + row.failures, 0);
  const topFive = rows.slice(0, 5).reduce((sum, row) => sum + row.failures, 0);

  return [
    {
      id: "concentration",
      title: "Failure concentration",
      width: "half",
      footnote:
        totalFailures > 0
          ? `${rows.length} test${rows.length === 1 ? "" : "s"} failed at least once. A high share in the top five means a few tests, not a systemic problem.`
          : undefined,
      data: {
        kind: "stat",
        value: totalFailures === 0 ? "—" : `${Math.round((topFive * 100) / totalFailures)}%`,
        hint: "of failures came from the top 5 tests",
        tone: "failed",
      },
    },
    {
      id: "failures-by-test",
      title: "Failures by test",
      width: "full",
      data: {
        kind: "ranked",
        bars: rows.slice(0, 10).map((row) => ({
          label: row.name,
          scope: rowScope(ctx, row.projectKey),
          value: row.failures,
          display: `${row.failures} of ${row.runs}`,
          detail: row.suite,
          href: `/o/${ctx.orgSlug}/tests/${row.id}`,
        })),
      },
    },
    {
      id: "failures-table",
      title: "All failing tests in the window",
      width: "full",
      data: {
        kind: "table",
        columns: [
          { key: "name", label: "Test" },
          { key: "suite", label: "Suite" },
          { key: "failures", label: "Failures", align: "right" },
          { key: "runs", label: "Runs", align: "right" },
          { key: "rate", label: "Fail rate", align: "right" },
        ],
        rows: rows.map((row) => ({
          name: row.name,
          suite: row.suite ?? "—",
          failures: String(row.failures),
          runs: String(row.runs),
          rate: `${Math.round((row.failures * 100) / row.runs)}%`,
        })),
      },
    },
  ];
}

/**
 * Pass rate per day over the window.
 *
 * Reads `project_daily_stats`, which is why an arbitrary window is cheap: this is a scan of
 * one small table rather than an aggregation over results. The calendar fill means a quiet
 * weekend shows as a gap instead of compressing the axis.
 */
async function passRateTrend(
  sql: Sql,
  input: { days: number; branch?: string | undefined },
  ctx: ReportContext,
): Promise<ReportPanel[]> {
  const rows = await sql<
    { day: string; passRate: number | null; runs: number; tests: number; failed: number }[]
  >`
    WITH calendar AS (
      SELECT generate_series(
        (now() - (${input.days - 1} || ' days')::interval)::date, now()::date, '1 day'
      )::date AS day
    ),
    stats AS (
      SELECT day,
             sum(runs)::int AS runs,
             sum(tests)::int AS tests,
             sum(failed)::int AS failed,
             CASE WHEN sum(passed + failed) = 0 THEN NULL
                  ELSE ROUND(sum(passed)::numeric * 100 / sum(passed + failed), 2) END AS pass_rate
      FROM project_daily_stats
      WHERE org_id = ${ctx.orgId}
        ${ctx.projectId ? sql`AND project_id = ${ctx.projectId}` : sql``}
        ${input.branch ? sql`AND branch = ${input.branch}` : sql``}
        AND day >= (now() - (${input.days - 1} || ' days')::interval)::date
      GROUP BY day
    )
    SELECT to_char(calendar.day, 'Mon DD') AS day,
           stats.pass_rate AS "passRate",
           COALESCE(stats.runs, 0) AS runs,
           COALESCE(stats.tests, 0) AS tests,
           COALESCE(stats.failed, 0) AS failed
    FROM calendar LEFT JOIN stats ON stats.day = calendar.day
    ORDER BY calendar.day ASC
  `;

  const measured = rows.filter((row) => row.passRate !== null);
  const first = measured[0]?.passRate ?? null;
  const last = measured.at(-1)?.passRate ?? null;
  const delta = first !== null && last !== null ? Number(last) - Number(first) : null;

  return [
    {
      id: "pass-rate-now",
      title: "Pass rate at the end of the window",
      width: "half",
      footnote:
        delta === null
          ? "Not enough measured days to state a direction."
          : `${delta >= 0 ? "Up" : "Down"} ${Math.abs(delta).toFixed(1)} points across the window.`,
      data: {
        kind: "stat",
        value: last === null ? "—" : `${Number(last).toFixed(1)}%`,
        hint: `${measured.length} of ${rows.length} days had runs`,
        tone:
          last === null
            ? "neutral"
            : Number(last) >= 98
              ? "passed"
              : Number(last) >= 90
                ? "flaky"
                : "failed",
      },
    },
    {
      id: "pass-rate-trend",
      title: "Pass rate by day",
      width: "full",
      data: {
        kind: "trend",
        format: "percent",
        yMax: 100,
        points: rows.map((row) => ({
          label: row.day,
          value: row.passRate === null ? null : Number(row.passRate),
          detail: row.runs > 0 ? `${row.runs} run(s), ${row.tests} tests` : undefined,
        })),
      },
    },
    {
      id: "pass-rate-table",
      title: "Day by day",
      width: "full",
      data: {
        kind: "table",
        columns: [
          { key: "day", label: "Day" },
          { key: "runs", label: "Runs", align: "right" },
          { key: "tests", label: "Tests", align: "right" },
          { key: "failed", label: "Failed", align: "right" },
          { key: "rate", label: "Pass rate", align: "right" },
        ],
        // Days with no runs are dropped from the table but kept in the chart: a gap is
        // information in a trend and a blank row in a table.
        rows: rows
          .filter((row) => row.runs > 0)
          .map((row) => ({
            day: row.day,
            runs: String(row.runs),
            tests: String(row.tests),
            failed: String(row.failed),
            rate: row.passRate === null ? "—" : `${Number(row.passRate).toFixed(1)}%`,
          })),
      },
    },
  ];
}

/**
 * Scope predicates shared by every runner below.
 *
 * Written once because forgetting `org_id` on one of a dozen queries is exactly the kind of
 * mistake that leaks another tenant's data, and a helper makes the omission visible.
 */
function orgScope(sql: Sql, ctx: ReportContext) {
  return ctx.projectId
    ? sql`r.org_id = ${ctx.orgId} AND r.project_id = ${ctx.projectId}`
    : sql`r.org_id = ${ctx.orgId}`;
}

function runScope(sql: Sql, ctx: ReportContext) {
  return ctx.projectId
    ? sql`run.org_id = ${ctx.orgId} AND run.project_id = ${ctx.projectId}`
    : sql`run.org_id = ${ctx.orgId}`;
}

/** Tests that were clean in the previous window of the same length and are failing in this one. */
async function newlyFailing(
  sql: Sql,
  input: RunnerInput,
  ctx: ReportContext,
): Promise<ReportPanel[]> {
  const rows = await sql<
    {
      id: number;
      name: string;
      suite: string | null;
      projectKey: string;
      failures: number;
      runs: number;
    }[]
  >`
    WITH windowed AS (
      SELECT r.test_case_id,
             count(*) FILTER (WHERE r.status IN ('failed','error') AND r.started_at >= now() - (${input.days} || ' days')::interval)::int AS failures_now,
             count(*) FILTER (WHERE r.started_at >= now() - (${input.days} || ' days')::interval)::int AS runs_now,
             count(*) FILTER (WHERE r.status IN ('failed','error') AND r.started_at < now() - (${input.days} || ' days')::interval)::int AS failures_before
      FROM test_results r
      JOIN runs run ON run.id = r.run_id
      WHERE ${orgScope(sql, ctx)}
        ${input.branch ? sql`AND run.branch = ${input.branch as string}` : sql``}
        AND r.started_at >= now() - (${input.days * 2} || ' days')::interval
      GROUP BY r.test_case_id
    )
    SELECT tc.id, tc.name, tc.suite, p.key AS "projectKey",
           w.failures_now AS failures, w.runs_now AS runs
    FROM windowed w
    JOIN test_cases tc ON tc.id = w.test_case_id
    JOIN projects p ON p.id = tc.project_id
    -- Clean before, failing now. Both halves matter: without the first this is just
    -- "failing tests", and the question is specifically about what changed.
    WHERE w.failures_now > 0 AND w.failures_before = 0
    ORDER BY w.failures_now DESC, tc.name ASC
    LIMIT 25
  `;

  return [
    {
      id: "newly-failing-count",
      title: "Tests newly failing",
      width: "half",
      footnote: `Clean for the ${input.days} days before the window, failing inside it. Compared against the same length of history, so the two halves are like for like.`,
      data: {
        kind: "stat",
        value: String(rows.length),
        hint: `in the last ${input.days} days`,
        tone: rows.length > 0 ? "failed" : "passed",
      },
    },
    {
      id: "newly-failing-ranked",
      title: "Failures since they started failing",
      width: "full",
      data: {
        kind: "ranked",
        bars: rows.slice(0, 12).map((row) => ({
          label: row.name,
          scope: rowScope(ctx, row.projectKey),
          value: row.failures,
          display: `${row.failures} of ${row.runs}`,
          detail: row.suite,
          href: `/o/${ctx.orgSlug}/tests/${row.id}`,
        })),
      },
    },
    {
      id: "newly-failing-table",
      title: "All newly failing tests",
      width: "full",
      data: {
        kind: "table",
        columns: [
          { key: "name", label: "Test" },
          { key: "suite", label: "Suite" },
          { key: "failures", label: "Failures", align: "right" },
          { key: "runs", label: "Runs", align: "right" },
        ],
        rows: rows.map((row) => ({
          name: row.name,
          suite: row.suite ?? "—",
          failures: String(row.failures),
          runs: String(row.runs),
        })),
      },
    },
  ];
}

/** Suite pass rate this window against the window before it. */
async function suiteRegressions(
  sql: Sql,
  input: RunnerInput,
  ctx: ReportContext,
): Promise<ReportPanel[]> {
  const rows = await sql<
    {
      suite: string;
      nowRate: number | null;
      beforeRate: number | null;
      nowRuns: number;
      delta: number | null;
    }[]
  >`
    WITH split AS (
      SELECT COALESCE(tc.suite, '(no suite)') AS suite,
             r.status,
             r.started_at >= now() - (${input.days} || ' days')::interval AS is_now
      FROM test_results r
      JOIN test_cases tc ON tc.id = r.test_case_id
      JOIN runs run ON run.id = r.run_id
      WHERE ${orgScope(sql, ctx)}
        AND r.started_at >= now() - (${input.days * 2} || ' days')::interval
    ),
    agg AS (
      SELECT suite,
             count(*) FILTER (WHERE is_now)::int AS now_runs,
             -- float8 rather than numeric: postgres.js returns numeric as a string, and
             -- these values are compared and subtracted downstream.
             (100.0 * count(*) FILTER (WHERE is_now AND status = 'passed')
               / NULLIF(count(*) FILTER (WHERE is_now AND status IN ('passed','failed','error')), 0))::float8 AS now_rate,
             (100.0 * count(*) FILTER (WHERE NOT is_now AND status = 'passed')
               / NULLIF(count(*) FILTER (WHERE NOT is_now AND status IN ('passed','failed','error')), 0))::float8 AS before_rate
      FROM split GROUP BY suite
    )
    SELECT suite,
           now_rate AS "nowRate",
           before_rate AS "beforeRate",
           now_runs AS "nowRuns",
           (now_rate - before_rate)::float8 AS delta
    FROM agg
    WHERE now_runs > 0 AND before_rate IS NOT NULL AND now_rate IS NOT NULL
    ORDER BY delta ASC
  `;

  const regressed = rows.filter((row) => (row.delta ?? 0) < 0);

  return [
    {
      id: "regressed-count",
      title: "Suites that got worse",
      width: "half",
      footnote:
        regressed.length > 0
          ? `Worst: ${regressed[0]?.suite} at ${(regressed[0]?.delta ?? 0).toFixed(1)} points.`
          : "No suite has a lower pass rate than it did in the previous window.",
      data: {
        kind: "stat",
        value: `${regressed.length} of ${rows.length}`,
        hint: "compared with the previous window",
        tone: regressed.length > 0 ? "failed" : "passed",
      },
    },
    {
      id: "regressed-ranked",
      title: "Pass-rate drop, in points",
      width: "full",
      footnote:
        "Only suites that dropped are charted — an improvement is not a regression, and mixing the two into one bar length would make the chart unreadable. The table below has both directions.",
      data: {
        kind: "ranked",
        bars: regressed.slice(0, 12).map((row) => ({
          label: row.suite,
          value: Math.abs(row.delta ?? 0),
          display: `${(row.delta ?? 0).toFixed(1)} pts`,
          detail: `${(row.beforeRate ?? 0).toFixed(1)}% → ${(row.nowRate ?? 0).toFixed(1)}%`,
        })),
      },
    },
    {
      id: "regressed-table",
      title: "Every suite, both windows",
      width: "full",
      data: {
        kind: "table",
        columns: [
          { key: "suite", label: "Suite" },
          { key: "before", label: "Previous", align: "right" },
          { key: "now", label: "Current", align: "right" },
          { key: "delta", label: "Change", align: "right" },
          { key: "runs", label: "Results", align: "right" },
        ],
        rows: rows.map((row) => ({
          suite: row.suite,
          before: `${(row.beforeRate ?? 0).toFixed(1)}%`,
          now: `${(row.nowRate ?? 0).toFixed(1)}%`,
          delta: `${(row.delta ?? 0) >= 0 ? "+" : ""}${(row.delta ?? 0).toFixed(1)}`,
          runs: String(row.nowRuns),
        })),
      },
    },
  ];
}

/** Total wall-clock consumed per test — where the CI budget actually goes. */
async function ciTime(sql: Sql, input: RunnerInput, ctx: ReportContext): Promise<ReportPanel[]> {
  const environment = typeof input.environment === "string" ? input.environment : undefined;

  const rows = await sql<
    {
      id: number;
      name: string;
      suite: string | null;
      projectKey: string;
      totalMs: number;
      executions: number;
      avgMs: number;
    }[]
  >`
    SELECT tc.id, tc.name, tc.suite, p.key AS "projectKey",
           -- float8 so a multi-hour total is a JS number rather than an int8 string.
           sum(r.duration_ms)::float8 AS "totalMs",
           count(*)::int AS executions,
           avg(r.duration_ms)::float8 AS "avgMs"
    FROM test_results r
    JOIN test_cases tc ON tc.id = r.test_case_id
    JOIN projects p ON p.id = tc.project_id
    JOIN runs run ON run.id = r.run_id
    WHERE ${orgScope(sql, ctx)}
      ${environment ? sql`AND run.environment = ${environment}` : sql``}
      AND r.started_at >= now() - (${input.days} || ' days')::interval
      AND r.duration_ms IS NOT NULL
    GROUP BY tc.id, tc.name, tc.suite, p.key
    ORDER BY "totalMs" DESC
    LIMIT 25
  `;

  const total = rows.reduce((sum, row) => sum + row.totalMs, 0);
  const topShare =
    total > 0 ? (rows.slice(0, 10).reduce((s, r) => s + r.totalMs, 0) * 100) / total : 0;

  return [
    {
      id: "ci-time-total",
      title: "Time in the top 25 tests",
      width: "half",
      footnote:
        total > 0
          ? `The top ten account for ${Math.round(topShare)}% of it. Optimising anything outside them is rounding error.`
          : undefined,
      data: {
        kind: "stat",
        value: formatMs(total),
        hint: `across ${rows.reduce((s, r) => s + r.executions, 0).toLocaleString()} executions`,
      },
    },
    {
      id: "ci-time-ranked",
      title: "Total time consumed per test",
      width: "full",
      footnote:
        "Total, not average: a fast test run ten thousand times can cost more than a slow one run twice, and only the total tells you which.",
      data: {
        kind: "ranked",
        bars: rows.slice(0, 12).map((row) => ({
          label: row.name,
          scope: rowScope(ctx, row.projectKey),
          value: row.totalMs,
          display: formatMs(row.totalMs),
          detail: `${row.executions} runs · ${formatMs(row.avgMs)} avg`,
          href: `/o/${ctx.orgSlug}/tests/${row.id}`,
        })),
      },
    },
    {
      id: "ci-time-table",
      title: "Time by test",
      width: "full",
      data: {
        kind: "table",
        columns: [
          { key: "name", label: "Test" },
          { key: "suite", label: "Suite" },
          { key: "total", label: "Total", align: "right" },
          { key: "avg", label: "Average", align: "right" },
          { key: "executions", label: "Executions", align: "right" },
        ],
        rows: rows.map((row) => ({
          name: row.name,
          suite: row.suite ?? "—",
          total: formatMs(row.totalMs),
          avg: formatMs(row.avgMs),
          executions: String(row.executions),
        })),
      },
    },
  ];
}

/** Run-level duration outliers, which per-test figures hide. */
async function slowestRuns(
  sql: Sql,
  input: RunnerInput,
  ctx: ReportContext,
): Promise<ReportPanel[]> {
  const rows = await sql<
    {
      id: string;
      name: string | null;
      framework: string | null;
      branch: string | null;
      durationMs: number;
      total: number;
      startedAt: Date;
    }[]
  >`
    SELECT run.id, run.name, run.framework, run.branch,
           run.duration_ms::float8 AS "durationMs",
           run.total, run.started_at AS "startedAt"
    FROM runs run
    WHERE ${runScope(sql, ctx)}
      ${input.branch ? sql`AND run.branch = ${input.branch as string}` : sql``}
      AND run.started_at >= now() - (${input.days} || ' days')::interval
      AND run.duration_ms IS NOT NULL
    ORDER BY run.duration_ms DESC
    LIMIT 20
  `;

  const median = rows.length > 0 ? (rows[Math.floor(rows.length / 2)]?.durationMs ?? 0) : 0;

  return [
    {
      id: "slowest-run",
      title: "Longest single run",
      width: "half",
      footnote:
        rows.length > 0
          ? `Median of the top ${rows.length} is ${formatMs(median)}. A long tail here usually means one job, not the suite.`
          : undefined,
      data: {
        kind: "stat",
        value: rows[0] ? formatMs(rows[0].durationMs) : "—",
        hint: rows[0]?.name ?? rows[0]?.framework ?? undefined,
      },
    },
    {
      id: "slowest-runs-ranked",
      title: "Longest runs",
      width: "full",
      data: {
        kind: "ranked",
        bars: rows.slice(0, 12).map((row) => ({
          label: row.name ?? row.framework ?? "Run",
          value: row.durationMs,
          display: formatMs(row.durationMs),
          detail: `${row.total} tests${row.branch ? ` · ${row.branch}` : ""}`,
          href: `/o/${ctx.orgSlug}/runs/${row.id}`,
        })),
      },
    },
  ];
}

/**
 * Tests that change outcome most often inside the window.
 *
 * Flips, not failures: a test that fails every time is broken and scores zero here, which is
 * the distinction the flake score exists to make. Computed over the chosen window rather than
 * read from `test_cases.flake_score`, whose window is fixed at 30 days.
 */
async function flippingTests(
  sql: Sql,
  input: RunnerInput,
  ctx: ReportContext,
): Promise<ReportPanel[]> {
  const suite = typeof input.suite === "string" ? input.suite : undefined;

  const rows = await sql<
    {
      id: number;
      name: string;
      suite: string | null;
      projectKey: string;
      flips: number;
      executions: number;
      failures: number;
    }[]
  >`
    WITH history AS (
      SELECT r.test_case_id, r.status, r.started_at,
             lag(r.status) OVER (PARTITION BY r.test_case_id ORDER BY r.started_at) AS prev_status
      FROM test_results r
      JOIN test_cases tc ON tc.id = r.test_case_id
      JOIN runs run ON run.id = r.run_id
      WHERE ${orgScope(sql, ctx)}
        ${suite ? sql`AND tc.suite = ${suite}` : sql``}
        AND r.started_at >= now() - (${input.days} || ' days')::interval
    )
    SELECT tc.id, tc.name, tc.suite, p.key AS "projectKey",
           count(*) FILTER (
             WHERE h.prev_status IS NOT NULL AND h.prev_status <> h.status
               AND h.status IN ('passed','failed','error')
               AND h.prev_status IN ('passed','failed','error')
           )::int AS flips,
           count(*)::int AS executions,
           count(*) FILTER (WHERE h.status IN ('failed','error'))::int AS failures
    FROM history h
    JOIN test_cases tc ON tc.id = h.test_case_id
    JOIN projects p ON p.id = tc.project_id
    GROUP BY tc.id, tc.name, tc.suite, p.key
    HAVING count(*) FILTER (
      WHERE h.prev_status IS NOT NULL AND h.prev_status <> h.status
        AND h.status IN ('passed','failed','error') AND h.prev_status IN ('passed','failed','error')
    ) > 0
    ORDER BY flips DESC, tc.name ASC
    LIMIT 25
  `;

  return [
    {
      id: "flipping-count",
      title: "Tests that flipped at least once",
      width: "half",
      footnote:
        "A flip is one execution disagreeing with the one before it. A test that fails every time never flips — it is broken, not flaky.",
      data: {
        kind: "stat",
        value: String(rows.length),
        hint: `in the last ${input.days} days`,
        tone: rows.length > 0 ? "flaky" : "passed",
      },
    },
    {
      id: "flipping-ranked",
      title: "Flips per test",
      width: "full",
      data: {
        kind: "ranked",
        bars: rows.slice(0, 12).map((row) => ({
          label: row.name,
          scope: rowScope(ctx, row.projectKey),
          value: row.flips,
          display: `${row.flips} flips`,
          detail: `${row.executions} executions · ${row.failures} failed`,
          href: `/o/${ctx.orgSlug}/tests/${row.id}`,
        })),
      },
    },
    {
      id: "flipping-table",
      title: "Flip detail",
      width: "full",
      data: {
        kind: "table",
        columns: [
          { key: "name", label: "Test" },
          { key: "suite", label: "Suite" },
          { key: "flips", label: "Flips", align: "right" },
          { key: "executions", label: "Executions", align: "right" },
          { key: "rate", label: "Flip rate", align: "right" },
        ],
        rows: rows.map((row) => ({
          name: row.name,
          suite: row.suite ?? "—",
          flips: String(row.flips),
          executions: String(row.executions),
          rate: `${Math.round((row.flips * 100) / Math.max(row.executions - 1, 1))}%`,
        })),
      },
    },
  ];
}

/** Pass rate split by environment. */
async function environmentReliability(
  sql: Sql,
  input: RunnerInput,
  ctx: ReportContext,
): Promise<ReportPanel[]> {
  const rows = await sql<
    { environment: string; passRate: number | null; runs: number; tests: number; failed: number }[]
  >`
    SELECT COALESCE(NULLIF(run.environment, ''), '(not reported)') AS environment,
           count(*)::int AS runs,
           sum(run.total)::int AS tests,
           sum(run.failed + run.errored)::int AS failed,
           (100.0 * sum(run.passed) / NULLIF(sum(run.passed + run.failed + run.errored), 0))::float8 AS "passRate"
    FROM runs run
    WHERE ${runScope(sql, ctx)}
      AND run.started_at >= now() - (${input.days} || ' days')::interval
    GROUP BY 1
    HAVING count(*) > 0
    ORDER BY "passRate" ASC NULLS LAST
  `;

  const worst = rows[0];

  return [
    {
      id: "env-worst",
      title: "Least reliable environment",
      width: "half",
      footnote:
        rows.length < 2
          ? "Only one environment reported in this window, so there is nothing to compare against."
          : undefined,
      data: {
        kind: "stat",
        value: worst ? `${(worst.passRate ?? 0).toFixed(1)}%` : "—",
        hint: worst?.environment,
        tone: worst && (worst.passRate ?? 0) < 90 ? "failed" : "flaky",
      },
    },
    {
      id: "env-ranked",
      title: "Pass rate by environment",
      width: "full",
      footnote: "Fixed 0–100% axis, so a small difference between environments reads as small.",
      data: {
        kind: "ranked",
        domainMax: 100,
        bars: rows.map((row) => ({
          label: row.environment,
          value: row.passRate ?? 0,
          display: `${(row.passRate ?? 0).toFixed(1)}%`,
          detail: `${row.runs} runs · ${row.failed} failing of ${row.tests}`,
        })),
      },
    },
  ];
}

/** Runs with failures and no verdict — the review queue. */
async function unreviewedRuns(
  sql: Sql,
  input: RunnerInput,
  ctx: ReportContext,
): Promise<ReportPanel[]> {
  const rows = await sql<
    {
      id: string;
      name: string | null;
      framework: string | null;
      branch: string | null;
      failed: number;
      total: number;
      passRate: number | null;
      startedAt: Date;
    }[]
  >`
    SELECT run.id, run.name, run.framework, run.branch,
           (run.failed + run.errored) AS failed, run.total,
           run.pass_rate::float8 AS "passRate", run.started_at AS "startedAt"
    FROM runs run
    WHERE ${runScope(sql, ctx)}
      ${input.branch ? sql`AND run.branch = ${input.branch as string}` : sql``}
      AND run.started_at >= now() - (${input.days} || ' days')::interval
      AND run.status IN ('complete','partial','failed')
      AND (run.failed + run.errored) > 0
      -- No verdict of any kind. NOT EXISTS rather than a LEFT JOIN with a null test, so the
      -- planner can stop at the first matching verdict row per run.
      AND NOT EXISTS (SELECT 1 FROM run_verdicts v WHERE v.run_id = run.id AND v.org_id = ${ctx.orgId})
    ORDER BY run.started_at DESC
    LIMIT 50
  `;

  const byBranch = new Map<string, number>();
  for (const row of rows) {
    const key = row.branch ?? "(no branch)";
    byBranch.set(key, (byBranch.get(key) ?? 0) + 1);
  }

  return [
    {
      id: "unreviewed-count",
      title: "Runs awaiting review",
      width: "half",
      footnote:
        "Only runs that actually failed. An all-green run needs no verdict, so counting those would inflate the queue with nothing to decide.",
      data: {
        kind: "stat",
        value: String(rows.length),
        hint: `failed runs with no verdict in ${input.days} days`,
        tone: rows.length > 0 ? "flaky" : "passed",
      },
    },
    {
      id: "unreviewed-by-branch",
      title: "Unreviewed by branch",
      width: "full",
      data: {
        kind: "ranked",
        bars: [...byBranch.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([branch, count]) => ({
            label: branch,
            value: count,
            display: String(count),
          })),
      },
    },
    {
      id: "unreviewed-table",
      title: "The queue",
      width: "full",
      data: {
        kind: "table",
        columns: [
          { key: "run", label: "Run" },
          { key: "branch", label: "Branch" },
          { key: "failed", label: "Failed", align: "right" },
          { key: "rate", label: "Pass rate", align: "right" },
          { key: "when", label: "Started" },
        ],
        rows: rows.map((row) => ({
          run: row.name ?? row.framework ?? "Run",
          branch: row.branch ?? "—",
          failed: `${row.failed} of ${row.total}`,
          rate: `${(row.passRate ?? 0).toFixed(1)}%`,
          when: row.startedAt.toISOString().slice(0, 16).replace("T", " "),
        })),
      },
    },
  ];
}

/** The recorded causes behind failing runs. */
async function verdictSplit(
  sql: Sql,
  input: RunnerInput,
  ctx: ReportContext,
): Promise<ReportPanel[]> {
  const rows = await sql<{ verdict: string; runs: number }[]>`
    WITH failing AS (
      SELECT run.id
      FROM runs run
      WHERE ${runScope(sql, ctx)}
        AND run.started_at >= now() - (${input.days} || ' days')::interval
        AND run.status IN ('complete','partial','failed')
        AND (run.failed + run.errored) > 0
    ),
    latest AS (
      SELECT f.id AS run_id, v.verdict
      FROM failing f
      LEFT JOIN LATERAL (
        SELECT verdict FROM run_verdicts v
        WHERE v.run_id = f.id AND v.org_id = ${ctx.orgId}
        ORDER BY v.created_at DESC, v.id DESC LIMIT 1
      ) v ON true
    )
    SELECT COALESCE(verdict, 'unreviewed') AS verdict, count(*)::int AS runs
    FROM latest GROUP BY 1 ORDER BY runs DESC
  `;

  const total = rows.reduce((sum, row) => sum + row.runs, 0);
  const notCode = rows
    .filter((row) => row.verdict === "infra" || row.verdict === "flaky")
    .reduce((sum, row) => sum + row.runs, 0);
  const judged = rows.filter((row) => row.verdict !== "unreviewed").reduce((s, r) => s + r.runs, 0);

  return [
    {
      id: "verdict-not-code",
      title: "Red that was not the code",
      width: "half",
      footnote:
        judged === 0
          ? "No failing run in this window has a verdict yet, so the split cannot be computed. Record a few and this becomes the most useful number here."
          : `Of ${judged} judged run${judged === 1 ? "" : "s"}, ${notCode} were infra or flake. ${total - judged} still unreviewed.`,
      data: {
        kind: "stat",
        value: judged === 0 ? "—" : `${Math.round((notCode * 100) / judged)}%`,
        hint: "of judged failing runs were infra or flaky",
        tone: "flaky",
      },
    },
    {
      id: "verdict-ranked",
      title: "Failing runs by verdict",
      width: "full",
      footnote:
        "Unreviewed is shown alongside the verdicts rather than hidden: a large unreviewed slice means the other proportions are not yet trustworthy.",
      data: {
        kind: "ranked",
        bars: rows.map((row) => ({
          label: VERDICT_LABEL[row.verdict] ?? row.verdict,
          value: row.runs,
          display: `${row.runs} · ${total > 0 ? Math.round((row.runs * 100) / total) : 0}%`,
        })),
      },
    },
  ];
}

const VERDICT_LABEL: Record<string, string> = {
  pass: "Pass",
  "product-bug": "Product bug",
  infra: "Infra",
  flaky: "Flaky",
  investigating: "Investigating",
  unreviewed: "Unreviewed",
};

/** Every run carrying one verdict, with its note. */
async function runsByVerdict(
  sql: Sql,
  input: RunnerInput,
  ctx: ReportContext,
): Promise<ReportPanel[]> {
  const verdict = typeof input.verdict === "string" ? input.verdict : "infra";

  const rows = await sql<
    {
      id: string;
      name: string | null;
      framework: string | null;
      branch: string | null;
      note: string | null;
      author: string | null;
      failed: number;
      total: number;
      createdAt: Date;
    }[]
  >`
    SELECT run.id, run.name, run.framework, run.branch,
           latest.note, COALESCE(u.name, u.email) AS author,
           (run.failed + run.errored) AS failed, run.total,
           latest.created_at AS "createdAt"
    FROM runs run
    JOIN LATERAL (
      SELECT v.verdict, v.note, v.created_at, v.created_by
      FROM run_verdicts v
      WHERE v.run_id = run.id AND v.org_id = ${ctx.orgId}
      ORDER BY v.created_at DESC, v.id DESC LIMIT 1
    ) latest ON true
    LEFT JOIN users u ON u.id = latest.created_by
    WHERE ${runScope(sql, ctx)}
      AND run.started_at >= now() - (${input.days} || ' days')::interval
      -- The *current* verdict only: a run corrected away from infra should not still appear
      -- under infra, which is the whole point of keeping history rather than rows.
      AND latest.verdict = ${verdict}
    ORDER BY latest.created_at DESC
    LIMIT 50
  `;

  return [
    {
      id: "by-verdict-count",
      title: `Runs currently marked ${VERDICT_LABEL[verdict] ?? verdict}`,
      width: "half",
      footnote:
        "Counts the standing verdict, not every verdict ever recorded — a run corrected away from this judgement no longer appears.",
      data: {
        kind: "stat",
        value: String(rows.length),
        hint: `in the last ${input.days} days`,
      },
    },
    {
      id: "by-verdict-table",
      title: "The runs and what was said",
      width: "full",
      data: {
        kind: "table",
        columns: [
          { key: "run", label: "Run" },
          { key: "branch", label: "Branch" },
          { key: "failed", label: "Failed", align: "right" },
          { key: "note", label: "Note" },
          { key: "who", label: "Recorded by" },
        ],
        rows: rows.map((row) => ({
          run: row.name ?? row.framework ?? "Run",
          branch: row.branch ?? "—",
          failed: `${row.failed} of ${row.total}`,
          note: briefNote(row.note),
          who: row.author ?? "removed account",
        })),
      },
    },
  ];
}

/** Quarantined tests and whether they are still failing. */
async function quarantineAudit(
  sql: Sql,
  _input: RunnerInput,
  ctx: ReportContext,
): Promise<ReportPanel[]> {
  const rows = await sql<
    {
      id: number;
      name: string;
      suite: string | null;
      reason: string | null;
      failRate: number | null;
      runs: number;
      quarantinedAt: Date | null;
      lastSeen: Date;
    }[]
  >`
    SELECT tc.id, tc.name, tc.suite,
           tc.quarantine_reason AS reason,
           tc.fail_rate_30d::float8 AS "failRate",
           tc.runs_30d AS runs,
           tc.quarantined_at AS "quarantinedAt",
           tc.last_seen_at AS "lastSeen"
    FROM test_cases tc
    WHERE tc.org_id = ${ctx.orgId}
      ${ctx.projectId ? sql`AND tc.project_id = ${ctx.projectId}` : sql``}
      AND tc.quarantined
    ORDER BY tc.fail_rate_30d DESC NULLS LAST, tc.name ASC
  `;

  const stillFailing = rows.filter((row) => (row.failRate ?? 0) > 0).length;
  const unexplained = rows.filter((row) => !row.reason).length;

  return [
    {
      id: "quarantine-count",
      title: "Quarantined tests",
      width: "half",
      footnote:
        rows.length === 0
          ? "Nothing is quarantined."
          : `${stillFailing} still failing, ${unexplained} with no stated reason. A quarantine with no reason is indistinguishable from a test nobody looked at.`,
      data: {
        kind: "stat",
        value: String(rows.length),
        hint: "excluded from dashboards and gates",
        tone: "skipped",
      },
    },
    {
      id: "quarantine-table",
      title: "What is quarantined, and why",
      width: "full",
      data: {
        kind: "table",
        columns: [
          { key: "name", label: "Test" },
          { key: "suite", label: "Suite" },
          { key: "reason", label: "Stated reason" },
          { key: "rate", label: "Fail rate", align: "right" },
          { key: "since", label: "Quarantined" },
        ],
        rows: rows.map((row) => ({
          name: row.name,
          suite: row.suite ?? "—",
          reason: row.reason ?? "— none given —",
          rate: `${(row.failRate ?? 0).toFixed(0)}% of ${row.runs}`,
          since: row.quarantinedAt ? row.quarantinedAt.toISOString().slice(0, 10) : "—",
        })),
      },
    },
  ];
}

/**
 * Caps a free-text note for a table cell.
 *
 * Notes are whatever someone typed, and one 400-character note turns a printed row into half
 * a page. Truncated here rather than in CSS because print has to wrap rather than ellipsise,
 * so the limit has to exist in the data. The run page carries the full text.
 */
function briefNote(note: string | null, limit = 160): string {
  if (!note) return "—";
  const trimmed = note.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`;
}

/** Durations read as hours/minutes/seconds without pulling in the web app's formatter. */
function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

const RUNNERS: Record<string, QuestionRunner> = {
  "most-failing-tests": (sql, input, ctx) => mostFailingTests(sql, input, ctx),
  "newly-failing": newlyFailing,
  "pass-rate-trend": (sql, input, ctx) => passRateTrend(sql, input, ctx),
  "suite-regressions": suiteRegressions,
  "ci-time": ciTime,
  "slowest-runs": slowestRuns,
  "flipping-tests": flippingTests,
  "environment-reliability": environmentReliability,
  "unreviewed-runs": unreviewedRuns,
  "verdict-split": verdictSplit,
  "runs-by-verdict": runsByVerdict,
  "quarantine-audit": quarantineAudit,
};
