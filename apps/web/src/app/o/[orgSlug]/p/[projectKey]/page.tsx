import Link from "next/link";
import {
  dailySeries,
  branchPassRates,
  failureConcentration,
  flakeDistribution,
  flakyLeaderboard,
  latestRunVerdicts,
  listRuns,
  orgSummary,
  runActivity,
  runSeries,
  slowestTests,
  topFailingTests,
} from "@testcenter/db";
import { ChartToggle } from "@/components/charts/chart-toggle";
import { RUN_VERDICT_LABELS, type RunVerdict } from "@testcenter/core";
import { ActivityHeatmap } from "@/components/charts/activity-heatmap";
import { OutcomeDonut } from "@/components/charts/outcome-donut";
import { RankedBars } from "@/components/charts/ranked-bars";
import { TrendChart } from "@/components/charts/trend-chart";
import { VolumeChart } from "@/components/charts/volume-chart";
import { CiSnippet } from "@/components/ci-snippet";
import { TimeRangeNav } from "@/components/time-range-nav";
import {
  awaitsVerdict,
  VerdictBadge,
  VERDICT_COLOR,
  VERDICT_TODO_COLOR,
} from "@/components/verdict-badge";
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  ResultBar,
  StatTile,
  StatusBadge,
} from "@/components/ui";
import { passRateTone, TONE_COLOR } from "@/lib/health";
import {
  formatAbsoluteTime,
  formatDuration,
  formatPercent,
  formatRelativeTime,
  formatInteger,
} from "@/lib/format";
import { getServices } from "@/lib/services";
import { viewerTimeZone } from "@/lib/timezone";
import { can, requirePageContext, requirePageProject } from "@/lib/viewer";

/**
 * Project overview.
 *
 * Doubles as the onboarding screen: immediately after creation it shows the CI recipe
 * with a real token, because that is the one moment someone is ready to wire up their
 * pipeline. Afterwards it becomes the project's dashboard.
 */
export const dynamic = "force-dynamic";

/*
 * The same five windows as the organisation dashboard.
 *
 * This page used to offer only 7/15/30, on the reasoning that a quarter of history says
 * little about whether a suite is healthy *now*. That is still true of the pass-rate tiles,
 * but it stopped being a good trade once the page gained an execution series and a
 * punchcard: both need repetition to show a shape at all, and a fortnight of nightlies is
 * ten cells. Offering a wider window costs nothing to a reader who does not pick it.
 */
const DAY_OPTIONS = [7, 15, 30, 45, 90] as const;

export default async function ProjectOverview({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; projectKey: string }>;
  searchParams: Promise<{
    created?: string;
    token?: string;
    days?: string;
    ok?: string;
    volume?: string;
    rate?: string;
    duration?: string;
  }>;
}) {
  const { orgSlug, projectKey } = await params;
  const {
    created,
    token,
    days: daysParam,
    ok,
    volume: volumeParam,
    rate: rateParam,
    duration: durationParam,
  } = await searchParams;
  const context = await requirePageContext(orgSlug);
  const tz = await viewerTimeZone();
  const project = await requirePageProject(context, projectKey);
  const { sql } = getServices();

  /*
   * Snapped to the offered set, not clamped to a range.
   *
   * Clamping accepted `?days=45` and silently measured 45 days while no button was
   * highlighted, so the URL and the control disagreed about what was on screen. Anything
   * unrecognised falls back to the default instead.
   */
  // Defaults to a week. The page is opened to answer "how are we doing right now",
  // and a 30-day window dilutes a bad Tuesday into a rounding error — the reader who
  // wants the longer view asks for it, and the URL then carries the choice.
  const days = DAY_OPTIONS.find((option) => option === Number(daysParam)) ?? 7;
  const scope = { orgId: context.org.id, projectId: project.id };

  // Same three view selections as the org dashboard, so the two pages behave alike.
  const shareView = volumeParam === "share";
  const branchView = rateParam === "branch";
  const totalDurationView = durationParam === "total";

  const [
    summary,
    series,
    recent,
    flaky,
    failing,
    slowest,
    concentration,
    flakeBands,
    activity,
    runPoints,
  ] = await Promise.all([
    orgSummary(sql, scope),
    dailySeries(sql, { ...scope, days }),
    listRuns(sql, { orgId: context.org.id, projectId: project.id }, { limit: 8 }),
    flakyLeaderboard(sql, { ...scope, limit: 5 }),
    topFailingTests(sql, { ...scope, limit: 5 }),
    // Twenty, not six: both lists scroll, and the tail says whether this is one bad test
    // or something systemic.
    slowestTests(sql, { ...scope, limit: 20 }),
    failureConcentration(sql, { ...scope, limit: 20 }),
    flakeDistribution(sql, scope),
    runActivity(sql, { ...scope, days, timeZone: tz.zone }),
    runSeries(sql, { ...scope, days, timeZone: tz.zone }),
  ]);

  // One verdict query for both consumers — the recent-runs list and the execution chart's
  // ribbon overlap, and two calls would fetch the newest runs twice.
  const verdictRunIds = [
    ...new Set([...recent.runs.map((run) => run.id), ...runPoints.map((run) => run.id)]),
  ];
  const recentVerdicts = await latestRunVerdicts(sql, {
    orgId: context.org.id,
    runIds: verdictRunIds,
  });

  const branchRates = branchView ? await branchPassRates(sql, { ...scope, days, limit: 8 }) : [];

  // listRuns returns newest first, so the head is the latest run. Taken from the list the
  // page already fetched rather than querying again for one row.
  const latestRun = recent.runs[0] ?? null;

  const base = `/o/${orgSlug}/p/${projectKey}`;

  /** Preserves the other selections when one toggle changes. */
  const viewHref = (changes: Record<string, string | null>): string => {
    const next = new URLSearchParams();
    if (daysParam) next.set("days", String(days));
    if (volumeParam) next.set("volume", volumeParam);
    if (rateParam) next.set("rate", rateParam);
    if (durationParam) next.set("duration", durationParam);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    const query = next.toString();
    return query ? `${base}?${query}` : base;
  };
  const hasRuns = summary.runs30d > 0 || recent.runs.length > 0;

  return (
    <main className="mx-auto max-w-7xl px-6 py-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">{project.name}</h1>
          <p className="mt-0.5 font-mono text-xs text-[var(--color-ink-muted)]">
            {project.key} · default branch {project.defaultBranch}
          </p>
          {/* When the suite last ran, which is the first thing worth knowing about a
              dashboard: numbers from a suite nobody has run this week describe the past,
              and nothing on the page says so otherwise. The absolute time is on hover
              because "3h ago" is the readable form and the timestamp is the precise one. */}
          <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
            {summary.lastRunAt ? (
              <>
                Last run{" "}
                <span
                  title={formatAbsoluteTime(summary.lastRunAt, tz.zone, tz.label)}
                  className="text-[var(--color-ink)]"
                >
                  {formatRelativeTime(summary.lastRunAt)}
                </span>
                {latestRun?.branch ? (
                  <span className="font-mono"> on {latestRun.branch}</span>
                ) : null}
                {latestRun ? (
                  <>
                    {" · "}
                    <Link href={`/o/${orgSlug}/runs/${latestRun.id}`} className="underline">
                      open
                    </Link>
                  </>
                ) : null}
              </>
            ) : (
              "No runs yet"
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <TimeRangeNav
            options={DAY_OPTIONS.map((option) => ({
              days: option,
              href: viewHref({ days: String(option) }),
              active: days === option,
            }))}
          />
          <Button href={`${base}/runs`}>Runs</Button>
          <Button href={`${base}/tests`}>Tests</Button>
          {can(context, "run:upload") ? (
            <Button href={`${base}/upload`} variant="primary">
              Upload
            </Button>
          ) : null}
        </div>
      </div>

      {created ? (
        <Card className="mb-5 border-[var(--color-status-passed)]/40">
          <CardHeader title="Project created — connect your CI" />
          <div className="px-5 py-4">
            <CiSnippet projectKey={project.key} token={token ?? null} />
          </div>
        </Card>
      ) : null}
      {/* Confirmation after a redirect — restoring a project lands here, and a message that
          is redirected with but never rendered is worse than no message at all. */}
      {ok ? (
        <p className="mb-4 rounded-md border border-[var(--color-status-passed)]/40 bg-[var(--color-status-passed)]/5 px-3 py-2 text-xs text-[var(--color-status-passed)]">
          {ok}
        </p>
      ) : null}

      {!hasRuns ? (
        <Card>
          <EmptyState
            title="No results yet"
            description="Upload a JUnit XML report from the browser, or POST one from CI. Trends and flakiness appear once there are a few runs to compare."
            action={
              can(context, "run:upload") ? (
                <Button href={`${base}/upload`} variant="primary">
                  Upload a report
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <>
          <Card className="mb-5">
            <div className="grid grid-cols-2 divide-x divide-y divide-[var(--color-border-subtle)] sm:grid-cols-3 lg:grid-cols-6 lg:divide-y-0">
              <StatTile
                label="Pass rate"
                value={formatPercent(summary.passRate30d)}
                tone={passRateTone(summary.passRate30d)}
                hint="last 30 days"
              />
              <StatTile label="Runs" value={summary.runs30d} hint={`${summary.runsToday} today`} />
              <StatTile label="Tests" value={formatInteger(summary.tests30d)} />
              <StatTile
                label="Failing"
                value={summary.failing30d}
                tone={summary.failing30d > 0 ? "failed" : "neutral"}
              />
              <StatTile
                label="Flaky tests"
                value={summary.flakyTests}
                tone={summary.flakyTests > 0 ? "flaky" : "neutral"}
              />
              <StatTile label="Quarantined" value={summary.quarantined} tone="skipped" />
            </div>
          </Card>

          {/*
           * Today, one column per run — placed above the 30-day charts on purpose.
           *
           * Someone watching a suite finish is asking "is this run worse than the last one?",
           * and every chart below answers only "how has the month gone". A daily rollup cannot
           * answer it at all: it averages today's runs together, so a single bad run hides
           * inside the day's number until tomorrow.
           */}
          {/* Two thirds to the window's executions, one third to its rhythm — the same
              pairing the organisation dashboard leads with. */}
          <div className="mb-5 grid gap-5 lg:grid-cols-3">
            <Card className="p-4 lg:col-span-2">
              <VolumeChart
                title="Execution over time"
                shape="area"
                mode={shareView ? "share" : "counts"}
                days={runPoints.map((run) => ({
                  label: run.label,
                  detail: [run.name ?? run.status, run.branch].filter(Boolean).join(" · "),
                  href: `/o/${orgSlug}/runs/${run.id}`,
                  ribbon: ribbonFor(recentVerdicts.get(run.id)?.verdict ?? null),
                  passed: run.passed,
                  failed: run.failed,
                  skipped: run.skipped,
                  flaky: run.flaky,
                  runs: 1,
                }))}
                action={
                  <ChartToggle
                    label="Outcome view"
                    options={[
                      { label: "counts", href: viewHref({ volume: null }), active: !shareView },
                      { label: "share", href: viewHref({ volume: "share" }), active: shareView },
                    ]}
                  />
                }
              />
            </Card>

            <Card className="flex flex-col p-4">
              <ActivityHeatmap
                title="When"
                buckets={activity}
                days={days}
                unit="run"
                timeZoneLabel={tz.label}
                action={
                  <span className="text-[11px] text-[var(--color-ink-muted)]">
                    last {days} days
                  </span>
                }
              />
            </Card>
          </div>

          <div className="mb-5 grid gap-5 lg:grid-cols-3">
            <Card className="p-4">
              {branchView ? (
                <RankedBars
                  title="Pass rate by branch"
                  domainMax={100}
                  bars={branchRates.map((row) => ({
                    label: row.branch,
                    value: row.passRate ?? 0,
                    display: formatPercent(row.passRate),
                    detail: `${row.runs} run${row.runs === 1 ? "" : "s"} · ${row.failed} failing`,
                    // Same bands as the headline stat tile, so a branch is not "degraded"
                    // in one place and "healthy" in another.
                    color: TONE_COLOR[passRateTone(row.passRate)],
                  }))}
                  emptyMessage="No runs in this period"
                  footnote="Worst first. Bars share a fixed 0–100% axis, so a small gap is a small gap."
                  action={
                    <ChartToggle
                      label="Pass rate view"
                      options={[
                        { label: "over time", href: viewHref({ rate: null }), active: false },
                        { label: "by branch", href: viewHref({ rate: "branch" }), active: true },
                      ]}
                    />
                  }
                />
              ) : (
                <TrendChart
                  title="Pass rate"
                  points={series.map((point) => ({
                    label: point.day,
                    value: point.passRate,
                    detail: point.runs > 0 ? `${point.runs} run(s)` : undefined,
                  }))}
                  unit="%"
                  yMax={100}
                  format="percent"
                  action={
                    <ChartToggle
                      label="Pass rate view"
                      options={[
                        { label: "over time", href: viewHref({ rate: null }), active: true },
                        { label: "by branch", href: viewHref({ rate: "branch" }), active: false },
                      ]}
                    />
                  }
                />
              )}
            </Card>
            <Card className="flex flex-col p-4">
              {/* The composition of the window now leads the page as an execution series, so
                  this slot answers the narrower question the trends cannot: how did the last
                  run go. */}
              {latestRun ? (
                <OutcomeDonut
                  title="Last run"
                  passed={latestRun.passed}
                  failed={latestRun.failed + latestRun.errored}
                  skipped={latestRun.skipped}
                  flaky={latestRun.flaky}
                  action={
                    <Link
                      href={`${base}/runs/${latestRun.id}`}
                      className="text-[11px] text-[var(--color-ink-muted)] underline hover:text-[var(--color-ink)]"
                    >
                      open
                    </Link>
                  }
                  footnote={`${latestRun.name ?? latestRun.framework ?? "Run"} · ${formatRelativeTime(latestRun.startedAt)}`}
                />
              ) : (
                <OutcomeDonut
                  title="Last run"
                  passed={0}
                  failed={0}
                  skipped={0}
                  emptyMessage="No runs yet."
                />
              )}
            </Card>
            <Card className="p-4">
              <TrendChart
                title={totalDurationView ? "Total CI time" : "Average run duration"}
                points={series.map((point) => ({
                  label: point.day,
                  value: totalDurationView ? point.totalDurationMs : point.avgDurationMs,
                }))}
                color="var(--color-series-2)"
                format="duration"
                action={
                  <ChartToggle
                    label="Duration view"
                    options={[
                      {
                        label: "average",
                        href: viewHref({ duration: null }),
                        active: !totalDurationView,
                      },
                      {
                        label: "total",
                        href: viewHref({ duration: "total" }),
                        active: totalDurationView,
                      },
                    ]}
                  />
                }
              />
            </Card>
          </div>

          <div className="mb-5 grid gap-5 lg:grid-cols-3">
            <Card className="p-4">
              <RankedBars
                title="Slowest tests (p95)"
                maxVisible={5}
                bars={slowest.map((test) => ({
                  label: test.name,
                  value: test.p95DurationMs,
                  display: formatDuration(test.p95DurationMs),
                  href: `/o/${orgSlug}/tests/${test.id}`,
                }))}
                emptyMessage="No duration data yet."
                footnote="p95, not average — a test that is usually fast and occasionally slow is the one worth finding."
              />
            </Card>
            <Card className="p-4">
              <RankedBars
                title="Failure concentration"
                maxVisible={5}
                color="var(--color-status-failed)"
                bars={concentration.tests.map((test) => ({
                  label: test.name,
                  value: test.failures30d,
                  display: `${test.failures30d} · ${Math.round(test.share)}%`,
                  href: `/o/${orgSlug}/tests/${test.id}`,
                }))}
                emptyMessage="No failures in the retained history."
                footnote={
                  concentration.totalFailures > 0
                    ? `${concentration.failingTests} test${concentration.failingTests === 1 ? "" : "s"} produced ${formatInteger(concentration.totalFailures)} failures.`
                    : undefined
                }
              />
            </Card>
            <Card className="p-4">
              <RankedBars
                title="Flake score distribution"
                bars={flakeBands.map((band) => ({
                  label: band.label,
                  value: band.tests,
                  display: formatInteger(band.tests),
                }))}
                emptyMessage="No tests yet."
                footnote="The dashboard counts a test as flaky at 20 and above."
              />
            </Card>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <Card className="overflow-hidden">
              <CardHeader
                title="Recent runs"
                action={
                  <Link href={`${base}/runs`} className="text-[11px] underline">
                    view all
                  </Link>
                }
              />
              <ul className="divide-y divide-[var(--color-border-subtle)]">
                {recent.runs.map((run) => (
                  <li key={run.id} className="flex items-center gap-3 px-5 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        {/* Glance widget — see the note on the org dashboard. */}
                        <Link
                          href={`/o/${orgSlug}/runs/${run.id}`}
                          className="truncate text-xs font-medium hover:underline"
                        >
                          {run.name ?? run.framework ?? "Run"}
                        </Link>
                        <StatusBadge status={run.status} />
                        {awaitsVerdict(run.status) ? (
                          <VerdictBadge
                            verdict={recentVerdicts.get(run.id)?.verdict ?? null}
                            size="sm"
                          />
                        ) : null}
                      </div>
                      <div className="mt-0.5 flex gap-x-3 font-mono text-[10px] text-[var(--color-ink-muted)]">
                        {run.branch ? <span>{run.branch}</span> : null}
                        <span>{formatRelativeTime(run.startedAt)}</span>
                      </div>
                    </div>
                    <div className="w-24 shrink-0">
                      <div className="text-right font-mono text-[11px] tabular-nums">
                        {formatPercent(run.passRate)}
                      </div>
                      <div className="mt-1">
                        <ResultBar
                          passed={run.passed}
                          failed={run.failed + run.errored}
                          skipped={run.skipped}
                          flaky={run.flaky}
                          total={run.total}
                        />
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>

            <div className="space-y-5">
              <Card className="overflow-hidden">
                {/* Points at this project's leaderboard, not the organisation's — the card
                    is showing this project's flakes, so "view all" has to mean more of the
                    same rather than a wider list the reader did not ask for. */}
                <CardHeader
                  title="Flakiest tests"
                  action={
                    flaky.length > 0 ? (
                      <Link href={`${base}/flaky`} className="text-[11px] underline">
                        view all
                      </Link>
                    ) : undefined
                  }
                />
                {flaky.length === 0 ? (
                  <p className="px-5 py-5 text-center text-xs text-[var(--color-ink-muted)]">
                    None detected.
                  </p>
                ) : (
                  <ul className="divide-y divide-[var(--color-border-subtle)]">
                    {flaky.map((test) => (
                      <li key={test.id} className="flex items-center gap-3 px-5 py-2">
                        <Link
                          href={`/o/${orgSlug}/tests/${test.id}`}
                          className="min-w-0 flex-1 truncate text-xs hover:underline"
                        >
                          {test.name}
                        </Link>
                        <span className="shrink-0 font-mono text-[11px] text-[var(--color-status-flaky)] tabular-nums">
                          {Number(test.flakeScore).toFixed(0)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              <Card className="overflow-hidden">
                <CardHeader title="Most-failing tests" />
                {failing.length === 0 ? (
                  <p className="px-5 py-5 text-center text-xs text-[var(--color-ink-muted)]">
                    Nothing failing.
                  </p>
                ) : (
                  <ul className="divide-y divide-[var(--color-border-subtle)]">
                    {failing.map((test) => (
                      <li key={test.id} className="flex items-center gap-3 px-5 py-2">
                        <Link
                          href={`/o/${orgSlug}/tests/${test.id}`}
                          className="min-w-0 flex-1 truncate text-xs hover:underline"
                        >
                          {test.name}
                        </Link>
                        <span className="shrink-0 font-mono text-[11px] text-[var(--color-status-failed)] tabular-nums">
                          {test.failures30d}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          </div>
        </>
      )}
    </main>
  );
}

/**
 * A run's verdict as a ribbon cell, identical to the organisation dashboard's.
 *
 * Duplicated rather than shared because the two pages are the only callers and a one-function
 * module between them would be indirection for its own sake — but the colours come from
 * `VERDICT_COLOR`, so the two can never disagree about what "infra" looks like.
 */
function ribbonFor(verdict: string | null): { color: string; label: string } {
  if (verdict === null) return { color: VERDICT_TODO_COLOR, label: "verdict TODO" };
  const known = verdict in RUN_VERDICT_LABELS ? (verdict as RunVerdict) : null;
  return known
    ? { color: VERDICT_COLOR[known], label: `verdict ${RUN_VERDICT_LABELS[known]}` }
    : { color: "var(--color-border-subtle)", label: `verdict ${verdict}` };
}
