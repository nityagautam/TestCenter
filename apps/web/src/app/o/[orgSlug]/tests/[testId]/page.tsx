import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getTestCase,
  testDurationHistory,
  testExecutionDetails,
  testExecutions,
  testFailureModes,
} from "@testcenter/db";
import { HistoryStrip } from "@/components/charts/history-strip";
import { TrendChart } from "@/components/charts/trend-chart";
import { QuarantineToggle } from "@/components/quarantine-toggle";
import { Card, CardHeader, StatTile, StatusBadge } from "@/components/ui";
import {
  formatAbsoluteTime,
  formatDay,
  formatDuration,
  formatPercent,
  formatRelativeTime,
  shortSha,
} from "@/lib/format";
import { getServices } from "@/lib/services";
import { can, requirePageContext } from "@/lib/viewer";

/**
 * Test detail — the history view.
 *
 * Built around the question that actually gets asked: "this test ran five times and
 * failed three — what happened each time?" So the page leads with the outcome strip,
 * then groups the failures by distinct failure mode (one bug or three?), then lists
 * every failure in full with its message, stack trace and captured output.
 *
 * Grouping comes before the flat list on purpose. Three failures with one shared
 * signature is a single problem; three different signatures is three problems, and
 * that distinction changes what you do next.
 *
 * The flat list defaults to failures for that reason, but `?show=all` widens it to
 * every execution: BDD runners write their step log to `<system-out>` on success as
 * well, and for a passing test that log is the only record of what it actually did.
 */
export const dynamic = "force-dynamic";

export default async function TestDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; testId: string }>;
  searchParams: Promise<{ mode?: string; expand?: string; show?: string }>;
}) {
  const { orgSlug, testId } = await params;
  const { mode, show } = await searchParams;
  const context = await requirePageContext(orgSlug);
  const { sql } = getServices();

  const numericId = Number(testId);
  if (!Number.isInteger(numericId)) notFound();

  const test = await getTestCase(sql, { orgId: context.org.id, testCaseId: numericId });
  if (!test) notFound();

  // `?show=all` widens the bottom list to every execution, so a passed run's captured
  // output (for Cucumber, its step log) is readable — not just failures. A signature
  // filter is inherently about failures, so `mode` wins over it.
  const showAll = show === "all" && !mode;

  const [executions, failureModes, details, durations] = await Promise.all([
    testExecutions(sql, { orgId: context.org.id, testCaseId: numericId, limit: 60 }),
    testFailureModes(sql, { orgId: context.org.id, testCaseId: numericId }),
    testExecutionDetails(sql, {
      orgId: context.org.id,
      testCaseId: numericId,
      limit: 20,
      // Output is capped per row here but not in the failures-only view: 20 rows at
      // the parser's 64k ceiling would be 1.3 MB of text on a page nobody scrolls.
      ...(showAll
        ? { statuses: ["passed", "failed", "error", "skipped", "blocked"], maxOutputChars: 8_000 }
        : {}),
    }),
    testDurationHistory(sql, { orgId: context.org.id, testCaseId: numericId, limit: 40 }),
  ]);

  const failureCount = executions.filter(
    (execution) => execution.status === "failed" || execution.status === "error",
  ).length;
  const flakyCount = executions.filter((execution) => execution.wasFlaky).length;

  // Filtering by mode is what makes the grouping actionable: pick a signature, see
  // only the failures caused by it.
  const visibleDetails = mode
    ? details.filter((detail) => (detail.failureSignatureHex ?? "none") === mode)
    : details;

  return (
    <main className="mx-auto max-w-6xl px-6 py-6">
      <nav className="mb-3 flex flex-wrap items-center gap-1.5 text-xs text-[var(--color-ink-muted)]">
        <Link href={`/o/${orgSlug}/tests`} className="hover:underline">
          Tests
        </Link>
        <span>/</span>
        <Link href={`/o/${orgSlug}/p/${test.projectKey}`} className="hover:underline">
          {test.projectName}
        </Link>
        {test.suite ? (
          <>
            <span>/</span>
            <Link
              href={`/o/${orgSlug}/tests?suite=${encodeURIComponent(test.suite)}`}
              className="truncate font-mono hover:underline"
            >
              {test.suite}
            </Link>
          </>
        ) : null}
      </nav>

      <header className="mb-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold tracking-tight break-words">{test.name}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-[var(--color-ink-muted)]">
              {test.classname ? <span>{test.classname}</span> : null}
              <span>first seen {formatRelativeTime(test.firstSeenAt)}</span>
              <span>last seen {formatRelativeTime(test.lastSeenAt)}</span>
              {test.lastStatus ? <StatusBadge status={test.lastStatus} /> : null}
            </div>
            {test.parameters && Object.keys(test.parameters).length > 0 ? (
              <div className="mt-1.5 font-mono text-[11px] text-[var(--color-ink-muted)]">
                parameters: {JSON.stringify(test.parameters)}
              </div>
            ) : null}
          </div>

          {can(context, "run:edit") ? (
            <QuarantineToggle
              orgSlug={orgSlug}
              testId={test.id}
              quarantined={test.quarantined}
              reason={test.quarantineReason}
            />
          ) : test.quarantined ? (
            <span className="rounded bg-[var(--color-status-skipped)]/15 px-2 py-1 text-[11px]">
              quarantined
            </span>
          ) : null}
        </div>
      </header>

      <Card className="mb-5">
        <div className="grid grid-cols-2 divide-x divide-y divide-[var(--color-border-subtle)] sm:grid-cols-3 lg:grid-cols-6 lg:divide-y-0">
          <StatTile
            label="Fail rate"
            value={formatPercent(test.failRate30d)}
            tone={Number(test.failRate30d) > 0 ? "failed" : "passed"}
            hint="last 30 days"
          />
          <StatTile label="Runs" value={test.runs30d} hint="last 30 days" />
          <StatTile
            label="Failures"
            value={test.failures30d}
            tone={test.failures30d > 0 ? "failed" : "neutral"}
          />
          <StatTile
            label="Flake score"
            value={Number(test.flakeScore).toFixed(0)}
            tone={Number(test.flakeScore) > 0 ? "flaky" : "neutral"}
            hint={Number(test.flakeScore) > 0 ? "passes inconsistently" : "stable"}
          />
          <StatTile label="Avg duration" value={formatDuration(test.avgDurationMs)} />
          <StatTile label="p95 duration" value={formatDuration(test.p95DurationMs)} />
        </div>
      </Card>

      {/* minmax(0,1fr), not 1fr. `1fr` is shorthand for minmax(auto, 1fr) and `auto`
          bottoms out at min-content, so a single long unbroken string anywhere in this
          column — a Hamcrest failure message in the history panel, as it turned out —
          widens the track and shoves the duration chart sideways. Capping the minimum at 0
          makes the column obey the space available instead of its longest word. */}
      <div className="mb-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card className="p-4">
          <HistoryStrip
            cells={executions.map((execution) => ({
              resultId: execution.resultId,
              runId: execution.runId,
              status: execution.status as never,
              wasFlaky: execution.wasFlaky,
              durationMs: execution.durationMs,
              startedAt: execution.startedAt.toISOString(),
              branch: execution.branch,
              failureMessage: execution.failureMessage,
            }))}
            runHrefBase={`/o/${orgSlug}/runs`}
          />
          <p className="mt-3 text-[11px] leading-relaxed text-[var(--color-ink-muted)]">
            {executions.length} recent execution{executions.length === 1 ? "" : "s"} ·{" "}
            {failureCount} failed · {flakyCount} passed only on retry. Click any cell to open that
            run.
          </p>
        </Card>

        <Card className="p-4">
          <TrendChart
            title="Duration over time"
            points={durations.map((entry) => ({
              label: formatDay(entry.startedAt),
              value: entry.durationMs,
              detail: entry.status,
            }))}
            color="var(--color-series-2)"
            height={120}
            format="duration"
          />
        </Card>
      </div>

      {failureModes.length > 0 ? (
        <Card className="mb-5 overflow-hidden">
          <CardHeader
            title={`Distinct failure modes (${failureModes.length})`}
            action={
              mode ? (
                <Link
                  href={`/o/${orgSlug}/tests/${test.id}`}
                  className="text-[11px] text-[var(--color-ink-muted)] underline"
                >
                  show all
                </Link>
              ) : (
                <span className="text-[11px] text-[var(--color-ink-muted)]">
                  grouped by failure signature
                </span>
              )
            }
          />
          <ul className="divide-y divide-[var(--color-border-subtle)]">
            {failureModes.map((failureMode) => {
              const key = failureMode.signatureHex ?? "none";
              const active = mode === key;
              return (
                <li key={key} className={`px-5 py-3 ${active ? "bg-[var(--color-surface)]" : ""}`}>
                  <div className="flex items-start gap-3">
                    <span className="mt-1 shrink-0 rounded bg-[var(--color-status-failed)]/10 px-1.5 py-0.5 font-mono text-[11px] text-[var(--color-status-failed)] tabular-nums">
                      {failureMode.occurrences}×
                    </span>
                    <div className="min-w-0 flex-1">
                      <Link
                        href={
                          active
                            ? `/o/${orgSlug}/tests/${test.id}`
                            : `/o/${orgSlug}/tests/${test.id}?mode=${key}`
                        }
                        className="block text-xs font-medium hover:underline"
                      >
                        {failureMode.failureType ?? "Failure"}
                      </Link>
                      {failureMode.sampleMessage ? (
                        <p className="mt-0.5 truncate font-mono text-[11px] text-[var(--color-ink-muted)]">
                          {failureMode.sampleMessage}
                        </p>
                      ) : null}
                      <p className="mt-1 font-mono text-[10px] text-[var(--color-ink-muted)]">
                        first {formatRelativeTime(failureMode.firstSeenAt)} · last{" "}
                        {formatRelativeTime(failureMode.lastSeenAt)}
                      </p>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          {failureModes.length > 1 ? (
            <p className="border-t border-[var(--color-border-subtle)] px-5 py-2.5 text-[11px] leading-relaxed text-[var(--color-ink-muted)]">
              More than one signature means these failures have different causes — worth treating as
              separate problems rather than one flaky test.
            </p>
          ) : null}
        </Card>
      ) : null}

      <Card className="overflow-hidden">
        <CardHeader
          title={
            mode
              ? `Failures in this mode (${visibleDetails.length})`
              : showAll
                ? `Execution history (${visibleDetails.length})`
                : `Failure history (${visibleDetails.length})`
          }
          action={
            <span className="flex items-center gap-3 text-[11px] text-[var(--color-ink-muted)]">
              {mode ? null : (
                <Link
                  href={
                    showAll
                      ? `/o/${orgSlug}/tests/${test.id}`
                      : `/o/${orgSlug}/tests/${test.id}?show=all`
                  }
                  className="underline"
                >
                  {showAll ? "failures only" : "show all executions"}
                </Link>
              )}
              <span>newest first</span>
            </span>
          }
        />
        {visibleDetails.length === 0 ? (
          <p className="px-5 py-8 text-center text-xs text-[var(--color-ink-muted)]">
            {showAll
              ? "This test has no executions in the retained history."
              : "This test has never failed in the retained history."}
          </p>
        ) : (
          <ul className="divide-y divide-[var(--color-border-subtle)]">
            {visibleDetails.map((detail) => (
              <li key={detail.resultId} className="px-5 py-4">
                <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <StatusBadge status={detail.status} />
                  <Link
                    href={`/o/${orgSlug}/runs/${detail.runId}?result=${detail.resultId}`}
                    className="text-xs font-medium hover:underline"
                  >
                    {detail.runName ?? "Run"}
                  </Link>
                  <span
                    className="font-mono text-[10px] text-[var(--color-ink-muted)]"
                    title={formatAbsoluteTime(detail.startedAt)}
                  >
                    {formatRelativeTime(detail.startedAt)}
                  </span>
                  {detail.branch ? (
                    <span className="font-mono text-[10px] text-[var(--color-ink-muted)]">
                      {detail.branch}
                    </span>
                  ) : null}
                  {shortSha(detail.commitSha) ? (
                    <span className="font-mono text-[10px] text-[var(--color-ink-muted)]">
                      {shortSha(detail.commitSha)}
                    </span>
                  ) : null}
                  {detail.durationMs != null ? (
                    <span className="font-mono text-[10px] text-[var(--color-ink-muted)]">
                      {formatDuration(detail.durationMs)}
                    </span>
                  ) : null}
                  {detail.retryCount > 0 ? (
                    <span className="font-mono text-[10px] text-[var(--color-ink-muted)]">
                      {detail.retryCount + 1} attempts
                    </span>
                  ) : null}
                  {detail.ciJobUrl ? (
                    <a
                      href={detail.ciJobUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[10px] underline"
                    >
                      CI job
                    </a>
                  ) : null}
                </div>

                {detail.failureMessage ? (
                  <Block
                    title={detail.failureType ?? "Failure"}
                    body={detail.failureMessage}
                    tone="failed"
                  />
                ) : null}
                {detail.stackTrace ? <Block title="Stack trace" body={detail.stackTrace} /> : null}
                {detail.stderr ? (
                  <Block title="stderr" body={detail.stderr} truncated={detail.stderrTruncated} />
                ) : null}
                {detail.stdout ? (
                  <Block
                    title="stdout (system-out)"
                    body={detail.stdout}
                    truncated={detail.stdoutTruncated}
                  />
                ) : null}
                {/* A green test with nothing captured is worth stating outright, so an
                    empty panel does not read as a rendering bug. */}
                {!detail.failureMessage &&
                !detail.stackTrace &&
                !detail.stdout &&
                !detail.stderr ? (
                  <p className="mt-1 text-[11px] text-[var(--color-ink-muted)]">
                    No captured output for this execution.
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </main>
  );
}

function Block({
  title,
  body,
  tone = "neutral",
  truncated = false,
}: {
  title: string;
  body: string;
  tone?: "neutral" | "failed";
  truncated?: boolean;
}) {
  return (
    <details className="mt-2" open={tone === "failed"}>
      <summary
        className={`cursor-pointer font-mono text-[10px] ${
          tone === "failed" ? "text-[var(--color-status-failed)]" : "text-[var(--color-ink-muted)]"
        }`}
      >
        {title}
        {truncated ? " · truncated for this view — open the run for the full output" : null}
      </summary>
      <pre className="mt-1 max-h-64 overflow-auto rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
        {body}
      </pre>
    </details>
  );
}
