import type { ReactNode } from "react";

/**
 * One run's composition as a ring — "what is this run made of".
 *
 * Deliberately scoped to a *single* run. A donut answers "parts of one whole" and nothing
 * else: it cannot show change, cannot be compared with the donut beside it, and degrades
 * badly past four or five slices. That is exactly the question "how did the last run go?"
 * asks, and exactly why nothing aggregated over the window is drawn this way — `ResultBar`
 * covers composition inside a list row, `VolumeChart` covers composition over time, and
 * neither is replaced by this.
 *
 * Chosen over a single stacked bar for one reason: this card is a glance destination rather
 * than a row in a table. The ring gives the centre back as a place to put the total, which
 * is the number people actually read first, and the legend then carries every count as text
 * beside its share.
 *
 * Server component — pure SVG, no client JavaScript. Nothing here is hover-only.
 */

/** The fixed order every stacked thing in this app uses. Never sorted by size. */
const SEGMENTS = [
  { key: "failed", label: "Fail", color: "var(--color-status-failed)" },
  { key: "flaky", label: "Flaky", color: "var(--color-status-flaky)" },
  { key: "passed", label: "Pass", color: "var(--color-status-passed)" },
  { key: "skipped", label: "Skipped", color: "var(--color-status-skipped)" },
] as const;

const RADIUS = 42;
const STROKE = 14;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * The 2px surface gap between segments, in path units.
 *
 * Same rule as the stacked bars: adjacent fills need a separator or a run of red reads as
 * one mark. Under deuteranopia the passed and failed tokens are 4.1 ΔE apart, so the gap is
 * doing real work rather than decorating.
 */
const GAP = 2;

/** A non-zero slice never disappears — "1 failure" must not render as nothing. */
const MIN_ARC = 1.5;

export function OutcomeDonut({
  title,
  passed,
  failed,
  skipped,
  flaky = 0,
  action,
  footnote,
  emptyMessage = "No results in this run.",
}: {
  title: string;
  /**
   * As everywhere else in this app, `flaky` is a *subset* of `passed` — a test that failed
   * and then passed on a retry is a pass that needed help. The ring splits them so the four
   * slices are disjoint and the percentages total 100; the pass slice is `passed - flaky`.
   * Getting this wrong double-counts the flakes and the ring silently overruns.
   */
  passed: number;
  failed: number;
  skipped: number;
  flaky?: number;
  action?: ReactNode;
  footnote?: string;
  emptyMessage?: string;
}) {
  const total = passed + failed + skipped;
  const values: Record<string, number> = {
    failed,
    flaky: Math.min(flaky, passed),
    passed: Math.max(passed - flaky, 0),
    skipped,
  };

  const present = SEGMENTS.filter((segment) => (values[segment.key] ?? 0) > 0);

  if (total === 0) {
    return (
      <figure className="min-w-0">
        <Caption title={title} action={action} />
        <p className="rounded-md border border-[var(--color-border-subtle)] px-3 py-6 text-center text-[11px] text-[var(--color-ink-muted)]">
          {emptyMessage}
        </p>
      </figure>
    );
  }

  const share = (value: number): number => (value / total) * 100;

  /*
   * Arcs are laid out by accumulating the *true* share and drawing slightly less of it.
   *
   * Subtracting the gap from each drawn length while advancing the offset by the full share
   * keeps every boundary in its correct angular position — shortening the advance instead
   * would let rounding walk the last segment off the end of the ring.
   *
   * A single slice gets no gap at all: a 100%-passed run drawn with a 2px notch in it looks
   * like a rendering fault, and there is no neighbour to separate it from.
   */
  let offset = 0;
  const arcs = present.map((segment) => {
    const value = values[segment.key] ?? 0;
    const full = (value / total) * CIRCUMFERENCE;
    const drawn = present.length === 1 ? full : Math.max(full - GAP, MIN_ARC);
    const arc = { ...segment, value, drawn, offset };
    offset += full;
    return arc;
  });

  // One sentence for the ring, because a screen reader should get the summary rather than
  // four unlabelled arcs. The legend below repeats it as text for everyone else.
  const summary = `${total} test${total === 1 ? "" : "s"}: ${present
    .map((segment) => `${values[segment.key]} ${segment.label.toLowerCase()}`)
    .join(", ")}.`;

  return (
    <figure className="min-w-0">
      <Caption title={title} action={action} />

      {/*
       * Ring left, legend right, and deliberately not `flex-wrap`.
       *
       * Wrapping put the legend under the ring the moment the card narrowed, which is its
       * normal width in a three- or four-up row — so the "side by side" layout was the one
       * nobody ever saw. The ring is a fixed square and the legend is the only flexible
       * thing here, so `min-w-0` on it is what lets the pair shrink instead of overflowing:
       * a flex item defaults to `min-width:auto` and refuses to go below min-content.
       */}
      <div className="flex items-center gap-4">
        <div className="relative shrink-0">
          <svg viewBox="0 0 100 100" className="size-28" role="img" aria-label={summary}>
            {/* Track, so a ring made of thin slices still reads as a ring. */}
            <circle
              cx="50"
              cy="50"
              r={RADIUS}
              fill="none"
              strokeWidth={STROKE}
              style={{ stroke: "var(--color-surface)" }}
            />
            {/* -90° puts the first segment at twelve o'clock; without it the ring starts at
                three and the fixed order stops being legible as an order. */}
            <g transform="rotate(-90 50 50)">
              {arcs.map((arc) => (
                <circle
                  key={arc.key}
                  cx="50"
                  cy="50"
                  r={RADIUS}
                  fill="none"
                  strokeWidth={STROKE}
                  strokeDasharray={`${arc.drawn} ${CIRCUMFERENCE - arc.drawn}`}
                  strokeDashoffset={-arc.offset}
                  style={{ stroke: arc.color }}
                />
              ))}
            </g>
          </svg>
          {/* The total, in the hole the ring gives you for free. Centred over the SVG rather
              than drawn as <text> so it inherits the page's font and tabular numerals. */}
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="font-mono text-xl font-semibold tabular-nums">{total}</span>
            <span className="text-[10px] tracking-widest text-[var(--color-ink-muted)] uppercase">
              {total === 1 ? "test" : "tests"}
            </span>
          </div>
        </div>

        {/*
         * The legend is the chart's accessible fallback and its data table at once, which is
         * why it lists every present slice with both the count and the share. Kept in the
         * fixed segment order rather than sorted by size, so it reads in the same order as
         * the ring and as every stacked bar elsewhere.
         */}
        <dl className="min-w-0 flex-1 space-y-1.5">
          {present.map((segment) => {
            const value = values[segment.key] ?? 0;
            return (
              <div key={segment.key} className="flex items-baseline gap-2">
                <span
                  className="size-2.5 shrink-0 translate-y-[1px] rounded-[2px]"
                  style={{ background: segment.color }}
                  aria-hidden
                />
                <dt className="min-w-0 flex-1 truncate text-[11px]">{segment.label}</dt>
                {/* Counts right-aligned so they form a column the eye can compare down,
                    rather than starting at a different x on every row. */}
                <dd className="shrink-0 font-mono text-[11px] font-medium tabular-nums">{value}</dd>
                <dd className="w-11 shrink-0 text-right font-mono text-[11px] text-[var(--color-ink-muted)] tabular-nums">
                  {share(value).toFixed(1)}%
                </dd>
              </div>
            );
          })}
        </dl>
      </div>

      {footnote ? (
        <p className="mt-2 text-[10px] leading-relaxed text-[var(--color-ink-muted)]">{footnote}</p>
      ) : null}
    </figure>
  );
}

function Caption({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-2">
      <figcaption className="text-xs font-medium">{title}</figcaption>
      {action}
    </div>
  );
}
