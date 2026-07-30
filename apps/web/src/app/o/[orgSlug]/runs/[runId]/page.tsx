import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getRun,
  getRunResult,
  listRunResults,
  recentOutcomes,
  summarizeRunSuites,
} from "@testcenter/db";
import { Card, CardHeader, EmptyState, ResultBar, StatTile, StatusBadge } from "@/components/ui";
import { OutcomeStrip } from "@/components/charts/outcome-strip";
import { RunActions } from "@/components/run-actions";
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
import { can, requirePageContext } from "@/lib/viewer";

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
  params: Promise<{ orgSlug: string; runId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { orgSlug, runId } = await params;
  const query = await searchParams;
  const context = await requirePageContext(orgSlug);
  const orgId = context.org.id;

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

  /*
   * Prior outcomes for the tests on screen, so each row can show how this test has been
   * behaving rather than only how it did here. One batched query keyed by test; it runs
   * after the list because it needs those ids. `limit` reaches 500, hence 6 marks per
   * row rather than the list view's 8 — the query is index-backed either way, but there
   * is no reason to fetch more marks than a dense table can show.
   */
  const outcomes = await recentOutcomes(sql, {
    orgId,
    testCaseIds: resultPage.results.map((result) => result.testCaseId),
    perTest: 6,
  });

  const failing = run.failed + run.errored;
  const base = `/o/${orgSlug}/runs/${runId}`;

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
        <Link href={`/o/${orgSlug}/runs`} className="hover:text-[var(--color-ink)] hover:underline">
          Runs
        </Link>
        <span>/</span>
        {/* The project-scoped path, not `?project=` on the org list: the crumb should put
            you inside the project, with the header dropdown and project nav agreeing. */}
        <Link
          href={`/o/${orgSlug}/p/${run.projectKey}/runs`}
          className="hover:text-[var(--color-ink)] hover:underline"
        >
          {run.projectKey}
        </Link>
      </nav>

      <header className="mb-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="min-w-0 truncate text-xl font-semibold tracking-tight">
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

          {/* ml-auto so the trigger sits at the far edge of the title row regardless of
              how many badges precede it. Renders nothing when the viewer can do neither. */}
          <div className="ml-auto">
            <RunActions
              runId={runId}
              orgSlug={orgSlug}
              name={run.name}
              fallback={run.framework ?? "Run"}
              totalTests={run.total}
              canRename={can(context, "run:rename")}
              canDelete={can(context, "run:delete")}
              deleteRedirectTo={`/o/${orgSlug}/p/${run.projectKey}/runs`}
            />
          </div>
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

        {/* Tags keep their own visible editor rather than moving into the ⋯ menu: it is
            already discoverable, members can use it where the menu's actions are
            admin-only, and the chips have to be on screen to be worth editing. */}
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

      {/* Filters on the right, matching the runs list and test search. This page was the
          only one with them on the left, so the sidebar jumped sides as you navigated
          between a list and a run.

          minmax(0,1fr) rather than 1fr for the content track: `1fr` means
          minmax(auto,1fr) and `auto` bottoms out at min-content, so one unbroken
          stack-trace line or 151-character test name would widen the track and squeeze
          the sidebar. Same reason it is spelled this way on the other two pages.

          The content also comes first in the DOM, not just visually — reversing them with
          `order` would leave a keyboard user tabbing into the filters before the results
          they sit beside. */}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="min-w-0 space-y-6">
          {selected ? (
            <Card>
              <CardHeader
                title={
                  // min-w-0 again on this inner flex, and shrink-0 on the badge: without
                  // both, the name's min-content width propagates straight back up and
                  // CardHeader's bound is undone one level down.
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="shrink-0">
                      <StatusBadge status={selected.status} />
                    </span>
                    <span className="min-w-0 truncate" title={selected.name}>
                      {selected.name}
                    </span>
                  </span>
                }
                action={
                  <span className="flex items-center gap-3 text-xs">
                    {/* The panel has room for a real labelled control, which the table row
                        did not — so the one place history is spelled out in words is the
                        one place a word fits. */}
                    <Link
                      href={`/o/${orgSlug}/tests/${selected.testCaseId}`}
                      className="font-medium underline hover:no-underline"
                    >
                      Full history →
                    </Link>
                    <Link
                      href={withParam({ result: null })}
                      className="text-[var(--color-ink-muted)] hover:underline"
                    >
                      close
                    </Link>
                  </span>
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
                {/* table-fixed with proportioned columns. Auto layout sizes columns to
                    their content, so one 200-character test name or stack-trace line decided
                    the whole table's geometry — and a max-width on a <td> is ignored outright.
                    Capping the children fixed the truncation but not the width: an absolute
                    maximum cannot know how much room the sidebar left, so the last columns were
                    pushed past the right edge. Fixed layout settles both, because every column
                    then has a definite width for `truncate` to resolve against. */}
                <table className="w-full table-fixed text-left text-xs">
                  <thead className="tc-sticky border-b border-[var(--color-border-subtle)] text-[11px] tracking-wide text-[var(--color-ink-muted)] uppercase">
                    <tr>
                      <th className="w-[7rem] px-4 py-2 font-medium">Status</th>
                      <th className="px-4 py-2 font-medium">Test</th>
                      {/* Was a 10px "history" word crammed beside every test name. As a
                          labelled column it is named once, carries the trend, and gives
                          the link a full-height hit target instead of a 7px one.
                          7.5rem: six 12px marks + five 2px gaps = 82px, and px-4 spends
                          32px of the cell — 7rem would leave 80px and clip the strip. */}
                      <th className="w-[7.5rem] px-4 py-2 font-medium">Recent</th>
                      <th className="w-[24%] px-4 py-2 font-medium">Suite</th>
                      <th className="w-[5.5rem] px-4 py-2 text-right font-medium">Time</th>
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
                        <td className="px-4 py-2 align-top">
                          {/* Bound on the child, not the cell — see the note in tests/page.tsx.
                              The name is now the only link here; history moved to its own
                              column, so a long name has no second link to collide with. */}
                          <Link
                            href={withParam({ result: String(result.id) })}
                            className="block truncate font-medium hover:underline"
                            title={result.name}
                          >
                            {result.name}
                          </Link>
                          {result.failureMessage ? (
                            <div
                              className="mt-0.5 truncate font-mono text-[11px] text-[var(--color-status-failed)]"
                              title={result.failureMessage}
                            >
                              {result.failureMessage}
                            </div>
                          ) : null}
                          {result.classname ? (
                            <div className="mt-0.5 truncate font-mono text-[11px] text-[var(--color-ink-muted)]">
                              {result.classname}
                            </div>
                          ) : null}
                        </td>
                        <td className="px-4 py-2 align-top">
                          <OutcomeStrip
                            cells={outcomes.get(result.testCaseId) ?? []}
                            href={`/o/${orgSlug}/tests/${result.testCaseId}`}
                            testName={result.name}
                          />
                        </td>
                        <td className="px-4 py-2 align-top">
                          <span
                            className="block truncate font-mono text-[11px] text-[var(--color-ink-muted)]"
                            title={result.suite ?? ""}
                          >
                            {truncateStart(result.suite ?? "—", 34)}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-right align-top font-mono text-[11px] whitespace-nowrap text-[var(--color-ink-muted)] tabular-nums">
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

        <aside className="space-y-4">
          <Card>
            {/* Same header shape as Suites and the runs-list facets: the way out of a
                filter sits in the card that applied it, and appears only once there is
                something to clear. */}
            <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-4 py-2.5">
              <h2 className="text-xs font-medium tracking-wide uppercase">Filter</h2>
              {query.status || query.flaky === "true" ? (
                <Link
                  href={withParam({ status: null, flaky: null })}
                  className="text-[11px] text-[var(--color-ink-muted)] underline"
                >
                  clear
                </Link>
              ) : null}
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
