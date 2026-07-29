import Link from "next/link";
import { listProjects, listRuns } from "@testcenter/db";
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  ResultBar,
  StatTile,
  StatusBadge,
  TagChip,
} from "@/components/ui";
import { formatDuration, formatPercent, formatRelativeTime, shortSha } from "@/lib/format";
import { getServices } from "@/lib/services";
import { currentOrgId } from "@/lib/session";

/**
 * Overview.
 *
 * Answers the question someone opens this app to ask: is anything broken right now,
 * and which project. Aggregate health first, then the most recent runs — deeper
 * analysis lives behind the run list.
 */
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const orgId = await currentOrgId();
  if (!orgId) {
    return (
      <main className="mx-auto max-w-5xl px-6 py-16">
        <EmptyState
          title="No organization provisioned"
          description="Run `pnpm db:migrate` to apply migrations, provision partitions and bootstrap the default organization and project."
        />
      </main>
    );
  }

  const { sql } = getServices();
  const [projects, recent] = await Promise.all([
    listProjects(sql, orgId),
    listRuns(sql, { orgId }, { limit: 8 }),
  ]);

  const runs = recent.runs;
  const totalTests = runs.reduce((sum, run) => sum + run.total, 0);
  const totalFailing = runs.reduce((sum, run) => sum + run.failed + run.errored, 0);
  const totalFlaky = runs.reduce((sum, run) => sum + run.flaky, 0);
  const executed = runs.reduce((sum, run) => sum + run.passed + run.failed + run.errored, 0);
  const passed = runs.reduce((sum, run) => sum + run.passed, 0);
  const passRate = executed === 0 ? 0 : Number(((passed / executed) * 100).toFixed(2));

  return (
    <main className="mx-auto max-w-7xl px-6 py-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Overview</h1>
          <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
            Health across the most recent runs
          </p>
        </div>
        <div className="flex gap-2">
          <Button href="/runs">All runs</Button>
          <Button href="/upload" variant="primary">
            Upload report
          </Button>
        </div>
      </div>

      {runs.length === 0 ? (
        <Card>
          <EmptyState
            title="No test results yet"
            description="Upload a JUnit XML report from the browser, or POST one to /api/v1/ingest from CI. Results appear here as soon as they finish parsing."
            action={
              <Button href="/upload" variant="primary">
                Upload your first report
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          <Card className="mb-6">
            <div className="grid grid-cols-2 divide-x divide-y divide-[var(--color-border-subtle)] sm:grid-cols-3 lg:grid-cols-5 lg:divide-y-0">
              <StatTile
                label="Pass rate"
                value={formatPercent(passRate)}
                tone={totalFailing > 0 ? "failed" : "passed"}
                hint="recent runs"
              />
              <StatTile label="Runs" value={runs.length} />
              <StatTile label="Tests" value={totalTests} />
              <StatTile
                label="Failing"
                value={totalFailing}
                tone={totalFailing > 0 ? "failed" : "neutral"}
              />
              <StatTile
                label="Flaky"
                value={totalFlaky}
                tone={totalFlaky > 0 ? "flaky" : "neutral"}
              />
            </div>
          </Card>

          <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
            <Card className="overflow-hidden">
              <CardHeader
                title="Recent runs"
                action={
                  <Link href="/runs" className="text-[11px] underline">
                    view all
                  </Link>
                }
              />
              <ul className="divide-y divide-[var(--color-border-subtle)]">
                {runs.map((run) => {
                  const failing = run.failed + run.errored;
                  return (
                    <li key={run.id} className="px-5 py-3 hover:bg-[var(--color-surface)]/60">
                      <div className="flex items-start gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <Link
                              href={`/runs/${run.id}`}
                              className="truncate text-sm font-medium hover:underline"
                            >
                              {run.name ?? run.framework ?? "Run"}
                            </Link>
                            <StatusBadge status={run.status} />
                            {run.flaky > 0 ? (
                              <StatusBadge status="flaky">{run.flaky}</StatusBadge>
                            ) : null}
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-x-3 font-mono text-[11px] text-[var(--color-ink-muted)]">
                            <span>{run.projectKey}</span>
                            {run.branch ? <span>{run.branch}</span> : null}
                            {shortSha(run.commitSha) ? (
                              <span>{shortSha(run.commitSha)}</span>
                            ) : null}
                            <span>{formatDuration(run.durationMs)}</span>
                            <span>{formatRelativeTime(run.startedAt)}</span>
                          </div>
                          {Object.keys(run.tags).length > 0 ? (
                            <div className="mt-1.5 flex flex-wrap gap-1">
                              {Object.entries(run.tags)
                                .slice(0, 4)
                                .map(([key, value]) => (
                                  <TagChip
                                    key={key}
                                    tagKey={key}
                                    value={value}
                                    href={`/runs?tag=${encodeURIComponent(`${key}:${value}`)}`}
                                  />
                                ))}
                            </div>
                          ) : null}
                        </div>
                        <div className="w-32 shrink-0">
                          <div className="text-right font-mono text-xs tabular-nums">
                            <span
                              className={
                                failing > 0
                                  ? "text-[var(--color-status-failed)]"
                                  : "text-[var(--color-status-passed)]"
                              }
                            >
                              {formatPercent(run.passRate)}
                            </span>
                          </div>
                          <div className="mt-1.5">
                            <ResultBar
                              passed={run.passed}
                              failed={failing}
                              skipped={run.skipped}
                              flaky={run.flaky}
                              total={run.total}
                            />
                          </div>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Card>

            <Card>
              <CardHeader title="Projects" />
              {projects.length === 0 ? (
                <p className="px-5 py-4 text-xs text-[var(--color-ink-muted)]">No projects yet.</p>
              ) : (
                <ul className="divide-y divide-[var(--color-border-subtle)]">
                  {projects.map((project) => (
                    <li key={project.id} className="px-5 py-3">
                      <Link
                        href={`/runs?project=${project.key}`}
                        className="text-sm font-medium hover:underline"
                      >
                        {project.name}
                      </Link>
                      <div className="mt-1 flex items-center justify-between font-mono text-[11px] text-[var(--color-ink-muted)]">
                        <span>{project.key}</span>
                        <span>
                          {project.lastRunAt ? formatRelativeTime(project.lastRunAt) : "no runs"}
                        </span>
                      </div>
                      {project.passRate7d !== null ? (
                        <div className="mt-1 font-mono text-[11px] text-[var(--color-ink-muted)]">
                          {project.runs7d} run{project.runs7d === 1 ? "" : "s"} · 7d avg{" "}
                          {formatPercent(project.passRate7d)}
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </>
      )}
    </main>
  );
}
