"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { StatusBadge } from "@/components/ui";
import { formatDuration } from "@/lib/format";

/**
 * The test cases in a run, over whatever page you were already on.
 *
 * The point is not a second copy of the run page's table — that table exists and is better, with
 * filters and the full history strip. The point is answering "what is in this run" *without
 * leaving*, which matters when you are scanning a list of twenty runs for the one that broke and
 * do not want to lose your filters to find out.
 *
 * State lives in the URL (`?results=<runId>`, `?cols=`), per the convention the rest of this app
 * follows: the view is then shareable, survives a reload, and the back button closes it. A modal
 * held in client state fails all three, and the third is the one people actually try.
 */

interface Row {
  id: number;
  testCaseId: number;
  name: string;
  classname: string | null;
  suite: string | null;
  status: string;
  durationMs: number | null;
  retryCount: number;
  wasFlaky: boolean;
  failureType: string | null;
  failureMessage: string | null;
  flakeScore: string | number | null;
  quarantined: boolean;
}

interface Cursor {
  statusRank: number;
  durationMs: number;
  id: number;
}

interface Page {
  results: Row[];
  nextCursor: Cursor | null;
  total: number;
  pageSize: number;
  run: { id: string; name: string | null; framework: string | null; status: string };
}

export function RunResultsOverlay({
  orgSlug,
  runId,
  onClose,
  /** Shown wider on the run page, where there is no list underneath to keep visible. */
  wide = false,
  showSuite,
  onToggleSuite,
}: {
  orgSlug: string;
  runId: string;
  onClose: () => void;
  wide?: boolean;
  /** Off by default. The suite is usually a path prefix the test name already implies. */
  showSuite: boolean;
  onToggleSuite: () => void;
}) {
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /*
   * A stack of cursors, not a page number.
   *
   * The sort key is (status rank, duration, id), which makes the cursor forward-only — there is
   * no "previous cursor" to compute. Offset paging would give both directions and is wrong for a
   * different reason: rows shift under an offset, so page two after a re-render can repeat or skip
   * a row. Keeping the cursors we have already used costs one array and is exact in both
   * directions.
   */
  const [stack, setStack] = useState<(Cursor | null)[]>([null]);
  const dialog = useRef<HTMLDivElement>(null);
  /** Where focus was before opening, so closing puts it back on the row that opened this. */
  const opener = useRef<Element | null>(null);

  const cursor = stack[stack.length - 1] ?? null;

  useEffect(() => {
    opener.current = document.activeElement;
    return () => {
      // Focus is restored on unmount rather than in the close handler, so it happens however the
      // overlay closed — Escape, the backdrop, the button, or a browser Back.
      if (opener.current instanceof HTMLElement) opener.current.focus();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams();
    if (cursor) params.set("cursor", JSON.stringify(cursor));
    fetch(`/o/${orgSlug}/runs/${runId}/results?${params.toString()}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`could not load results (${response.status})`);
        return (await response.json()) as Page;
      })
      .then((body) => {
        if (cancelled) return;
        setPage(body);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : "could not load results");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [orgSlug, runId, cursor]);

  /*
   * Escape closes, and Tab is confined to the dialog.
   *
   * Without the trap, tabbing walks out of the overlay and into the page behind it — which is
   * still there, still focusable, and now unreachable by eye. That is the difference between a
   * dialog and a div that looks like one.
   */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialog.current) return;
      const focusable = dialog.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  useEffect(() => {
    // Focus the dialog itself on open, so the first Tab lands inside it rather than at the top of
    // the document.
    dialog.current?.focus();
  }, []);

  const shown = page?.results.length ?? 0;
  const from = stack.length === 1 ? 1 : (stack.length - 1) * (page?.pageSize ?? 25) + 1;
  const to = from + shown - 1;

  return (
    <div
      // A backdrop that closes on click, and a dialog that does not — the click has to be on the
      // backdrop itself, or clicking a row inside would dismiss the thing you are reading.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[6vh] backdrop-blur-[1px]"
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={`Test cases in ${page?.run.name ?? "this run"}`}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={`flex max-h-[84vh] w-full flex-col overflow-hidden rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] shadow-xl outline-none ${
          wide ? "max-w-[92rem]" : "max-w-6xl"
        }`}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-[var(--color-border-subtle)] px-5 py-3">
          <span className="flex min-w-0 flex-wrap items-baseline gap-2">
            <h2 className="min-w-0 truncate text-sm font-medium">
              {page?.run.name ?? page?.run.framework ?? "Test cases"}
            </h2>
            <span className="text-[11px] text-[var(--color-ink-muted)]">
              {page ? `${from}–${to} of ${page.total}` : loading ? "loading…" : ""}
            </span>
            {/*
             * Said explicitly, because the run page's filters do not reach in here. A count of
             * 955 beside a filtered list would read as a bug, so the overlay always shows the
             * whole run and says which it is.
             */}
            <span className="text-[11px] text-[var(--color-ink-muted)]">
              &middot; every test, unfiltered
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-3 text-[11px]">
            <a
              href={`/o/${orgSlug}/runs/${runId}/export/csv`}
              className="underline hover:text-[var(--color-ink)]"
              title="Every result in this run as CSV, not just this page"
            >
              Export CSV
            </a>
            <Link
              href={`/o/${orgSlug}/runs/${runId}`}
              className="underline hover:text-[var(--color-ink)]"
            >
              Open run
            </Link>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded px-1.5 py-0.5 text-[var(--color-ink-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-ink)]"
            >
              &times;
            </button>
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {error ? (
            <p className="px-5 py-8 text-center text-xs text-[var(--color-status-failed)]">
              {error}
            </p>
          ) : page && page.total === 0 ? (
            <p className="px-5 py-8 text-center text-xs text-[var(--color-ink-muted)]">
              This run has no results. It may still be parsing.
            </p>
          ) : (
            <table className="w-full table-fixed text-left text-[12px]">
              {/*
               * Fixed layout with explicit widths, not the browser's auto layout.
               *
               * The test cell scrolls horizontally, and an overflow container can only scroll
               * inside a *definite* width. Under auto layout the column is sized from its own
               * content, so a 300-character parameterised name widens the column — and therefore
               * the table — instead of overflowing it, and nothing ever scrolls. Every column but
               * Test declares a width, which leaves Test the remainder, so hiding the suite hands
               * its 14rem to the test name rather than redistributing it across all five.
               */}
              <colgroup>
                <col className="w-[6.5rem]" />
                <col />
                {showSuite ? <col className="w-[14rem]" /> : null}
                <col className="w-[6rem]" />
                <col className="w-[4.5rem]" />
              </colgroup>
              <thead className="sticky top-0 bg-[var(--color-surface-raised)]">
                <tr className="border-b border-[var(--color-border-subtle)] text-[10px] tracking-widest text-[var(--color-ink-muted)] uppercase">
                  <th className="px-5 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">
                    {/*
                     * The column picker is one button and lives where the column would appear,
                     * rather than in a settings panel listing all five. Only the suite is
                     * optional, so a general picker would be four permanent rows of chrome to
                     * express one choice.
                     */}
                    <span className="flex items-center gap-1.5">
                      Test
                      {showSuite ? null : (
                        <button
                          type="button"
                          onClick={onToggleSuite}
                          title="Show the suite column"
                          className="rounded border border-dashed border-[var(--color-border-subtle)] px-1 leading-4 hover:border-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
                        >
                          + suite
                        </button>
                      )}
                    </span>
                  </th>
                  {showSuite ? (
                    <th className="px-3 py-2 font-medium">
                      <span className="flex items-center gap-1.5">
                        Suite
                        <button
                          type="button"
                          onClick={onToggleSuite}
                          aria-label="Hide the suite column"
                          title="Hide the suite column"
                          className="rounded px-1 leading-4 hover:bg-[var(--color-surface)] hover:text-[var(--color-ink)]"
                        >
                          &times;
                        </button>
                      </span>
                    </th>
                  ) : null}
                  <th className="px-3 py-2 text-right font-medium">Time</th>
                  <th className="px-5 py-2 text-right font-medium">Flake</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border-subtle)]">
                {(page?.results ?? []).map((row) => (
                  // Keyed by result id, which is unique per row of a run.
                  <tr key={row.id} className="hover:bg-[var(--color-surface)]/60">
                    <td className="px-5 py-2 align-top">
                      <StatusBadge status={row.status} />
                    </td>
                    <td className="px-3 py-2 align-top">
                      {/*
                       * Scrolls rather than truncates. The name is what people open this to
                       * read and copy, and a parameterised name carries its distinguishing part
                       * at the *end* — exactly what `truncate` throws away.
                       *
                       * The scrollbar is hidden: twenty-five rows of gutters is worse than the
                       * hard right edge, which is a truer signal anyway. An ellipsis would now
                       * be a lie, since it says "the rest is elsewhere" when the rest is one
                       * scroll away.
                       *
                       * `draggable={false}` is what makes the copy work. Dragging across text
                       * inside an `<a>` starts a link drag, so the selection never begins and
                       * the name cannot be swiped — the browser hands you a URL instead.
                       */}
                      <div className="tc-no-scrollbar overflow-x-auto">
                        <Link
                          href={`/o/${orgSlug}/tests/${row.testCaseId}`}
                          draggable={false}
                          className="block whitespace-nowrap hover:underline"
                          title={row.name}
                        >
                          {row.name}
                        </Link>
                      </div>
                      {/* The failure message is why anyone opened this, so it is on the row
                          rather than behind another click — and scrollable for the same
                          reason as the name, since the assertion detail is at its end. */}
                      {row.failureMessage ? (
                        <div className="tc-no-scrollbar mt-0.5 overflow-x-auto">
                          <span
                            className="block font-mono text-[10px] whitespace-nowrap text-[var(--color-status-failed)]"
                            title={row.failureMessage}
                          >
                            {row.failureMessage}
                          </span>
                        </div>
                      ) : null}
                      {row.quarantined ? (
                        <span className="mt-0.5 inline-block rounded bg-[var(--color-status-skipped)]/15 px-1 text-[10px] text-[var(--color-ink-muted)]">
                          quarantined
                        </span>
                      ) : null}
                    </td>
                    {showSuite ? (
                      <td className="px-3 py-2 align-top">
                        <span
                          className="block truncate text-[var(--color-ink-muted)]"
                          title={row.suite ?? ""}
                        >
                          {row.suite ?? "—"}
                        </span>
                      </td>
                    ) : null}
                    <td className="px-3 py-2 text-right align-top font-mono tabular-nums">
                      {/* Number(), because int8 arrives from postgres.js as a string and would
                          otherwise be formatted as text. */}
                      {row.durationMs === null ? "—" : formatDuration(Number(row.durationMs))}
                      {row.retryCount > 0 ? (
                        <span className="ml-1 text-[10px] text-[var(--color-status-flaky)]">
                          &times;{row.retryCount + 1}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-5 py-2 text-right align-top font-mono text-[var(--color-ink-muted)] tabular-nums">
                      {Number(row.flakeScore ?? 0) > 0 ? Number(row.flakeScore).toFixed(0) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-[var(--color-border-subtle)] px-5 py-2.5 text-[11px]">
          <span className="text-[var(--color-ink-muted)]">
            {loading ? "loading…" : page ? `page ${stack.length}` : ""}
          </span>
          <span className="flex items-center gap-2">
            <button
              type="button"
              disabled={stack.length === 1 || loading}
              onClick={() => setStack((current) => current.slice(0, -1))}
              className="rounded border border-[var(--color-border-subtle)] px-2 py-1 enabled:hover:border-[var(--color-ink-muted)] disabled:opacity-40"
            >
              Previous
            </button>
            <button
              type="button"
              disabled={!page?.nextCursor || loading}
              onClick={() =>
                setStack((current) => (page?.nextCursor ? [...current, page.nextCursor] : current))
              }
              className="rounded border border-[var(--color-border-subtle)] px-2 py-1 enabled:hover:border-[var(--color-ink-muted)] disabled:opacity-40"
            >
              Next
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
