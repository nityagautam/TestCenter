import { RUN_VERDICT_LABELS, type RunVerdict } from "@testcenter/core";

/**
 * A recorded verdict, shown wherever a run appears.
 *
 * Colour is assigned by what the verdict means for the reader, not by "good/bad": `pass`
 * is settled, `product-bug` is someone's problem, `infra` and `flaky` both mean "this red
 * is not the code", and `investigating` is unfinished. Two verdicts sharing a colour is
 * fine — the label is always present, so the colour is reinforcement rather than the
 * message. That matters here more than usual, because these are judgement calls someone
 * will act on and a misread one sends work to the wrong person.
 *
 * Distinct from `StatusBadge`, which reports what the runner observed. This reports what a
 * human concluded about it, and the two can legitimately disagree — a failed run with a
 * `pass` verdict is the normal case for accepted known failures.
 */
const TONE: Record<RunVerdict, string> = {
  pass: "bg-[var(--color-status-passed)]/12 text-[var(--color-status-passed)]",
  "product-bug": "bg-[var(--color-status-failed)]/12 text-[var(--color-status-failed)]",
  infra: "bg-[var(--color-series-2)]/12 text-[var(--color-series-2)]",
  flaky: "bg-[var(--color-status-flaky)]/15 text-[var(--color-status-flaky)]",
  investigating: "bg-[var(--color-status-skipped)]/15 text-[var(--color-ink-muted)]",
};

/**
 * The same assignments as `TONE`, as raw colour values.
 *
 * Kept immediately beside it, and not derived from it, because Tailwind resolves class
 * names at build time — `bg-[var(--color-status-passed)]/12` cannot be constructed from a
 * variable, so a single source would have to be the raw colour and every badge would lose
 * its opacity modifier. Two lists is the lesser evil, and adjacency is what keeps them
 * honest: a verdict added to one and not the other is visible in the same screenful.
 *
 * Used where a verdict has to be drawn rather than labelled — the ribbon under the outcome
 * chart, where a cell is four pixels tall and there is no room for a word.
 */
export const VERDICT_COLOR: Record<RunVerdict, string> = {
  pass: "var(--color-status-passed)",
  "product-bug": "var(--color-status-failed)",
  infra: "var(--color-series-2)",
  flaky: "var(--color-status-flaky)",
  investigating: "var(--color-status-skipped)",
};

/** Unreviewed. Blue, matching the badge: an open item, not a bad one. */
export const VERDICT_TODO_COLOR = "var(--color-series-1)";

export function VerdictBadge({
  verdict,
  size = "md",
}: {
  /**
   * A raw string from the database, or null for a run nobody has judged yet.
   *
   * Null renders as "TODO" rather than nothing. A blank space is ambiguous — it reads as
   * "reviewed and fine" just as easily as "nobody has looked" — and the whole point of
   * the feature is knowing which runs still need a human.
   *
   * TODO is *derived*, never stored: `run_verdicts` records what a person concluded, and
   * writing a machine row would put a NULL author in the audit trail and make "not yet
   * reviewed" indistinguishable from the `investigating` verdict, which specifically
   * means someone did look and has not finished.
   */
  verdict: string | null;
  size?: "sm" | "md";
}) {
  const sizing = size === "sm" ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-0.5 text-[11px]";

  if (verdict === null) {
    return (
      <span
        /*
         * Blue, and the only badge in the app that is blue.
         *
         * Every verdict already owns a hue — green for pass, red for product-bug, orange
         * for infra, amber for flaky, grey for investigating — so TODO needed one that is
         * unclaimed and, more importantly, carries no verdict of its own. An unreviewed
         * run is not a bad run; it is an open item. Blue says "your turn" where any of the
         * status colours would say "this went badly", which would be a lie about a run
         * nobody has looked at. Verified ≥3:1 against both the light and dark surfaces.
         *
         * The dashed border survives the recolour: it is what distinguishes "nothing has
         * been filled in" from the solid, filled badges that carry a real judgement.
         */
        className={`inline-flex shrink-0 items-center gap-1 rounded border border-dashed border-[var(--color-series-1)]/50 bg-[var(--color-series-1)]/10 font-medium whitespace-nowrap text-[var(--color-series-1)] ${sizing}`}
        title="No verdict recorded — nobody has reviewed this run yet"
      >
        <span className="opacity-70">verdict</span>
        TODO
      </span>
    );
  }

  const known = verdict in RUN_VERDICT_LABELS ? (verdict as RunVerdict) : null;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded font-medium whitespace-nowrap ${sizing} ${
        known ? TONE[known] : "bg-[var(--color-surface)] text-[var(--color-ink-muted)]"
      }`}
    >
      {/* Prefixed so it is never mistaken for the run's own status badge beside it. */}
      <span className="opacity-60">verdict</span>
      {known ? RUN_VERDICT_LABELS[known] : verdict}
    </span>
  );
}

/**
 * Whether a run is far enough along to deserve a TODO.
 *
 * A pending or parsing run has no results to judge yet, and its status badge already says
 * so. Marking it TODO would ask for a review of something that does not exist, and would
 * flicker to a real state seconds later.
 */
export function awaitsVerdict(status: string): boolean {
  return status === "complete" || status === "partial" || status === "failed";
}
