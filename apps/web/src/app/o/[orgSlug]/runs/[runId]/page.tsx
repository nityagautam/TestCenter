import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getRun,
  getRunResult,
  listRunResults,
  recentOutcomes,
  runVerdictHistory,
  summarizeRunSuites,
} from "@testcenter/db";
import { Card, CardHeader, EmptyState, ResultBar, StatTile, StatusBadge } from "@/components/ui";
import { OutcomeStrip } from "@/components/charts/outcome-strip";
import { RunActions } from "@/components/run-actions";
import { awaitsVerdict, VerdictBadge } from "@/components/verdict-badge";
import { RunProgress } from "@/components/run-progress";
import {
  formatAbsoluteTime,
  formatDuration,
  formatPercent,
  formatRelativeTime,
  shortSha,
  truncateStart,
} from "@/lib/format";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { getServices } from "@/lib/services";
import { viewerTimeZone } from "@/lib/timezone";
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
  const tz = await viewerTimeZone();
  const orgId = context.org.id;

  const { sql } = getServices();
  const run = await getRun(sql, { orgId, runId });
  if (!run) notFound();

  const limit = Math.min(Math.max(Number(query.limit ?? 200), 25), 500);
  const [resultPage, suites, selected, verdicts] = await Promise.all([
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
    runVerdictHistory(sql, { orgId, runId, limit: 10 }),
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

  // Newest first from the query, so the head is the standing verdict.
  const latestVerdict = verdicts[0] ?? null;

  const failing = run.failed + run.errored;
  const base = `/o/${orgSlug}/runs/${runId}`;

  /*
   * The run's identity, as cells rather than a sentence.
   *
   * Two classes of field, treated differently when the uploader did not send one:
   *
   *   Core identity — branch, commit, environment, framework. Always shown, and shown as
   *   "not reported" when absent, because the absence is itself the finding. A run with no
   *   branch cannot be compared against another branch and lands under "(no branch)" in
   *   the pass-rate-by-branch chart; a run with no commit cannot be tied to the code that
   *   produced it. Silently omitting the cell hides a fixable CI misconfiguration, and the
   *   fix is a query parameter the uploader forgot.
   *
   *   Circumstantial — pull request, CI job link, shard. Omitted entirely when absent,
   *   because most runs legitimately have none and a row of "not reported" for things that
   *   were never expected is noise that trains people to ignore the real ones.
   *
   * Tags are absent from both lists: they have their own editor directly below, and
   * duplicating them would give two places to read the same thing and one to change it.
   */
  const missingHint =
    "Not sent by the uploader. CI can supply it as a query parameter on /api/v1/ingest.";

  const tagEntries = Object.entries(run.tags).sort(([a], [b]) => a.localeCompare(b));

  const metaCells: {
    label: string;
    value: string;
    title?: string;
    href?: string;
    missing?: boolean;
  }[] = [
    run.branch
      ? { label: "Branch", value: run.branch }
      : { label: "Branch", value: "not reported", title: missingHint, missing: true },
    shortSha(run.commitSha)
      ? {
          label: "Commit",
          value: shortSha(run.commitSha) as string,
          // The short form is what anyone reads; the full one is what gets pasted into a
          // git command, so it lives on hover rather than in the cell.
          title: run.commitSha ?? undefined,
        }
      : { label: "Commit", value: "not reported", title: missingHint, missing: true },
    run.environment
      ? { label: "Environment", value: run.environment }
      : { label: "Environment", value: "not reported", title: missingHint, missing: true },
    run.framework
      ? { label: "Framework", value: run.framework }
      : { label: "Framework", value: "not detected", title: missingHint, missing: true },
    {
      label: "Started",
      value: formatRelativeTime(run.startedAt),
      title: formatAbsoluteTime(run.startedAt, tz.zone, tz.label),
    },
    run.durationMs
      ? { label: "Duration", value: formatDuration(run.durationMs) }
      : // Absent while a run is still parsing, which is expected rather than missing.
        { label: "Duration", value: "—", title: "Not finished yet", missing: true },
    // Circumstantial from here down: shown only when present.
    ...(run.prNumber ? [{ label: "Pull request", value: `#${run.prNumber}` }] : []),
    ...(run.ciJobUrl ? [{ label: "CI", value: "View job", href: run.ciJobUrl }] : []),
  ];

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
      {/* Project-scoped paths throughout, never `?project=` on the org list: a crumb should
          put you *inside* the project, with the header dropdown and the project nav agreeing
          with where you landed. */}
      <Breadcrumbs
        backHref={`/o/${orgSlug}/p/${run.projectKey}/runs`}
        items={[
          { label: run.projectKey, href: `/o/${orgSlug}/p/${run.projectKey}`, mono: true },
          { label: "Runs", href: `/o/${orgSlug}/p/${run.projectKey}/runs` },
          { label: run.name ?? run.framework ?? "Run" },
        ]}
      />

      <header className="mb-6">
        {/* items-start, and the title grouped with its badges: the ⋯ actions expand into
            panels tall enough that a centred row would leave the heading floating at its
            middle. The group keeps title and badges aligned to each other regardless. */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <h1 className="min-w-0 truncate text-xl font-semibold tracking-tight">
              {run.name ?? run.framework ?? "Run"}
            </h1>
            <StatusBadge status={run.status} />
            {/* Always shown once the run has finished — TODO when nobody has judged it, so
              an unreviewed run is visibly unreviewed rather than silently blank. */}
            {awaitsVerdict(run.status) ? (
              <VerdictBadge verdict={latestVerdict?.verdict ?? null} />
            ) : null}
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

          {/* Renders nothing when the viewer can do none of these. */}
          <div className="shrink-0">
            <RunActions
              runId={runId}
              orgSlug={orgSlug}
              name={run.name}
              fallback={run.framework ?? "Run"}
              totalTests={run.total}
              canRename={can(context, "run:rename")}
              canDelete={can(context, "run:delete")}
              canVerdict={can(context, "run:verdict")}
              canEditTags={can(context, "run:edit")}
              tags={run.tags}
              currentVerdict={latestVerdict?.verdict ?? null}
              deleteRedirectTo={`/o/${orgSlug}/p/${run.projectKey}/runs`}
            />
          </div>
        </div>

        {/*
         * The run's identity, as a spec strip rather than a sentence.
         *
         * This was one mono line — "branch jcp-common-ext commit 02ae8a8 env SWADESHUAT
         * cucumber-jvm started 1h ago" — where the labels and the values shared a weight, a
         * size and a colour, so finding the environment meant reading the whole line and
         * mentally separating the words that name things from the words that are the answer.
         *
         * The pattern is the stat-tile row's, deliberately: quiet uppercase label, value as
         * the figure, cells divided. This app already teaches that shape one card below, so
         * reusing it costs the reader nothing new to learn. Chips were the other candidate
         * and are wrong here — the tag row sits directly beneath, and metadata dressed as
         * chips would read as more tags.
         */}
        <dl className="mt-3 overflow-hidden rounded-md border border-[var(--color-border-subtle)]">
          {/*
           * Two bands, not one grid.
           *
           * `divide-*` borders children by DOM order rather than grid position, so a
           * seventh cell wrapping onto a second row gets a stray left border while the row
           * above it gets none at the top — which is the divider that was missing. Tailwind
           * cannot express "border between grid rows" here, so the tags band is its own
           * element with an explicit top border instead.
           *
           * Full width suits it anyway: the value is a list, and a list given the whole row
           * reads as a list rather than as a cell that overflowed.
           */}
          <div className="grid grid-cols-2 divide-x divide-y divide-[var(--color-border-subtle)] sm:grid-cols-3 lg:grid-cols-6 lg:divide-y-0">
            {metaCells.map((cell) => (
              <div key={cell.label} className="min-w-0 px-3 py-2">
                <dt className="text-[10px] font-medium tracking-wide text-[var(--color-ink-muted)] uppercase">
                  {cell.label}
                </dt>
                <dd
                  className={`mt-0.5 truncate text-xs ${
                    cell.missing ? "text-[var(--color-ink-muted)]/70 italic" : "font-mono"
                  }`}
                  title={cell.title ?? cell.value}
                >
                  {cell.href ? (
                    <a
                      href={cell.href}
                      target="_blank"
                      rel="noreferrer"
                      className="underline hover:no-underline"
                    >
                      {cell.value}
                    </a>
                  ) : (
                    cell.value
                  )}
                </dd>
              </div>
            ))}
          </div>
          {/*
           * Tags as a cell, not a row of their own.
           *
           * They were hanging under the strip as an orphan band of chips — the only piece
           * of run metadata that was not a labelled cell, which made it read as a separate
           * feature rather than another fact about the run.
           *
           * Two columns wide because the value is a *set*: one column truncates a realistic
           * tag list to almost nothing. Beyond three the rest collapse into "+N", with the
           * complete list on hover — hover as supplement, never as the only route, since
           * touch has none and the full set is also in the editor behind the ⋯ menu.
           *
           * Explicitly not an expand-on-hover panel: it would shift the strip's layout
           * while the pointer is in it, which is the mistake the history strip's detail
           * panel already made once and had to have undone.
           */}
          <div className="min-w-0 border-t border-[var(--color-border-subtle)] px-3 py-2">
            <dt className="text-[10px] font-medium tracking-wide text-[var(--color-ink-muted)] uppercase">
              Tags
            </dt>
            <dd className="mt-0.5 min-w-0">
              {tagEntries.length === 0 ? (
                <span
                  className="text-xs text-[var(--color-ink-muted)]/70 italic"
                  title="No tags on this run. CI can send them as ?tag=key:value on /api/v1/ingest."
                >
                  none
                </span>
              ) : (
                <span
                  className="flex min-w-0 items-center gap-1"
                  title={tagEntries.map(([key, value]) => `${key}:${value}`).join("  ·  ")}
                >
                  {tagEntries.slice(0, 3).map(([key, value]) => (
                    <span
                      key={key}
                      className="min-w-0 truncate rounded bg-[var(--color-surface)] px-1.5 py-0.5 font-mono text-[10px]"
                    >
                      <span className="text-[var(--color-ink-muted)]">{key}</span>
                      <span className="text-[var(--color-ink-muted)]/50">:</span>
                      {value}
                    </span>
                  ))}
                  {tagEntries.length > 3 ? (
                    <span className="shrink-0 font-mono text-[10px] text-[var(--color-ink-muted)]">
                      +{tagEntries.length - 3}
                    </span>
                  ) : null}
                </span>
              )}
            </dd>
          </div>
        </dl>

        {/*
         * The verdict trail. Shown to everyone, not only to whoever can write it: the
         * value of "this was infra, not your code" is that a developer reads it.
         *
         * Superseded entries stay visible and muted rather than being hidden behind a
         * disclosure — a verdict that changed is itself information ("this looked like
         * infra until someone dug in"), and hiding it would make the table's history
         * pointless.
         */}
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

      {/*
       * The verdict log.
       *
       * Sized to show five entries and scroll past that. Which means every row has to be
       * the same height, and that is why notes are truncated to one line rather than
       * wrapping: with variable-height rows a fixed box shows five short entries or two
       * long ones, and "five" stops meaning anything. The full note is on hover, and a
       * log is read by scanning anyway — h-8 per row against max-h-40 is exactly five.
       *
       * Kept to a readable measure instead of the page width: these are short lines, and
       * stretched across 1400px the timestamp ends up a screen away from the badge it
       * belongs to.
       *
       * mb-6 matches every other block on this page. The stat tiles above already supply
       * the gap on top; without a margin below, the log butted straight into the results
       * table with nothing separating them.
       */}
      {verdicts.length > 0 ? (
        <section className="mb-6 overflow-hidden rounded-md border border-[var(--color-border-subtle)]">
          <div className="flex items-baseline justify-between gap-2 border-b border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5">
            <h2 className="text-[10px] font-medium tracking-wide uppercase">Verdict log</h2>
            <span className="font-mono text-[10px] text-[var(--color-ink-muted)]">
              {verdicts.length} entr{verdicts.length === 1 ? "y" : "ies"} · newest first
              {verdicts.length > 5 ? " · scroll for more" : ""}
            </span>
          </div>
          {/* tabIndex makes the scroll region reachable by keyboard: an overflow container
              is not focusable by default, so its content would be unreachable without a
              pointer. */}
          <ul
            className="max-h-40 divide-y divide-[var(--color-border-subtle)] overflow-y-auto focus-visible:ring-2 focus-visible:ring-[var(--color-ink)] focus-visible:outline-none"
            tabIndex={0}
            aria-label={`Verdict history, ${verdicts.length} entries, newest first`}
          >
            {verdicts.map((entry, index) => (
              <li
                key={entry.id}
                className={`flex h-8 items-center gap-2 px-3 ${
                  index === 0 ? "" : "bg-[var(--color-surface)]/40"
                }`}
              >
                <VerdictBadge verdict={entry.verdict} size="sm" />
                <span
                  className={`min-w-0 flex-1 truncate text-[11px] ${
                    entry.note ? "" : "text-[var(--color-ink-muted)] italic"
                  }`}
                  title={entry.note ?? undefined}
                >
                  {entry.note ?? "no note"}
                </span>
                <span
                  className="shrink-0 font-mono text-[10px] text-[var(--color-ink-muted)]"
                  title={formatAbsoluteTime(entry.createdAt, tz.zone, tz.label)}
                >
                  {entry.authorName ?? entry.authorEmail ?? "removed account"} ·{" "}
                  {formatRelativeTime(entry.createdAt)}
                </span>
                {/* "Superseded" as a mark rather than a word: the word repeated down every
                    row but the first is a column of noise, and position already says it. */}
                {index === 0 ? (
                  <span className="shrink-0 text-[9px] text-[var(--color-status-passed)]">
                    current
                  </span>
                ) : (
                  <span
                    className="shrink-0 text-[10px] text-[var(--color-ink-muted)]"
                    title="Superseded by a later verdict"
                    aria-label="superseded"
                  >
                    ↩
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

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
                            timeZone={tz.zone}
                            timeZoneLabel={tz.label}
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
