import Link from "next/link";
import { notFound } from "next/navigation";
import { getRun, getRunResult, listRunResults, summarizeRunSuites } from "@testcenter/db";
import { Card, CardHeader, EmptyState, ResultBar, StatTile, StatusBadge } from "@/components/ui";
import { RunProgress } from "@/components/run-progress";
import { TagEditor } from "@/components/tag-editor";
import {
  formatAbsoluteTime,
  formatDuration,
  formatPercent,
  formatRelativeTime,
  shortSha,
  truncateStart,
} from "@/lib/format";
import { getServices } from "@/lib/services";
import { currentOrgId } from "@/lib/session";

/**
 * Run detail.
 *
 * Ordered by what someone opening a red run needs, in order: is it broken, what
 * broke, and why. Failures sort first from SQL so the answer is on screen without
 * scrolling, and the expensive fields (stack trace, captured output) load only for
 * the one result actually opened.
 */
export const dynamic = "force-dynamic";

interface SearchParams {
  status?: string;
  suite?: string;
  search?: string;
  flaky?: string;
  result?: string;
  limit?: string;
}

export default async function RunPage({
  params,
  searchParams,
}: {
  params: Promise<{ runId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { runId } = await params;
  const query = await searchParams;
  const orgId = await currentOrgId();
  if (!orgId) notFound();

  const { sql } = getServices();
  const run = await getRun(sql, { orgId, runId });
  if (!run) notFound();

  const limit = Math.min(Math.max(Number(query.limit ?? 200), 25), 500);
  const [resultPage, suites, selected] = await Promise.all([
    listRunResults(
      sql,
      {
        runId,
        status: query.status ? query.status.split(",") : undefined,
        suite: query.suite,
        search: query.search,
        onlyFlaky: query.flaky === "true",
      },
      { limit },
    ),
    summarizeRunSuites(sql, runId),
    query.result ? getRunResult(sql, { runId, resultId: Number(query.result) }) : null,
  ]);

  const failing = run.failed + run.errored;
  const base = `/runs/${runId}`;

  const withParam = (changes: Record<string, string | null>): string => {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (typeof value === "string" && value) next.set(key, value);
    }
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    // Opening a different filter should not keep a stale result panel open.
    if (!("result" in changes)) next.delete("result");
    const search = next.toString();
    return search ? `${base}?${search}` : base;
  };

  return (
    <main className="mx-auto max-w-7xl px-6 py-8">
      <nav className="mb-4 flex items-center gap-2 text-xs text-[var(--color-ink-muted)]">
        <Link href="/runs" className="hover:text-[var(--color-ink)] hover:underline">
          Runs
        </Link>
        <span>/</span>
        <Link
          href={`/runs?project=${run.projectKey}`}
          className="hover:text-[var(--color-ink)] hover:underline"
        >
          {run.projectKey}
        </Link>
      </nav>

      <header className="mb-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">
            {run.name ?? run.framework ?? "Run"}
          </h1>
          <StatusBadge status={run.status} />
          {run.shardTotal ? (
            <span className="font-mono text-[11px] text-[var(--color-ink-muted)]">
              shard {(run.shardIndex ?? 0) + 1}/{run.shardTotal}
            </span>
          ) : null}
          {run.attempt > 1 ? (
            <span className="font-mono text-[11px] text-[var(--color-ink-muted)]">
              attempt {run.attempt}
            </span>
          ) : null}
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-[var(--color-ink-muted)]">
          {run.branch ? <span>branch {run.branch}</span> : null}
          {shortSha(run.commitSha) ? <span>commit {shortSha(run.commitSha)}</span> : null}
          {run.prNumber ? <span>PR #{run.prNumber}</span> : null}
          {run.environment ? <span>env {run.environment}</span> : null}
          {run.framework ? <span>{run.framework}</span> : null}
          <span title={formatAbsoluteTime(run.startedAt)}>
            started {formatRelativeTime(run.startedAt)}
          </span>
          {run.ciJobUrl ? (
            <a
              href={run.ciJobUrl}
              className="underline hover:text-[var(--color-ink)]"
              target="_blank"
              rel="noreferrer"
            >
              CI job
            </a>
          ) : null}
        </div>

        <div className="mt-3">
          <TagEditor runId={runId} initialTags={run.tags} />
        </div>
      </header>

      {/* Live progress replaces itself with the real numbers once parsing finishes. */}
      {run.status === "pending" || run.status === "parsing" ? (
        <div className="mb-6">
          <RunProgress runId={runId} />
        </div>
      ) : null}

      {run.warnings.length > 0 ? (
        <Card className="mb-6 border-[var(--color-status-flaky)]/40">
          <CardHeader title="Import warnings" />
          <ul className="space-y-1.5 px-5 py-3">
            {run.warnings.map((warning, index) => (
              <li key={`${warning.code}-${index}`} className="text-xs leading-relaxed">
                <span className="font-mono text-[var(--color-status-flaky)]">{warning.code}</span>
                <span className="text-[var(--color-ink-muted)]"> — {warning.message}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card className="mb-6">
        <div className="grid grid-cols-2 divide-x divide-y divide-[var(--color-border-subtle)] sm:grid-cols-3 lg:grid-cols-6 lg:divide-y-0">
          <StatTile
            label="Pass rate"
            value={formatPercent(run.passRate)}
            tone={failing > 0 ? "failed" : "passed"}
          />
          <StatTile label="Tests" value={run.total} />
          <StatTile label="Failed" value={failing} tone={failing > 0 ? "failed" : "neutral"} />
          <StatTile label="Flaky" value={run.flaky} tone={run.flaky > 0 ? "flaky" : "neutral"} />
          <StatTile label="Skipped" value={run.skipped} tone="skipped" />
          <StatTile label="Duration" value={formatDuration(run.durationMs)} />
        </div>
        <div className="px-4 pb-4">
          <ResultBar
            passed={run.passed}
            failed={failing}
            skipped={run.skipped}
            flaky={run.flaky}
            total={run.total}
          />
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
        <aside className="space-y-4">
          <Card>
            <div className="border-b border-[var(--color-border-subtle)] px-4 py-2.5">
              <h2 className="text-xs font-medium tracking-wide uppercase">Filter</h2>
            </div>
            <ul className="p-2 text-xs">
              {[
                {
                  label: "All results",
                  href: withParam({ status: null, flaky: null }),
                  active: !query.status && query.flaky !== "true",
                },
                {
                  label: `Failed (${failing})`,
                  href: withParam({ status: "failed,error", flaky: null }),
                  active: query.status === "failed,error",
                },
                {
                  label: `Flaky (${run.flaky})`,
                  href: withParam({ flaky: "true", status: null }),
                  active: query.flaky === "true",
                },
                {
                  label: `Skipped (${run.skipped})`,
                  href: withParam({ status: "skipped", flaky: null }),
                  active: query.status === "skipped",
                },
                {
                  label: `Passed (${run.passed})`,
                  href: withParam({ status: "passed", flaky: null }),
                  active: query.status === "passed",
                },
              ].map((entry) => (
                <li key={entry.label}>
                  <Link
                    href={entry.href}
                    className={`block rounded px-2 py-1.5 hover:bg-[var(--color-surface)] ${
                      entry.active ? "bg-[var(--color-surface)] font-semibold" : ""
                    }`}
                  >
                    {entry.label}
                  </Link>
                </li>
              ))}
            </ul>
          </Card>

          {suites.length > 0 ? (
            <Card>
              <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-4 py-2.5">
                <h2 className="text-xs font-medium tracking-wide uppercase">Suites</h2>
                {query.suite ? (
                  <Link
                    href={withParam({ suite: null })}
                    className="text-[11px] text-[var(--color-ink-muted)] underline"
                  >
                    clear
                  </Link>
                ) : null}
              </div>
              <ul className="max-h-96 overflow-y-auto p-2">
                {suites.map((suite) => (
                  <li key={suite.suite ?? "(none)"}>
                    <Link
                      href={withParam({ suite: suite.suite ?? null })}
                      className={`block rounded px-2 py-1.5 hover:bg-[var(--color-surface)] ${
                        query.suite === suite.suite ? "bg-[var(--color-surface)]" : ""
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-mono text-[11px]" title={suite.suite ?? ""}>
                          {truncateStart(suite.suite ?? "(no suite)", 28)}
                        </span>
                        <span
                          className={`shrink-0 font-mono text-[11px] tabular-nums ${
                            suite.failed > 0
                              ? "text-[var(--color-status-failed)]"
                              : "text-[var(--color-ink-muted)]"
                          }`}
                        >
                          {suite.failed > 0 ? `${suite.failed}✕` : suite.total}
                        </span>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </aside>

        <div className="min-w-0 space-y-6">
          {selected ? (
            <Card>
              <CardHeader
                title={
                  <span className="flex items-center gap-2">
                    <StatusBadge status={selected.status} />
                    <span className="truncate">{selected.name}</span>
                  </span>
                }
                action={
                  <Link
                    href={withParam({ result: null })}
                    className="text-xs text-[var(--color-ink-muted)] hover:underline"
                  >
                    close
                  </Link>
                }
              />
              <div className="space-y-4 px-5 py-4">
                <dl className="grid grid-cols-2 gap-x-6 gap-y-2 font-mono text-[11px] sm:grid-cols-4">
                  <Detail label="suite" value={selected.suite ?? "—"} />
                  <Detail label="class" value={selected.classname ?? "—"} />
                  <Detail label="duration" value={formatDuration(selected.durationMs)} />
                  <Detail
                    label="attempts"
                    value={selected.retryCount > 0 ? `${selected.retryCount + 1}` : "1"}
                  />
                </dl>

                {selected.failureMessage ? (
                  <Block
                    title={selected.failureType ?? "Failure"}
                    body={selected.failureMessage}
                    tone="failed"
                  />
                ) : null}
                {selected.stackTrace ? (
                  <Block title="Stack trace" body={selected.stackTrace} />
                ) : null}
                {selected.message ? <Block title="Message" body={selected.message} /> : null}
                {selected.stdout ? <Block title="stdout" body={selected.stdout} /> : null}
                {selected.stderr ? <Block title="stderr" body={selected.stderr} /> : null}
                {!selected.failureMessage &&
                !selected.stackTrace &&
                !selected.stdout &&
                !selected.stderr ? (
                  <p className="text-xs text-[var(--color-ink-muted)]">
                    This test recorded no failure detail or captured output.
                  </p>
                ) : null}
              </div>
            </Card>
          ) : null}

          <Card className="overflow-hidden">
            <CardHeader
              title={`Results (${resultPage.results.length}${resultPage.nextCursor ? "+" : ""})`}
              action={
                <span className="text-[11px] text-[var(--color-ink-muted)]">failures first</span>
              }
            />
            {resultPage.results.length === 0 ? (
              <EmptyState
                title="No results match"
                description={
                  run.total === 0
                    ? "This run has no parsed results yet. If it is still parsing, the page will show progress above."
                    : "Try a different filter, or clear the suite selection."
                }
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-[var(--color-border-subtle)] text-[11px] tracking-wide text-[var(--color-ink-muted)] uppercase">
                    <tr>
                      <th className="px-4 py-2 font-medium">Status</th>
                      <th className="px-4 py-2 font-medium">Test</th>
                      <th className="px-4 py-2 font-medium">Suite</th>
                      <th className="px-4 py-2 text-right font-medium">Time</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--color-border-subtle)]">
                    {resultPage.results.map((result) => (
                      <tr
                        key={result.id}
                        className={`hover:bg-[var(--color-surface)]/60 ${
                          String(result.id) === query.result ? "bg-[var(--color-surface)]" : ""
                        }`}
                      >
                        <td className="px-4 py-2 align-top">
                          <div className="flex items-center gap-1.5">
                            <StatusBadge status={result.status} />
                            {result.wasFlaky ? (
                              <StatusBadge status="flaky">flaky</StatusBadge>
                            ) : null}
                          </div>
                        </td>
                        <td className="max-w-md px-4 py-2 align-top">
                          <Link
                            href={withParam({ result: String(result.id) })}
                            className="font-medium hover:underline"
                          >
                            {result.name}
                          </Link>
                          {result.failureMessage ? (
                            <div className="mt-0.5 truncate font-mono text-[11px] text-[var(--color-status-failed)]">
                              {result.failureMessage}
                            </div>
                          ) : null}
                          {result.classname ? (
                            <div className="mt-0.5 truncate font-mono text-[11px] text-[var(--color-ink-muted)]">
                              {result.classname}
                            </div>
                          ) : null}
                        </td>
                        <td className="max-w-[16rem] px-4 py-2 align-top">
                          <span
                            className="block truncate font-mono text-[11px] text-[var(--color-ink-muted)]"
                            title={result.suite ?? ""}
                          >
                            {truncateStart(result.suite ?? "—", 34)}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-right align-top font-mono text-[11px] text-[var(--color-ink-muted)] tabular-nums">
                          {formatDuration(result.durationMs)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {resultPage.nextCursor ? (
              <div className="border-t border-[var(--color-border-subtle)] px-5 py-3">
                <Link
                  href={withParam({ limit: String(Math.min(limit + 200, 500)) })}
                  className="text-xs underline"
                >
                  Show more results
                </Link>
              </div>
            ) : null}
          </Card>
        </div>
      </div>
    </main>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[var(--color-ink-muted)]">{label}</dt>
      <dd className="truncate" title={value}>
        {value}
      </dd>
    </div>
  );
}

function Block({
  title,
  body,
  tone = "neutral",
}: {
  title: string;
  body: string;
  tone?: "neutral" | "failed";
}) {
  return (
    <div>
      <div
        className={`mb-1 font-mono text-[11px] ${
          tone === "failed" ? "text-[var(--color-status-failed)]" : "text-[var(--color-ink-muted)]"
        }`}
      >
        {title}
      </div>
      <pre className="max-h-72 overflow-auto rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
        {body}
      </pre>
    </div>
  );
}
