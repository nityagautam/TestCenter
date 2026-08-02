import Link from "next/link";

/**
 * Ranked horizontal bars — "compare magnitude, low → high".
 *
 * Horizontal because the categories are test names: vertical columns would either
 * truncate them to nothing or rotate the labels, and rotated labels are unreadable at
 * this size. Ordered descending so the answer is the first row.
 *
 * One flat hue, not a value ramp. Bar length already encodes the magnitude; colouring by
 * the same number would double-encode it and spend the only free channel on information
 * the geometry already carries — the same reason `TrendChart` uses one colour per series.
 *
 * Every value is direct-labelled, so nothing has to be hovered to be read. The `title`
 * carries the untruncated label for the cases where the name does not fit, which is the
 * browser's own hover layer and costs no client JavaScript — this renders on the server.
 */
export interface RankedBar {
  label: string;
  /** Drives the bar length. */
  value: number;
  /** What to print at the end of the bar, e.g. "1.4s" or "6 (19%)". */
  display: string;
  /** Optional second line under the label. */
  detail?: string | null;
  href?: string;
  /** Overrides the chart colour for this bar, e.g. a pass-rate health tone. */
  color?: string;
}

/**
 * Row height, in rem so it tracks the root font size — a reader who has scaled their text up
 * gets whole rows, not rows and a sliver.
 *
 * Two constants because there are two row shapes. A plain row is an 11px label, a 4px gap, a
 * 6px track and the 6px list gap; a row with a `detail` line carries a second 10px line
 * between the two. Deriving one height and applying it to both was the previous behaviour,
 * and it clipped the detailed lists mid-row — the pass-rate-by-branch chart is exactly that
 * case, since every branch names its run count underneath.
 */
const ROW_HEIGHT_REM = 2.3;
/*
 * Slightly more than a detailed row actually measures (45.5px against 3.45rem ≈ 55px), so the
 * box ends part-way through the next row instead of flush against the last visible one.
 *
 * That overshoot is the affordance. Measured at exactly three rows the list ended cleanly and
 * looked like a list of three — and macOS hides overlay scrollbars until you scroll, so there
 * was nothing at all to say four more branches were below. A half-row of something cut off is
 * what tells a reader to scroll.
 */
const ROW_WITH_DETAIL_HEIGHT_REM = 3.45;

export function RankedBars({
  bars,
  title,
  action,
  emptyMessage = "Nothing to show yet.",
  footnote,
  color = "var(--color-series-1)",
  maxVisible,
  domainMax,
}: {
  bars: RankedBar[];
  title: string;
  action?: React.ReactNode;
  emptyMessage?: string;
  footnote?: string;
  color?: string;
  /**
   * Show this many rows and scroll the rest.
   *
   * A ranking is answered by its first few rows — the whole point of ordering by magnitude is
   * that the answer is at the top — but the tail is what tells you whether the problem is one
   * bad test or forty mediocre ones. Truncating to six hid that; showing forty buried the
   * answer under a wall of bars. Five visible with the rest a scroll away keeps both.
   *
   * The height is derived from a row rather than measured, which is safe because the rows in
   * any one list are uniform — every bar either carries a `detail` line or none does, so the
   * taller constant is picked for the whole list rather than per row.
   *
   * A sliver of the next row stays visible on purpose. A list clipped exactly at a row
   * boundary looks like a list that simply ends, and nobody scrolls something they cannot
   * tell is scrollable.
   */
  maxVisible?: number;
  /**
   * Fixes the axis instead of scaling to the largest bar.
   *
   * Required whenever the value is a ratio against a known limit. Pass rates of 96% and
   * 90% scaled to their own maximum become a full bar and a 94% bar — a 6-point gap drawn
   * as a 6-point gap of the *remaining* range, which reads as a chasm. On a fixed 0–100
   * track they look like what they are: two nearly-healthy branches.
   */
  domainMax?: number;
}) {
  // Otherwise scaled to the largest bar: for a ranking, the comparison that matters is
  // between the rows rather than against an absolute ceiling.
  const max = domainMax ?? Math.max(...bars.map((bar) => bar.value), 1);
  const scrolls = maxVisible !== undefined && bars.length > maxVisible;
  // A list is detailed or it is not; the rows within one are the same shape either way.
  const rowHeightRem = bars.some((bar) => bar.detail) ? ROW_WITH_DETAIL_HEIGHT_REM : ROW_HEIGHT_REM;

  return (
    <figure className="min-w-0">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <figcaption className="text-xs font-medium">{title}</figcaption>
        {action}
      </div>

      {bars.length === 0 ? (
        <p className="rounded-md border border-[var(--color-border-subtle)] px-3 py-6 text-center text-[11px] text-[var(--color-ink-muted)]">
          {emptyMessage}
        </p>
      ) : (
        /*
         * Focusable when it scrolls, and only then.
         *
         * A scrollable region that cannot be reached by keyboard is unreachable content — the
         * pointer is not the only way people read a list. `tabIndex={0}` makes the arrow keys
         * work; the label says what is being scrolled, since "list" alone is useless when
         * three of these sit side by side. When everything fits there is nothing to scroll and
         * an extra tab stop would be pure noise.
         */
        <div
          {...(scrolls
            ? {
                tabIndex: 0,
                role: "region" as const,
                "aria-label": `${title} — scrollable, ${bars.length} rows`,
                style: { maxHeight: `${maxVisible! * rowHeightRem}rem` },
              }
            : {})}
          /* `pr-1` went with the scrollbar it was making room for; with the bar hidden
             that padding would just narrow the bars for no reason. */
          className={scrolls ? "tc-no-scrollbar overflow-y-auto" : undefined}
        >
          <ol className="space-y-1.5">
            {bars.map((bar) => {
              const label = (
                <span className="block truncate text-[11px]" title={bar.label}>
                  {bar.label}
                </span>
              );
              return (
                /*
                 * Hover feedback in CSS, so this stays a server component.
                 *
                 * The obvious way to highlight a row is `useState`, and it would cost this
                 * chart its zero-JavaScript rendering — it appears three times on the
                 * dashboard and again in every report panel. A `group` with `hover:` variants
                 * gives the same affordance for nothing, because the only state involved is
                 * "the pointer is here", which CSS already tracks.
                 */
                <li
                  key={`${bar.label}-${bar.display}`}
                  className="group/bar -mx-1.5 min-w-0 rounded px-1.5 py-0.5 transition-colors hover:bg-[var(--color-surface)]"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 flex-1">
                      {bar.href ? (
                        <Link href={bar.href} className="block min-w-0 hover:underline">
                          {label}
                        </Link>
                      ) : (
                        label
                      )}
                      {bar.detail ? (
                        <span className="block truncate font-mono text-[10px] text-[var(--color-ink-muted)]">
                          {bar.detail}
                        </span>
                      ) : null}
                    </span>
                    {/* Text keeps an ink token rather than the mark colour: the bar beside
                      it already carries the identity. */}
                    <span className="shrink-0 font-mono text-[11px] tabular-nums">
                      {bar.display}
                    </span>
                  </div>
                  {/* 6px track, 3px radius on the data end. A zero-value row still shows a
                    hairline so the row does not look like it failed to render. */}
                  <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-border-subtle)]/40">
                    <div
                      // Grows to 2.5px on hover rather than changing colour: the colour is the
                      // series identity and must not shift to mean "hovered".
                      className="h-full rounded-full transition-[height] group-hover/bar:h-[2.5px]"
                      style={{
                        width: `${Math.max(Math.min((bar.value / max) * 100, 100), bar.value > 0 ? 2 : 0.5)}%`,
                        background: bar.color ?? color,
                      }}
                    />
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {footnote ? (
        <p className="mt-2 text-[10px] leading-relaxed text-[var(--color-ink-muted)]">{footnote}</p>
      ) : null}
    </figure>
  );
}
