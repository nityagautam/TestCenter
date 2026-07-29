import Link from "next/link";
import {
  dailySeries,
  flakyLeaderboard,
  listRuns,
  orgSummary,
  topFailingTests,
} from "@testcenter/db";
import { TrendChart } from "@/components/charts/trend-chart";
import { VolumeChart } from "@/components/charts/volume-chart";
import { CiSnippet } from "@/components/ci-snippet";
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
import { formatPercent, formatRelativeTime, formatInteger } from "@/lib/format";
import { getServices } from "@/lib/services";
import { can, requirePageContext, requirePageProject } from "@/lib/viewer";

/**
 * Project overview.
 *
 * Doubles as the onboarding screen: immediately after creation it shows the CI recipe
 * with a real token, because that is the one moment someone is ready to wire up their
 * pipeline. Afterwards it becomes the project's dashboard.
 */
export const dynamic = "force-dynamic";

export default async function ProjectOverview({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; projectKey: string }>;
  searchParams: Promise<{ created?: string; token?: string; days?: string }>;
}) {
  const { orgSlug, projectKey } = await params;
  const { created, token, days: daysParam } = await searchParams;
  const context = await requirePageContext(orgSlug);
  const project = await requirePageProject(context, projectKey);
  const { sql } = getServices();

  const days = Math.min(Math.max(Number(daysParam ?? 30), 7), 90);
  const scope = { orgId: context.org.id, projectId: project.id };

  const [summary, series, recent, flaky, failing] = await Promise.all([
    orgSummary(sql, scope),
    dailySeries(sql, { ...scope, days }),
    listRuns(sql, { orgId: context.org.id, projectId: project.id }, { limit: 8 }),
    flakyLeaderboard(sql, { ...scope, limit: 5 }),
    topFailingTests(sql, { ...scope, limit: 5 }),
  ]);

  const base = `/o/${orgSlug}/p/${projectKey}`;
  const hasRuns = summary.runs30d > 0 || recent.runs.length > 0;

  return (
    <main className="mx-auto max-w-7xl px-6 py-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">{project.name}</h1>
          <p className="mt-0.5 font-mono text-xs text-[var(--color-ink-muted)]">
            {project.key} · default branch {project.defaultBranch}
          </p>
        </div>
        <div className="flex gap-2">
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

          <div className="mb-5 grid gap-5 lg:grid-cols-3">
            <Card className="p-4">
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
              <TrendChart
                title="Average run duration"
                points={series.map((point) => ({
                  label: point.day,
                  value: point.avgDurationMs,
                }))}
                color="var(--color-series-2)"
                format="duration"
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
                        <Link
                          href={`/o/${orgSlug}/runs/${run.id}`}
                          className="truncate text-xs font-medium hover:underline"
                        >
                          {run.name ?? run.framework ?? "Run"}
                        </Link>
                        <StatusBadge status={run.status} />
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
                <CardHeader title="Flakiest tests" />
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
