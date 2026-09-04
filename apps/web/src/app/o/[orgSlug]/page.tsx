import { cookies } from "next/headers";
import Link from "next/link";
import {
  FAILURE_CATEGORY_LABELS,
  UNCLASSIFIED_FAILURE_LABEL,
  FAILURE_TRIAGE_LABELS,
  RUN_VERDICT_LABELS,
  type FailureTriage,
  type RunVerdict,
} from "@testcenter/core";
import {
  branchPassRates,
  dashboardWindowSummary,
  failureCategories,
  recentFailureSummaries,
  failureConcentration,
  failureTriageBreakdown,
  flakeDistribution,
  flakyLeaderboard,
  latestRunVerdicts,
  listProjects,
  listRuns,
  orgSummary,
  runActivity,
  runSeries,
  slowestTests,
  topFailingTests,
} from "@testcenter/db";
import { ActivityHeatmap } from "@/components/charts/activity-heatmap";
import { ChartToggle } from "@/components/charts/chart-toggle";
import { DashboardStatTiles } from "@/components/dashboard-tiles";
import { OutcomeDonut } from "@/components/charts/outcome-donut";
import { RankedBars } from "@/components/charts/ranked-bars";
import { TimeRangeNav } from "@/components/time-range-nav";
import {
  awaitsVerdict,
  VerdictBadge,
  VERDICT_COLOR,
  VERDICT_TODO_COLOR,
} from "@/components/verdict-badge";
import { TrendChart } from "@/components/charts/trend-chart";
import { VolumeChart } from "@/components/charts/volume-chart";
import { Button, Card, CardHeader, EmptyState, ResultBar, StatusBadge } from "@/components/ui";
import { DASHBOARD_DAY_OPTIONS, resolveDashboardDays } from "@/lib/dashboard-range";
import { passRateTone, TONE_COLOR } from "@/lib/health";
import {
  formatDuration,
  formatPercent,
  formatRelativeTime,
  shortSha,
  formatInteger,
} from "@/lib/format";
import { getServices } from "@/lib/services";
import { readViewerTimeZone, TIMEZONE_COOKIE } from "@/lib/timezone";
import { can, requirePageContext } from "@/lib/viewer";

/**
 * Organisation dashboard.
 *
 * Answers, in order: is anything broken right now, is it getting better or worse, and
 * what specifically should I look at. Headline numbers first, then trends, then named
 * tests — a dashboard that opens with a chart makes you do arithmetic before you know
 * whether to care.
 */
export const dynamic = "force-dynamic";

export default async function OrgDashboard({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{
    days?: string;
    volume?: string;
    rate?: string;
    failures?: string;
  }>;
}) {
  const { orgSlug } = await params;
  const {
    days: daysParam,
    volume: volumeParam,
    rate: rateParam,
    failures: failuresParam,
  } = await searchParams;
  const context = await requirePageContext(orgSlug);
  const { sql } = getServices();

  // Written by TimezoneSync in the shell. Absent on a first visit, which renders in UTC and
  // corrects itself the moment the cookie lands.
  const timeZone = readViewerTimeZone((await cookies()).get(TIMEZONE_COOKIE)?.value);

  // Snapped to the offered set so the URL and the highlighted button always agree.
  // Defaults to a week. The page is opened to answer "how are we doing right now",
  // and a 30-day window dilutes a bad Tuesday into a rounding error — the reader who
  // wants the longer view asks for it, and the URL then carries the choice.
  const days = resolveDashboardDays(daysParam);
  const orgId = context.org.id;

  // View selections. Each names a different question, not a different drawing — see
  // ChartToggle. Unknown values fall back to the default rather than erroring.
  const shareView = volumeParam === "share";
  const branchView = rateParam === "branch";
  /*
   * Two questions about the same failures, not two drawings of one.
   *
   * The derived view reads the error out of the report — mechanical, complete, available from
   * the first upload. The triaged view reads what a person concluded about the *cause*, which is
   * richer and covers only what has been reviewed. Neither subsumes the other, which is why this
   * is a toggle rather than one chart preferring triage where it exists: silently mixing a
   * mechanical category with a human one would put "Assertion" and "Product bug" in one list as
   * though they were alternatives.
   */
  const triagedFailures = failuresParam === "triage";

  const [
    summary,
    windowed,
    projects,
    recent,
    flaky,
    failing,
    slowest,
    concentration,
    flakeBands,
    failureGroups,
    failureSummaries,
    activity,
    runPoints,
  ] = await Promise.all([
    orgSummary(sql, { orgId }),
    // The headline tiles measure the selected window, not a fixed month — see
    // DashboardStatTiles. `orgSummary` is still read, for the present-state counts and the
    // project count in the subheading, neither of which is windowed.
    dashboardWindowSummary(sql, { orgId, days }),
    listProjects(sql, orgId),
    listRuns(sql, { orgId }, { limit: 6 }),
    flakyLeaderboard(sql, { orgId, limit: 6 }),
    topFailingTests(sql, { orgId, limit: 6 }),
    // Twenty, not six: these two lists scroll now, and the tail is the part that says
    // whether this is one bad test or something systemic.
    slowestTests(sql, { orgId, limit: 20 }),
    failureConcentration(sql, { orgId, limit: 20 }),
    flakeDistribution(sql, { orgId }),
    /*
     * Both windowed by the range control, unlike the two rollup-backed charts beside them.
     *
     * These read `test_results` directly because no per-signature or per-category aggregate
     * exists, so they are the only charts in the failure row that answer "in the selected
     * window" rather than "in the last 30 days". The footnotes say which, because a reader
     * comparing the three would otherwise assume they share a period.
     */
    // Only the selected view is queried: the other would be fetched, discarded, and paid for on
    // every dashboard load. Same reason `branchPassRates` is conditional.
    triagedFailures
      ? failureTriageBreakdown(sql, { orgId, days })
      : failureCategories(sql, { orgId, days }),
    // The errors themselves, readable because they were extracted at ingest rather than being
    // whatever the reporter happened to put in the message attribute.
    recentFailureSummaries(sql, { orgId, days, limit: 20 }),
    runActivity(sql, { orgId, days, timeZone: timeZone.zone }),
    runSeries(sql, { orgId, days, timeZone: timeZone.zone }),
  ]);

  /*
   * Batched after the queries above, which is where the run ids come from — and batched
   * across *both* consumers.
   *
   * The recent-runs list and the outcome chart's verdict ribbon want the same thing for
   * overlapping sets of runs. Two calls would issue two queries and fetch the last six runs'
   * verdicts twice; the union is deduplicated here and both read from one map.
   */
  const verdictRunIds = [
    ...new Set([...recent.runs.map((run) => run.id), ...runPoints.map((run) => run.id)]),
  ];
  const recentVerdicts = await latestRunVerdicts(sql, { orgId, runIds: verdictRunIds });

  // Only fetched for the view that needs it: the aggregate chart is the default, and
  // paying for a per-branch split on every dashboard load would be waste.
  const branchRates = branchView ? await branchPassRates(sql, { orgId, days, limit: 8 }) : [];

  /** Preserves the other selections when one toggle changes. */
  const viewHref = (changes: Record<string, string | null>): string => {
    const next = new URLSearchParams();
    if (daysParam) next.set("days", String(days));
    if (volumeParam) next.set("volume", volumeParam);
    if (rateParam) next.set("rate", rateParam);
    if (failuresParam) next.set("failures", failuresParam);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    const query = next.toString();
    return query ? `/o/${orgSlug}?${query}` : `/o/${orgSlug}`;
  };
  // Only the window, not the view toggles: `volume` and `rate` choose a drawing, and a CSV has
  // no drawing to choose. Carrying them would imply the data changed with the chart.
  const csvHref = `/o/${orgSlug}/export/dashboard/csv?days=${days}`;

  if (projects.length === 0) {
    return (
      <main className="mx-auto max-w-4xl px-6 py-10">
        <Card>
          <EmptyState
            title={`${context.org.name} has no projects yet`}
            description="A project groups test results from one codebase or suite. Create one, then upload a JUnit XML report from CI or the browser."
            action={
              can(context, "project:create") ? (
                <Button href={`/o/${orgSlug}/projects/new`} variant="primary">
                  Create a project
                </Button>
              ) : (
                <span className="text-xs text-[var(--color-ink-muted)]">
                  Ask an administrator to create one — your role is {context.org.role}.
                </span>
              )
            }
          />
        </Card>
      </main>
    );
  }

  /*
   * Narrowed once here rather than at each use. `Promise.all` gives back a union of the two
   * query shapes because the call is conditional, and asserting the shape at three call sites
   * inside JSX would be three chances to pick the wrong one.
   */
  const triageGroups = triagedFailures
    ? (failureGroups as Awaited<ReturnType<typeof failureTriageBreakdown>>)
    : [];
  const categoryGroups = triagedFailures
    ? []
    : (failureGroups as Awaited<ReturnType<typeof failureCategories>>);

  const hasHistory = runPoints.length > 0;
  // Newest first, so the head of the list the "Recent runs" card already fetched is also
  // the run the donut is about. No extra query.
  const lastRun = recent.runs[0] ?? null;

  return (
    <main className="mx-auto max-w-7xl px-6 py-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">{context.org.name}</h1>
          <p className="mt-0.5 text-xs text-[var(--color-ink-muted)]">
            {summary.projects} project{summary.projects === 1 ? "" : "s"} ·{" "}
            {summary.lastRunAt
              ? `last run ${formatRelativeTime(summary.lastRunAt)}`
              : "no runs yet"}
          </p>
        </div>
        {/* Through viewHref, so changing the range keeps the chart views. These links
            used to be built by hand and reset volume/rate/duration on every click. */}
        <div className="flex flex-wrap items-center gap-2">
          <TimeRangeNav
            options={DASHBOARD_DAY_OPTIONS.map((option) => ({
              days: option,
              href: viewHref({ days: String(option) }),
              active: days === option,
            }))}
          />
          <Button href={csvHref} download>
            Export CSV
          </Button>
        </div>
      </div>

      <DashboardStatTiles windowed={windowed} current={summary} days={days} className="mb-5" />

      {hasHistory ? (
        <>
          {/*
           * Two thirds to the window's outcomes, one third to its rhythm.
           *
           * They are the same days asked two different questions, which is why they lead the
           * page together: the stacked columns read along time and answer "how much, and how
           * much of it was red"; the heatmap folds those same days into weeks and answers
           * "when does this actually run". The split is not cosmetic — the columns carry one
           * mark per day over a 90-day window and need the width, while the heatmap is a
           * fixed 7×N lattice that gains nothing from it.
           */}
          <div className="mb-5 grid gap-5 lg:grid-cols-3">
            <Card className="p-4 lg:col-span-2">
              <VolumeChart
                title="Execution over time"
                shape="area"
                mode={shareView ? "share" : "counts"}
                /*
                 * One point per run, not per day.
                 *
                 * A daily rollup averages the executions inside it, so a single run at 40%
                 * beside four at 100% reads as a mildly bad day and the bad run disappears.
                 * The window still bounds the axis; what changed is that the axis is now
                 * executions in time order rather than calendar buckets.
                 */
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

            {/* `flex flex-col` on the card is what gives the figure a height to fill: a
                stretched grid item is only as tall as its row, and `h-full` inside it
                resolves to nothing unless the card itself is a flex container. */}
            <Card className="flex flex-col p-4">
              <ActivityHeatmap
                title="When"
                buckets={activity}
                days={days}
                unit="run"
                timeZoneLabel={timeZone.label}
                action={
                  <span className="text-[11px] text-[var(--color-ink-muted)]">
                    last {days} days
                  </span>
                }
              />
            </Card>
          </div>

          {/* Four across at 2xl, two at lg. The donut sits beside the pass-rate trend
              because the pair answers "how are we doing" and "how did the last one go" —
              the two questions people arrive with, in that order. */}
          <div className="mb-5 grid gap-5 lg:grid-cols-2 2xl:grid-cols-3">
            <Card className="p-4">
              {branchView ? (
                <RankedBars
                  title="Pass rate by branch"
                  domainMax={100}
                  /* Three branches answer the question — main, and whichever two are worst.
                     The rest stay reachable by scrolling rather than making this card three
                     times the height of the two beside it. */
                  maxVisible={3}
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
                  points={runPoints.map((run) => ({
                    label: run.label,
                    value: run.passRate,
                    detail: [run.name ?? run.status, run.branch].filter(Boolean).join(" · "),
                  }))}
                  unit="%"
                  yMax={100}
                  color="var(--color-series-1)"
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
              {/*
               * The most recent run, not an aggregate of the window.
               *
               * `recent.runs` is ordered newest first and is not restricted to today, which
               * matters on a Monday morning: a card reading "no runs" because nothing has
               * started yet is worse than one showing Friday's last run. The hint states how
               * many have run today so the two are never confused.
               */}
              {lastRun ? (
                <OutcomeDonut
                  title="Last run"
                  passed={lastRun.passed}
                  failed={lastRun.failed + lastRun.errored}
                  skipped={lastRun.skipped}
                  flaky={lastRun.flaky}
                  action={
                    <Link
                      href={`/o/${orgSlug}/runs/${lastRun.id}`}
                      className="text-[11px] text-[var(--color-ink-muted)] underline hover:text-[var(--color-ink)]"
                    >
                      {summary.runsToday} today
                    </Link>
                  }
                  footnote={`${lastRun.name ?? lastRun.framework ?? "Run"} · ${lastRun.projectKey} · ${formatRelativeTime(lastRun.startedAt)}`}
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
              {/* Separate chart, never a second axis on the pass-rate plot: aligning two
                scales would imply a relationship the data does not contain. */}
              <TrendChart
                title="CI time per run"
                points={runPoints.map((run) => ({
                  label: run.label,
                  value: run.durationMs,
                  detail: [run.name ?? run.status, run.branch].filter(Boolean).join(" · "),
                }))}
                color="var(--color-series-2)"
                format="duration"
                shape="bars-line"
              />
            </Card>
          </div>

          {/*
           * The failure row: three views of the same failures, coarse to fine.
           *
           * "Which tests" (concentration), "how many distinct problems" (signature) and "whose
           * problem" (category). They belong adjacent because triage reads them in that order —
           * a long flat concentration list plus two signatures means one bug hitting forty
           * tests, and the category says whether to hand it to a developer or to whoever owns
           * the environment. Split apart, each answers a third of the question.
           */}
          {/*
           * One row, three views of the same window's health: which tests fail, what kind of
           * failure, and how unstable the suite is overall. They are read left to right — a
           * long flat concentration list beside a category of mostly Auth says one environment
           * problem hitting many tests, which neither chart states on its own.
           */}
          <div className="mb-5 grid gap-5 lg:grid-cols-3">
            <Card className="p-4">
              <RankedBars
                title="Failure concentration"
                maxVisible={5}
                color="var(--color-status-failed)"
                bars={concentration.tests.map((test) => ({
                  label: test.name,
                  scope: test.projectKey,
                  value: test.failures30d,
                  display: `${test.failures30d} · ${Math.round(test.share)}%`,
                  href: `/o/${orgSlug}/tests/${test.id}`,
                }))}
                emptyMessage="No failures in the retained history."
                footnote={
                  concentration.totalFailures > 0
                    ? `${concentration.failingTests} test${concentration.failingTests === 1 ? "" : "s"} produced ${formatInteger(concentration.totalFailures)} failures over 30 days. A short bar list means one bad test; a long flat one means something systemic.`
                    : undefined
                }
              />
            </Card>
            <Card className="p-4">
              <RankedBars
                title={triagedFailures ? "Failures by triage" : "Failures by category"}
                /*
                 * No `maxVisible`, unlike the rankings beside it — and that is the difference
                 * between the two kinds of row-based tile here.
                 *
                 * `Failure concentration` and `Slowest tests` rank an unbounded population, so
                 * the first five answer the question and the tail is a scroll away. This is a
                 * bounded taxonomy: at most nine rows, and the *whole set* is the information —
                 * "80 timeouts" only means something beside the other categories it is being
                 * compared against. Capping it at five hid three categories behind a scrollbar
                 * that, on macOS, is invisible until you scroll. `Flake score distribution` is
                 * the precedent: same shape, also uncapped.
                 */
                color="var(--color-status-failed)"
                /*
                 * One flat hue rather than a colour per category, deliberately. Eight categories
                 * cannot be coloured from three validated categorical tokens, and bar length
                 * already carries the magnitude — so the colour would be decoration competing
                 * with the encoding. Every row is direct-labelled, which is also what keeps this
                 * readable without colour at all.
                 */
                bars={
                  triagedFailures
                    ? triageGroups.map((group) => ({
                        label:
                          group.category === "untriaged"
                            ? "Not yet triaged"
                            : (FAILURE_TRIAGE_LABELS[group.category as FailureTriage] ??
                              group.category),
                        scope: `${group.signatures} cause${group.signatures === 1 ? "" : "s"}`,
                        value: group.failures,
                        display: formatInteger(group.failures),
                      }))
                    : categoryGroups.map((group) => ({
                        label:
                          group.category === "unclassified"
                            ? UNCLASSIFIED_FAILURE_LABEL
                            : (FAILURE_CATEGORY_LABELS[group.category] ?? group.category),
                        scope: `${group.signatures} signature${group.signatures === 1 ? "" : "s"} · ${group.tests} test${group.tests === 1 ? "" : "s"}`,
                        value: group.failures,
                        display: formatInteger(group.failures),
                      }))
                }
                emptyMessage="No failures in this period."
                footnote={
                  triagedFailures
                    ? "What a person concluded about each failure cause, inherited by every later occurrence. “Not yet triaged” is shown rather than omitted, so the chart cannot be mistaken for a complete account of the failures."
                    : "Read at ingest from whichever field the report carried the error in — the class, the message, or the failure body — so every failure is categorised, not only the reviewed ones. “No error reported” means the report named the test but not the failure; “Unclassified” means the row predates extraction and a backfill will clear it."
                }
                action={
                  <ChartToggle
                    label="Failure category view"
                    options={[
                      {
                        label: "from report",
                        href: viewHref({ failures: null }),
                        active: !triagedFailures,
                      },
                      {
                        label: "triaged",
                        href: viewHref({ failures: "triage" }),
                        active: triagedFailures,
                      },
                    ]}
                  />
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

          <div className="mb-5">
            <Card className="p-4">
              <RankedBars
                title="Top failures"
                maxVisible={5}
                color="var(--color-status-failed)"
                /*
                 * Grouped on the extracted summary — a sentence somebody wrote — rather than on
                 * the failure signature, which is a sha256 and made an unreadable label. This is
                 * the tile the signature one was trying to be.
                 *
                 * Full width because these are error messages, and a third of a row truncates
                 * them to the shared prefix, which is the part that does not tell them apart.
                 */
                bars={failureSummaries.map((row) => ({
                  label: row.summary,
                  scope: [
                    row.failureClass || null,
                    row.projectKey,
                    `${row.tests} test${row.tests === 1 ? "" : "s"}`,
                  ]
                    .filter(Boolean)
                    .join(" · "),
                  value: row.failures,
                  display: formatInteger(row.failures),
                  href: `/o/${orgSlug}/tests/${row.sampleTestCaseId}`,
                }))}
                emptyMessage="No failures in this period."
                footnote="The error itself, read from whichever field the report put it in — the class, the message, or the failure body. Grouped by message, so one root cause hitting forty tests is one row."
              />
            </Card>
          </div>

          {/*
           * Slowest tests takes the full width on its own, because its labels need it.
           * These names are full scenario titles — "SearchNReco Extension - Zone Serviceability
           * › Test all Product pages for zone serviceability…" — and at a third of the row they
           * truncate to the shared prefix, which is the one part that does not tell them apart.
           */}
          <div className="mb-5">
            <Card className="p-4">
              <RankedBars
                title="Slowest tests (p95)"
                maxVisible={5}
                /*
                 * The project captions each name. The suite path used to sit here instead and
                 * was removed, because it answered a question nobody asks of a ranking — you
                 * are looking for *which test*, and the path is one click away on the test's
                 * own page.
                 *
                 * The project is not that. This list spans every project in the organisation,
                 * so without it a row names a test the reader cannot place, and two projects
                 * with a similarly-named test are indistinguishable — `orders-api` and
                 * `checkout-web` both have a `test_case_7`. That is worth the second line the
                 * suite path was not.
                 */
                bars={slowest.map((test) => ({
                  label: test.name,
                  scope: test.projectKey,
                  value: test.p95DurationMs,
                  display: formatDuration(test.p95DurationMs),
                  href: `/o/${orgSlug}/tests/${test.id}`,
                }))}
                emptyMessage="No duration data yet."
                footnote="p95, not average — a test that is usually fast and occasionally slow is the one worth finding."
              />
            </Card>
          </div>
        </>
      ) : (
        <Card className="mb-5">
          <EmptyState
            title="No results in this period"
            description="Upload a report to start building history. Trends and flakiness need a few runs before they say anything useful."
            action={
              can(context, "run:upload") ? (
                <Button href={`/o/${orgSlug}/projects`} variant="primary">
                  Choose a project to upload to
                </Button>
              ) : undefined
            }
          />
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="overflow-hidden">
          <CardHeader
            title="Flakiest tests"
            action={
              <Link href={`/o/${orgSlug}/flaky`} className="text-[11px] underline">
                view all
              </Link>
            }
          />
          {flaky.length === 0 ? (
            <p className="px-5 py-6 text-center text-xs text-[var(--color-ink-muted)]">
              No flaky tests detected. A test counts as flaky when it passes on retry or flips
              outcome between runs — a consistently failing test is not flaky.
            </p>
          ) : (
            <ul className="divide-y divide-[var(--color-border-subtle)]">
              {flaky.map((test) => (
                <li key={test.id} className="flex items-center gap-3 px-5 py-2.5">
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/o/${orgSlug}/tests/${test.id}`}
                      className="block truncate text-xs font-medium hover:underline"
                    >
                      {test.name}
                    </Link>
                    <div className="truncate font-mono text-[10px] text-[var(--color-ink-muted)]">
                      {test.projectKey}
                      {test.suite ? ` · ${test.suite}` : ""}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="font-mono text-xs text-[var(--color-status-flaky)] tabular-nums">
                      {Number(test.flakeScore).toFixed(0)}
                    </div>
                    <div className="font-mono text-[10px] text-[var(--color-ink-muted)]">
                      {test.failures30d}/{test.runs30d} failed
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="overflow-hidden">
          <CardHeader
            title="Most-failing tests"
            action={
              <Link
                href={`/o/${orgSlug}/tests?status=failing&sort=most-failed`}
                className="text-[11px] underline"
              >
                view all
              </Link>
            }
          />
          {failing.length === 0 ? (
            <p className="px-5 py-6 text-center text-xs text-[var(--color-ink-muted)]">
              Nothing has failed in the last 30 days.
            </p>
          ) : (
            <ul className="divide-y divide-[var(--color-border-subtle)]">
              {failing.map((test) => (
                <li key={test.id} className="flex items-center gap-3 px-5 py-2.5">
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/o/${orgSlug}/tests/${test.id}`}
                      className="block truncate text-xs font-medium hover:underline"
                    >
                      {test.name}
                    </Link>
                    <div className="truncate font-mono text-[10px] text-[var(--color-ink-muted)]">
                      {test.projectKey}
                      {test.suite ? ` · ${test.suite}` : ""}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="font-mono text-xs text-[var(--color-status-failed)] tabular-nums">
                      {test.failures30d}
                    </div>
                    <div className="font-mono text-[10px] text-[var(--color-ink-muted)]">
                      {formatPercent(test.failRate30d)} of {test.runs30d}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card className="mt-5 overflow-hidden">
        <CardHeader
          title="Recent runs"
          action={
            <Link href={`/o/${orgSlug}/runs`} className="text-[11px] underline">
              view all
            </Link>
          }
        />
        {recent.runs.length === 0 ? (
          <p className="px-5 py-6 text-center text-xs text-[var(--color-ink-muted)]">
            No runs yet.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--color-border-subtle)]">
            {recent.runs.map((run) => {
              const failingCount = run.failed + run.errored;
              return (
                <li key={run.id} className="flex items-center gap-4 px-5 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {/* No action control here on purpose: this is a glance widget whose
                          names are already truncated at 12px. Run actions live on the runs
                          list and the run's own page. */}
                      <Link
                        href={`/o/${orgSlug}/runs/${run.id}`}
                        className="truncate text-xs font-medium hover:underline"
                      >
                        {run.name ?? run.framework ?? "Run"}
                      </Link>
                      <StatusBadge status={run.status} />
                      {/* A badge is information, not a control — which is why it belongs on
                          this glance widget even though the action menu deliberately does
                          not. "Which of these still needs review?" is a glance question. */}
                      {awaitsVerdict(run.status) ? (
                        <VerdictBadge
                          verdict={recentVerdicts.get(run.id)?.verdict ?? null}
                          size="sm"
                        />
                      ) : null}
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-x-3 font-mono text-[10px] text-[var(--color-ink-muted)]">
                      <span>{run.projectKey}</span>
                      {run.branch ? <span>{run.branch}</span> : null}
                      {shortSha(run.commitSha) ? <span>{shortSha(run.commitSha)}</span> : null}
                      <span>{formatRelativeTime(run.startedAt)}</span>
                    </div>
                  </div>
                  <div className="w-28 shrink-0">
                    <div className="text-right font-mono text-[11px] tabular-nums">
                      {formatPercent(run.passRate)}
                    </div>
                    <div className="mt-1">
                      <ResultBar
                        passed={run.passed}
                        failed={failingCount}
                        skipped={run.skipped}
                        flaky={run.flaky}
                        total={run.total}
                      />
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </main>
  );
}

/**
 * A run's verdict as a ribbon cell.
 *
 * `null` is not "no verdict exists in the data" — it is the TODO state, which is a real
 * thing to show: an unreviewed run is an open item. It is drawn in the same blue the badge
 * uses so the strip and the badges on the runs list cannot be read as different states.
 */
function ribbonFor(verdict: string | null): { color: string; label: string } {
  if (verdict === null) return { color: VERDICT_TODO_COLOR, label: "verdict TODO" };
  const known = verdict in RUN_VERDICT_LABELS ? (verdict as RunVerdict) : null;
  return known
    ? { color: VERDICT_COLOR[known], label: `verdict ${RUN_VERDICT_LABELS[known]}` }
    : { color: "var(--color-border-subtle)", label: `verdict ${verdict}` };
}
