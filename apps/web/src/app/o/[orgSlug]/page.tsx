import Link from "next/link";
import {
  dailySeries,
  flakyLeaderboard,
  listProjects,
  listRuns,
  orgSummary,
  topFailingTests,
} from "@testcenter/db";
import { TrendChart } from "@/components/charts/trend-chart";
import { VolumeChart } from "@/components/charts/volume-chart";
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  ResultBar,
  StatTile,
  StatusBadge,
} from "@/components/ui";
import { passRateTone } from "@/lib/health";
import { formatPercent, formatRelativeTime, shortSha } from "@/lib/format";
import { getServices } from "@/lib/services";
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
  searchParams: Promise<{ days?: string }>;
}) {
  const { orgSlug } = await params;
  const { days: daysParam } = await searchParams;
  const context = await requirePageContext(orgSlug);
  const { sql } = getServices();

  const days = Math.min(Math.max(Number(daysParam ?? 30), 7), 90);
  const orgId = context.org.id;

  const [summary, series, projects, recent, flaky, failing] = await Promise.all([
    orgSummary(sql, { orgId }),
    dailySeries(sql, { orgId, days }),
    listProjects(sql, orgId),
    listRuns(sql, { orgId }, { limit: 6 }),
    flakyLeaderboard(sql, { orgId, limit: 6 }),
    topFailingTests(sql, { orgId, limit: 6 }),
  ]);

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

  const hasHistory = series.some((point) => point.runs > 0);

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
        <nav className="flex gap-1" aria-label="Time range">
          {[7, 30, 90].map((option) => (
            <Link
              key={option}
              href={`/o/${orgSlug}?days=${option}`}
              className={`rounded-md border px-2 py-1 text-xs ${
                days === option
                  ? "border-[var(--color-ink-muted)] font-semibold"
                  : "border-[var(--color-border-subtle)] text-[var(--color-ink-muted)] hover:border-[var(--color-ink-muted)]"
              }`}
            >
              {option}d
            </Link>
          ))}
        </nav>
      </div>

      <Card className="mb-5">
        <div className="grid grid-cols-2 divide-x divide-y divide-[var(--color-border-subtle)] sm:grid-cols-3 lg:grid-cols-6 lg:divide-y-0">
          <StatTile
            label="Pass rate"
            value={formatPercent(summary.passRate30d)}
            tone={passRateTone(summary.passRate30d)}
            hint="last 30 days"
          />
          <StatTile label="Runs" value={summary.runs30d} hint={`${summary.runsToday} today`} />
          <StatTile label="Tests" value={summary.tests30d.toLocaleString()} />
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
          <StatTile
            label="Quarantined"
            value={summary.quarantined}
            tone="skipped"
            hint="excluded from gates"
          />
        </div>
      </Card>

      {hasHistory ? (
        <div className="mb-5 grid gap-5 lg:grid-cols-3">
          <Card className="p-4">
            <TrendChart
              title="Pass rate"
              points={series.map((point) => ({
                label: point.day,
                value: point.passRate,
                detail: point.runs > 0 ? `${point.runs} run(s), ${point.tests} tests` : undefined,
              }))}
              unit="%"
              yMax={100}
              color="var(--color-series-1)"
              format="percent"
            />
          </Card>
          <Card className="p-4">
            <VolumeChart
              title="Tests by outcome"
              days={series.map((point) => ({
                label: point.day,
                passed: point.passed,
                failed: point.failed,
                skipped: point.skipped,
                flaky: point.flaky,
                runs: point.runs,
              }))}
            />
          </Card>
          <Card className="p-4">
            {/* Separate chart, never a second axis on the pass-rate plot: aligning two
                scales would imply a relationship the data does not contain. */}
            <TrendChart
              title="Average run duration"
              points={series.map((point) => ({
                label: point.day,
                value: point.avgDurationMs,
                detail: point.runs > 0 ? `${point.runs} run(s)` : undefined,
              }))}
              color="var(--color-series-2)"
              format="duration"
            />
          </Card>
        </div>
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
                      <Link
                        href={`/o/${orgSlug}/runs/${run.id}`}
                        className="truncate text-xs font-medium hover:underline"
                      >
                        {run.name ?? run.framework ?? "Run"}
                      </Link>
                      <StatusBadge status={run.status} />
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
