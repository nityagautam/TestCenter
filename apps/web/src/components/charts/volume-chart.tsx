"use client";

import { formatInteger } from "@/lib/format";

import { useId, useState } from "react";

/**
 * Daily test volume by outcome, as stacked columns.
 *
 * Status colours are the right choice here — passed/failed genuinely mean good/bad,
 * which is exactly what the reserved tokens are for. But status-good and
 * status-critical are only ΔE 4.1 apart under deuteranopia, so colour alone cannot
 * carry the distinction. Three secondary encodings do:
 *
 *   1. fixed segment order (failed at the bottom, always) so position means something
 *   2. a 2px surface gap between segments, so boundaries are visible without hue
 *   3. counts as text in the tooltip and the accompanying legend totals
 *
 * Removing any of those makes this chart unreadable for red-green colourblind users.
 */
export interface VolumeDay {
  label: string;
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  runs: number;
}

const SEGMENTS = [
  { key: "failed", label: "Failed", color: "var(--color-status-failed)" },
  { key: "flaky", label: "Flaky", color: "var(--color-status-flaky)" },
  { key: "passed", label: "Passed", color: "var(--color-status-passed)" },
  { key: "skipped", label: "Skipped", color: "var(--color-status-skipped)" },
] as const;

export function VolumeChart({
  days,
  title,
  height = 160,
  mode = "counts",
  shape = "columns",
  action,
}: {
  days: VolumeDay[];
  title: string;
  height?: number;
  /** Rendered opposite the caption — the view toggle, where there is one. */
  action?: React.ReactNode;
  /**
   * `counts` answers "how much did we run"; `share` normalises every column to 100% and
   * answers "what proportion failed", which is the question volume otherwise hides — a
   * day with twice the tests and the same failure rate looks worse in counts and
   * identical in share. Two questions, not two drawings of one.
   */
  mode?: "counts" | "share";
  /**
   * `columns` for discrete buckets you compare one against the next; `area` for a long
   * window read as a continuous shape.
   *
   * The trade is real rather than stylistic. Columns keep the 2px surface gap between
   * segments, which is one of the three encodings that carry status without hue — an area
   * chart physically cannot have gaps, because the bands share an edge. The area form
   * replaces that encoding with a solid boundary stroke in each band's own colour, so the
   * boundaries stay visible under deuteranopia; the fixed order and the legend totals are
   * unchanged. Below about thirty points columns are still the better answer, since
   * individual days are what you are comparing.
   */
  shape?: "columns" | "area";
}) {
  const [hover, setHover] = useState<number | null>(null);
  const gradientId = useId();

  const totals = days.map((day) => day.passed + day.failed + day.skipped);
  const max = Math.max(...totals, 1);

  if (days.length === 0) {
    return (
      <figure>
        {/* See the note on TrendChart: the toggle outlives the data. */}
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <figcaption className="text-xs font-medium">{title}</figcaption>
          {action}
        </div>
        <div
          className="flex items-center justify-center rounded-md border border-[var(--color-border-subtle)] text-[11px] text-[var(--color-ink-muted)]"
          style={{ height }}
        >
          No runs in this period
        </div>
      </figure>
    );
  }

  const grandTotals = SEGMENTS.map((segment) => ({
    ...segment,
    total: days.reduce((sum, day) => sum + day[segment.key], 0),
  }));

  return (
    <figure className="min-w-0">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <figcaption className="min-w-0 truncate text-xs font-medium">{title}</figcaption>
        {action}
        <span className="ml-auto font-mono text-xs text-[var(--color-ink-muted)] tabular-nums">
          {mode === "share"
            ? "0–100%"
            : `${formatInteger(totals.reduce((sum, value) => sum + value, 0))} tests`}
        </span>
      </div>

      <div className="relative" style={{ height }}>
        {/* An area needs two points to be an area. One day falls back to a column rather
            than drawing a degenerate sliver. */}
        {shape === "area" && days.length > 1 ? (
          <StackedArea
            days={days}
            max={max}
            mode={mode}
            hover={hover}
            gradientId={gradientId}
            onHover={setHover}
          />
        ) : (
          <div className="flex h-full items-end gap-[2px]">
            {days.map((day, index) => {
              const total = day.passed + day.failed + day.skipped;
              // Flaky tests also passed, so they are drawn as a slice of the passed block
              // rather than added on top — otherwise the column would exceed the real total.
              const stack = [
                { key: "failed" as const, value: day.failed },
                { key: "flaky" as const, value: Math.min(day.flaky, day.passed) },
                { key: "passed" as const, value: Math.max(day.passed - day.flaky, 0) },
                { key: "skipped" as const, value: day.skipped },
              ];

              return (
                <button
                  /*
                   * Keyed by position, not by label.
                   *
                   * The label is not unique and was never guaranteed to be. On the daily series
                   * it happens to be a date, so it looked like an id; on the "Today" chart it is
                   * a clock time, and two runs finishing in the same minute produce two columns
                   * called "08:08" — React then warns and is free to drop one of them, silently
                   * losing a run from the chart. Position *is* the identity here: `days` is an
                   * ordered series where the nth column is the nth interval, and reordering it
                   * would mean a different chart rather than the same columns rearranged.
                   */
                  key={index}
                  type="button"
                  className="group relative flex h-full min-w-0 flex-1 cursor-default flex-col justify-end"
                  onMouseEnter={() => setHover(index)}
                  onFocus={() => setHover(index)}
                  onMouseLeave={() => setHover(null)}
                  onBlur={() => setHover(null)}
                  aria-label={`${day.label}: ${total} tests, ${day.failed} failed, ${day.passed} passed, ${day.skipped} skipped across ${day.runs} runs`}
                >
                  <span
                    className="flex w-full flex-col-reverse justify-start"
                    style={{
                      // In share mode every column is full height, so the segments read as
                      // proportions of that day rather than of the busiest day.
                      height:
                        total === 0 ? "0%" : mode === "share" ? "100%" : `${(total / max) * 100}%`,
                      maxWidth: 24,
                      margin: "0 auto",
                    }}
                  >
                    {stack.map((segment, segmentIndex) => {
                      if (segment.value <= 0) return null;
                      const spec = SEGMENTS.find((entry) => entry.key === segment.key)!;
                      const isTop = stack.slice(segmentIndex + 1).every((rest) => rest.value <= 0);
                      return (
                        <span
                          key={segment.key}
                          data-chart-segment
                          className="w-full"
                          style={{
                            height: `${(segment.value / total) * 100}%`,
                            background: spec.color,
                            // 4px rounded data-end, square at the baseline.
                            borderTopLeftRadius: isTop ? 4 : 0,
                            borderTopRightRadius: isTop ? 4 : 0,
                            // The 2px surface gap is what separates segments — never a stroke.
                            marginTop: segmentIndex === 0 ? 0 : 2,
                            opacity: hover === null || hover === index ? 1 : 0.45,
                          }}
                        />
                      );
                    })}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {hover !== null && days[hover] ? (
          <div
            className="pointer-events-none absolute -top-1 z-10 -translate-x-1/2 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1.5 shadow-md"
            style={{ left: `${((hover + 0.5) / days.length) * 100}%` }}
          >
            <div className="mb-1 font-mono text-[10px] whitespace-nowrap text-[var(--color-ink-muted)]">
              {days[hover]?.label} · {days[hover]?.runs} run(s)
            </div>
            {SEGMENTS.map((segment) => {
              const value = days[hover]?.[segment.key] ?? 0;
              if (value === 0) return null;
              return (
                <div key={segment.key} className="flex items-center gap-1.5 whitespace-nowrap">
                  <span
                    className="inline-block size-2 shrink-0 rounded-sm"
                    style={{ background: segment.color }}
                    aria-hidden
                  />
                  <span className="text-[10px] text-[var(--color-ink-muted)]">{segment.label}</span>
                  <span className="ml-auto font-mono text-[10px] tabular-nums">{value}</span>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>

      <div className="mt-1 flex justify-between font-mono text-[10px] text-[var(--color-ink-muted)]">
        <span>{days[0]?.label}</span>
        <span>{days.at(-1)?.label}</span>
      </div>

      {/* Legend is always present for multiple series, and doubles as the table view:
          each label carries its own total, so the numbers exist without colour. */}
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {grandTotals.map((segment) => (
          <li key={segment.key} className="flex items-center gap-1.5">
            <span
              className="inline-block size-2 rounded-sm"
              style={{ background: segment.color }}
              aria-hidden
            />
            <span className="text-[10px] text-[var(--color-ink-muted)]">{segment.label}</span>
            <span className="font-mono text-[10px] tabular-nums">
              {formatInteger(segment.total)}
            </span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

/**
 * The same stack, drawn as bands instead of columns.
 *
 * Bottom-to-top order is the fixed one, so a reader who learned the columns reads this
 * identically: failed sits on the baseline, skipped on top. Each band is filled with a
 * vertical gradient — solid at its own upper boundary, fading toward the band below — which
 * is what gives the chart depth without inventing a second encoding. The gradient is
 * decoration; the boundary stroke above it is not.
 *
 * `preserveAspectRatio="none"` stretches the 100×100 viewBox to the container, so every
 * stroke here is `vectorEffect="non-scaling-stroke"`. Without it a 1px line is drawn 1px
 * tall and four pixels wide, and the boundaries look like they were painted with a roller.
 */
function StackedArea({
  days,
  max,
  mode,
  hover,
  gradientId,
  onHover,
}: {
  days: VolumeDay[];
  max: number;
  mode: "counts" | "share";
  hover: number | null;
  gradientId: string;
  onHover: (index: number | null) => void;
}) {
  const step = 100 / (days.length - 1);

  /*
   * Cumulative boundaries, computed once per band.
   *
   * In share mode each day is divided by its own total rather than by the window's maximum,
   * so every column reaches the top and the bands read as proportions of that day. A day
   * with no results at all divides by 1 and collapses to the baseline, which is honest: it
   * has no proportions to show.
   */
  const bands = SEGMENTS.map((segment, segmentIndex) => {
    const upper: string[] = [];
    const lower: string[] = [];

    days.forEach((day, index) => {
      const total = day.passed + day.failed + day.skipped;
      const stack = [
        day.failed,
        Math.min(day.flaky, day.passed),
        Math.max(day.passed - day.flaky, 0),
        day.skipped,
      ];
      const denominator = mode === "share" ? total || 1 : max;
      const below = stack.slice(0, segmentIndex).reduce((sum, value) => sum + value, 0);
      const through = below + (stack[segmentIndex] ?? 0);
      const x = index * step;
      upper.push(`${index === 0 ? "M" : "L"}${x},${100 - (through / denominator) * 100}`);
      lower.push(`L${x},${100 - (below / denominator) * 100}`);
    });

    return {
      ...segment,
      // Out along the top of the band, back along the bottom of it.
      fill: `${upper.join(" ")} ${lower.reverse().join(" ")} Z`,
      edge: upper.join(" "),
    };
  });

  return (
    <>
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="size-full"
        role="img"
        aria-label={`Tests by outcome across ${days.length} days, stacked: failed, flaky, passed, skipped. Totals are listed in the legend below.`}
      >
        <defs>
          {bands.map((band) => (
            <linearGradient
              key={band.key}
              id={`${gradientId}-${band.key}`}
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop offset="0%" stopColor={band.color} stopOpacity="0.75" />
              <stop offset="100%" stopColor={band.color} stopOpacity="0.25" />
            </linearGradient>
          ))}
        </defs>

        {[0, 50, 100].map((y) => (
          <line
            key={y}
            x1="0"
            y1={y}
            x2="100"
            y2={y}
            stroke="var(--color-grid)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {bands.map((band) => (
          <path key={band.key} d={band.fill} fill={`url(#${gradientId}-${band.key})`} />
        ))}

        {/*
         * The boundary strokes, in each band's own colour.
         *
         * This is the encoding that replaces the columns' 2px surface gap. Bands in a
         * stacked area share an edge, so without a stroke the only thing separating passed
         * from failed is a hue difference of 4.1 ΔE under deuteranopia — which is to say,
         * nothing. Drawn after every fill so no band's gradient covers the edge below it.
         */}
        {bands.map((band) => (
          <path
            key={band.key}
            d={band.edge}
            fill="none"
            stroke={band.color}
            strokeWidth="1.5"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {hover !== null ? (
          <line
            x1={hover * step}
            y1="0"
            x2={hover * step}
            y2="100"
            stroke="var(--color-ink-muted)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
      </svg>

      {/* Hit targets are separate from the marks, because a band four pixels tall on a quiet
          day is impossible to hover and every day must stay reachable. */}
      <div className="absolute inset-0 flex">
        {days.map((day, index) => (
          <button
            key={index}
            type="button"
            className="h-full flex-1 cursor-default"
            onMouseEnter={() => onHover(index)}
            onFocus={() => onHover(index)}
            onMouseLeave={() => onHover(null)}
            onBlur={() => onHover(null)}
            aria-label={`${day.label}: ${day.passed + day.failed + day.skipped} tests, ${day.failed} failed, ${day.passed} passed, ${day.skipped} skipped across ${day.runs} runs`}
          />
        ))}
      </div>
    </>
  );
}
