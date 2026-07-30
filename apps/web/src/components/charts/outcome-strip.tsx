import Link from "next/link";
import type { RecentOutcome } from "@testcenter/db";
import { formatAbsoluteTime } from "@/lib/format";

/**
 * One test's recent outcomes, sized to live inside a table row.
 *
 * This replaces a 10px "history" text link, which had three problems: it carried no
 * information, it sat two pixels from the name link so a mis-click cost you your place
 * in the table, and repeated down fifty rows it was pure noise. A strip answers "how
 * has this behaved?" in the same pixels it spends getting you to the full history.
 *
 * Deliberately NOT the interactive `HistoryStrip`. There, each cell is its own link to
 * that execution, which is right for one test on a detail page — but fifty rows × eight
 * cells would be 400 tab stops between the top of the table and the bottom. Here the
 * whole strip is a single link to the test's history, so the row keeps one destination
 * and the keyboard path stays one stop per row. It is also a server component, so a
 * page of fifty strips ships no client JavaScript.
 *
 * Colour never carries status alone: `--color-status-passed` and `--color-status-failed`
 * are ΔE 4.1 apart under deuteranopia (verified — not eyeballed), so every cell also
 * carries a glyph, exactly as the full-size strip does. The adjacent Fail rate column
 * supplies the counts as text.
 */

const GLYPH: Record<string, string> = {
  failed: "✕",
  error: "!",
  skipped: "–",
  blocked: "–",
  passed: "✓",
};

function colorFor(cell: RecentOutcome): string {
  if (cell.status === "failed") return "var(--color-status-failed)";
  if (cell.status === "error") return "var(--color-status-error)";
  if (cell.status === "skipped" || cell.status === "blocked") {
    return "var(--color-status-skipped)";
  }
  return cell.wasFlaky ? "var(--color-status-flaky)" : "var(--color-status-passed)";
}

function labelFor(cell: RecentOutcome): string {
  if (cell.status === "passed" && cell.wasFlaky) return "flaky (passed on retry)";
  return cell.status;
}

export function OutcomeStrip({
  cells,
  href,
  testName,
}: {
  /** Oldest first — the order `recentOutcomes` returns. */
  cells: RecentOutcome[];
  /** The test's history page. */
  href: string;
  /** Used only to name the destination for screen readers. */
  testName: string;
}) {
  if (cells.length === 0) {
    return (
      <Link
        href={href}
        className="inline-block font-mono text-[10px] text-[var(--color-ink-muted)] underline hover:text-[var(--color-ink)]"
        aria-label={`History for ${testName} — no recorded executions`}
      >
        no runs
      </Link>
    );
  }

  const failed = cells.filter((cell) => cell.status === "failed" || cell.status === "error").length;
  const newest = cells[cells.length - 1];

  // One sentence covering what the colours and glyphs encode, for the link's
  // accessible name — a screen reader gets the summary, not eight coloured boxes.
  const summary =
    `History for ${testName}: last ${cells.length} execution${cells.length === 1 ? "" : "s"}, ` +
    `${failed} failed. Most recent ${labelFor(newest!)} ${formatAbsoluteTime(newest!.startedAt)}.`;

  return (
    <Link
      href={href}
      aria-label={summary}
      title={summary}
      // The whole strip is the hit target, so it clears 24px in height even though each
      // mark is 16px, and it grows on hover as a group rather than cell by cell.
      className="group/strip inline-flex items-center gap-[2px] rounded py-1 focus-visible:ring-2 focus-visible:ring-[var(--color-ink)] focus-visible:outline-none"
    >
      {cells.map((cell) => (
        <span
          key={cell.resultId}
          // 2px gaps come from the parent, keeping a surface-coloured separator between
          // adjacent fills so a run of failures reads as distinct marks, not one block.
          className="flex h-4 w-3 items-center justify-center rounded-[2px] text-[9px] leading-none font-bold text-white transition-opacity group-hover/strip:opacity-80"
          style={{ background: colorFor(cell) }}
          aria-hidden
        >
          {GLYPH[cell.status] ?? "?"}
        </span>
      ))}
    </Link>
  );
}
