"use client";

import Link from "next/link";
import { useState } from "react";
import { formatAbsoluteTime } from "@/lib/format";

/**
 * One test's outcome across its recent executions, oldest to newest.
 *
 * This is the densest useful answer to "how has this test behaved?" — a run of green
 * with three red cells is instantly legible in a way a table of 40 rows is not.
 *
 * Each cell is a link to that execution, because the question immediately after
 * "it failed three times" is "show me the third one". Status is never colour-alone:
 * every cell carries a glyph (✕ / ! / – / ✓) and an accessible label, which is also
 * what keeps it readable under deuteranopia where red and green are 4 ΔE apart.
 */
export interface HistoryCell {
  resultId: number;
  runId: string;
  status: "passed" | "failed" | "error" | "skipped" | "blocked";
  wasFlaky: boolean;
  durationMs: number | null;
  startedAt: string;
  branch: string | null;
  failureMessage: string | null;
}

const GLYPH: Record<string, string> = {
  failed: "✕",
  error: "!",
  skipped: "–",
  blocked: "–",
  passed: "✓",
};

function colorFor(cell: HistoryCell): string {
  if (cell.status === "failed") return "var(--color-status-failed)";
  if (cell.status === "error") return "var(--color-status-error)";
  if (cell.status === "skipped" || cell.status === "blocked") {
    return "var(--color-status-skipped)";
  }
  return cell.wasFlaky ? "var(--color-status-flaky)" : "var(--color-status-passed)";
}

function labelFor(cell: HistoryCell): string {
  if (cell.status === "passed" && cell.wasFlaky) return "flaky (passed on retry)";
  return cell.status;
}

export function HistoryStrip({
  cells,
  runHrefBase,
  title = "Execution history",
}: {
  cells: HistoryCell[];
  /**
   * Base path for a run, e.g. `/o/acme/runs`. A string rather than a callback because
   * functions cannot be serialized from a server component to a client one.
   */
  runHrefBase: string;
  title?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);

  if (cells.length === 0) {
    return <div className="text-xs text-[var(--color-ink-muted)]">No execution history yet.</div>;
  }

  // Oldest on the left reads as time moving forward, matching every other trend here.
  const ordered = [...cells].reverse();
  const hovered = hover !== null ? ordered[hover] : null;

  /*
   * The detail panel is always rendered, falling back to the newest execution.
   *
   * It used to appear only while a cell was hovered, which made hovering *change the
   * layout*: the panel's own width fed back into the page's `1fr` grid column and shoved
   * the duration chart sideways, and its height pushed everything below it down. Reading a
   * chart should not require holding the mouse still.
   *
   * Defaulting to the newest run is better than reserving blank space, because "how did
   * this test do last time" is the question the panel would be answering anyway.
   */
  const active = hovered ?? ordered[ordered.length - 1] ?? null;

  return (
    <figure className="min-w-0">
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <figcaption className="text-xs font-medium">{title}</figcaption>
        <span className="font-mono text-[10px] text-[var(--color-ink-muted)]">
          oldest → newest · {cells.length} run{cells.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="relative">
        <ol className="flex flex-wrap gap-[2px]">
          {ordered.map((cell, index) => (
            <li key={cell.resultId}>
              <Link
                href={`${runHrefBase}/${cell.runId}?result=${cell.resultId}`}
                onMouseEnter={() => setHover(index)}
                onFocus={() => setHover(index)}
                onMouseLeave={() => setHover(null)}
                onBlur={() => setHover(null)}
                // Hit target is larger than the visual mark, which a 10px cell needs.
                className="flex size-5 items-center justify-center rounded-sm text-[9px] leading-none font-bold text-white transition-transform hover:scale-110"
                style={{ background: colorFor(cell) }}
                title={`${labelFor(cell)} · ${formatAbsoluteTime(cell.startedAt)}`}
                aria-label={`Execution ${index + 1} of ${ordered.length}: ${labelFor(
                  cell,
                )} on ${formatAbsoluteTime(cell.startedAt)}`}
              >
                <span aria-hidden>{GLYPH[cell.status] ?? "?"}</span>
              </Link>
            </li>
          ))}
        </ol>

        {active ? (
          /*
           * `min-w-0` is what actually stops the shove. A failure message is one long
           * unbroken string, so this panel's min-content width is the whole message, and a
           * `1fr` grid track is `minmax(auto, 1fr)` — its minimum is min-content. The track
           * grew to fit the message and the neighbouring chart moved. `min-w-0` lets the
           * panel shrink so `truncate` has something to truncate against; the page's grid
           * uses `minmax(0, 1fr)` for the same reason, since either alone leaves the bug
           * reachable from the other direction.
           *
           * The fixed min-height keeps the panel the same size whether or not the active
           * execution has a failure message, so moving between a passed and a failed cell
           * does not resize it either.
           */
          <div className="mt-2 min-h-[3.25rem] min-w-0 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-2">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <span className="text-[11px] font-semibold" style={{ color: colorFor(active) }}>
                {labelFor(active)}
              </span>
              <span className="font-mono text-[10px] text-[var(--color-ink-muted)]">
                {formatAbsoluteTime(active.startedAt)}
              </span>
              {active.branch ? (
                <span className="font-mono text-[10px] text-[var(--color-ink-muted)]">
                  {active.branch}
                </span>
              ) : null}
              {active.durationMs != null ? (
                <span className="font-mono text-[10px] text-[var(--color-ink-muted)]">
                  {active.durationMs}ms
                </span>
              ) : null}
              {hovered === null ? (
                <span className="rounded bg-[var(--color-border-subtle)] px-1 text-[9px] tracking-wide uppercase">
                  latest
                </span>
              ) : null}
            </div>
            {active.failureMessage ? (
              <div className="mt-1 min-w-0 truncate font-mono text-[10px] text-[var(--color-status-failed)]">
                {active.failureMessage}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </figure>
  );
}
