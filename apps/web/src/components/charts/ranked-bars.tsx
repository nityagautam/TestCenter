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

export function RankedBars({
  bars,
  title,
  action,
  emptyMessage = "Nothing to show yet.",
  footnote,
  color = "var(--color-series-1)",
  domainMax,
}: {
  bars: RankedBar[];
  title: string;
  action?: React.ReactNode;
  emptyMessage?: string;
  footnote?: string;
  color?: string;
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
        <ol className="space-y-1.5">
          {bars.map((bar) => {
            const label = (
              <span className="block truncate text-[11px]" title={bar.label}>
                {bar.label}
              </span>
            );
            return (
              <li key={`${bar.label}-${bar.display}`} className="min-w-0">
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
                  <span className="shrink-0 font-mono text-[11px] tabular-nums">{bar.display}</span>
                </div>
                {/* 6px track, 3px radius on the data end. A zero-value row still shows a
                    hairline so the row does not look like it failed to render. */}
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface)]">
                  <div
                    className="h-full rounded-full"
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
      )}

      {footnote ? (
        <p className="mt-2 text-[10px] leading-relaxed text-[var(--color-ink-muted)]">{footnote}</p>
      ) : null}
    </figure>
  );
}
