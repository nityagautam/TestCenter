"use client";

import Link from "next/link";
import { smoothPath, type Point } from "@/components/charts/curve";
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
  /** Second tooltip line — the run's name and branch, where a point is one execution. */
  detail?: string;
  /** Where the point goes when clicked. A point that *is* a run should open that run. */
  href?: string;
  /**
   * A cell in the strip under the chart — currently the run's verdict.
   *
   * Carried on the point rather than passed as a parallel array so the two cannot fall out
   * of alignment: there is no way to have a ribbon cell without the point it belongs to.
   */
  ribbon?: { color: string; label: string };
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  runs: number;
}

/** Wide enough for a five-digit count at 10px, which is more than a run will hold. */
const AXIS_WIDTH = 34;

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

  /*
   * The axis stops above the data, not on it.
   *
   * A tallest column that touches the top of the plot reads as clipped — the eye cannot tell
   * whether the series peaked there or ran off the chart. Ten test cases of headroom is
   * enough to show the gap at the volumes a single run produces, and vanishes into rounding
   * at the volumes where it would not matter.
   *
   * Share mode ignores it: the ceiling there is 100% by definition, and "110%" would be a
   * scale that cannot be reached.
   */
  const ceiling = mode === "share" ? 100 : max + 10;

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

  /*
   * The vertical position of the hovered point, so the tooltip can get out of its way.
   *
   * Mirrors the dot placement exactly — top of the stack in counts mode, the failure share
   * in share mode — because a tooltip that flips around a *different* point than the one
   * being marked is worse than one that never moves.
   */
  const pointY = (index: number): number => {
    const day = days[index];
    if (!day) return 0;
    const total = day.passed + day.failed + day.skipped;
    if (mode === "share") return shape === "area" ? 100 - (day.failed / (total || 1)) * 100 : 0;
    return 100 - (total / ceiling) * 100;
  };

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

      <div className="flex" style={{ height }}>
        {/*
         * The value axis, in test cases.
         *
         * Three labels against the three gridlines the area already draws, so the reader can
         * read a magnitude off the chart instead of hovering for it. It is the count of test
         * *results* in a run — the same number the header states for the whole window — and
         * it is stated rather than implied because a stacked chart with no scale can only be
         * compared with itself.
         */}
        <div
          className="flex shrink-0 flex-col justify-between pr-1.5 text-right font-mono text-[10px] text-[var(--color-ink-muted)] tabular-nums"
          style={{ width: AXIS_WIDTH }}
          aria-hidden
        >
          <span>{mode === "share" ? "100%" : formatInteger(ceiling)}</span>
          <span>{mode === "share" ? "50%" : formatInteger(Math.round(ceiling / 2))}</span>
          <span>0</span>
        </div>

        <div className="relative min-w-0 flex-1">
          {/* An area needs two points to be an area. One day falls back to a column rather
            than drawing a degenerate sliver. */}
          {shape === "area" && days.length > 1 ? (
            <StackedArea
              days={days}
              max={ceiling}
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
                          total === 0
                            ? "0%"
                            : mode === "share"
                              ? "100%"
                              : `${(total / ceiling) * 100}%`,
                        maxWidth: 24,
                        margin: "0 auto",
                      }}
                    >
                      {stack.map((segment, segmentIndex) => {
                        if (segment.value <= 0) return null;
                        const spec = SEGMENTS.find((entry) => entry.key === segment.key)!;
                        const isTop = stack
                          .slice(segmentIndex + 1)
                          .every((rest) => rest.value <= 0);
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
            /*
             * The tooltip flips to the other side of the point rather than sitting at a
             * fixed top.
             *
             * Pinned to the top of the plot it covered the very mark it was describing on
             * any high value — which is most of them on a healthy suite, where every run
             * sits near the ceiling. It now goes above the point when there is room and
             * below it when there is not, with a 14px gap either way, so the dot stays
             * visible and the pairing between mark and label is unambiguous.
             */
            <div
              className="pointer-events-none absolute z-10 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1.5 shadow-md"
              style={{
                left: `${Math.min(Math.max(((hover + 0.5) / days.length) * 100, 12), 88)}%`,
                top: `calc(${pointY(hover)}% + ${pointY(hover) < 42 ? 14 : -14}px)`,
                transform: pointY(hover) < 42 ? "translate(-50%, 0)" : "translate(-50%, -100%)",
              }}
            >
              <div className="mb-1 font-mono text-[10px] whitespace-nowrap text-[var(--color-ink-muted)]">
                {days[hover]?.label}
                {/* One execution per point needs the run's identity, not a count of one. */}
                {days[hover]?.detail
                  ? ` · ${days[hover]?.detail}`
                  : ` · ${days[hover]?.runs} run(s)`}
              </div>
              {days[hover]?.ribbon ? (
                <div className="mb-1 flex items-center gap-1.5 whitespace-nowrap">
                  <span
                    className="inline-block size-2 shrink-0 rounded-sm"
                    style={{ background: days[hover]?.ribbon?.color }}
                    aria-hidden
                  />
                  <span className="text-[10px] text-[var(--color-ink-muted)]">
                    {days[hover]?.ribbon?.label}
                  </span>
                </div>
              ) : null}
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
                    <span className="text-[10px] text-[var(--color-ink-muted)]">
                      {segment.label}
                    </span>
                    <span className="ml-auto font-mono text-[10px] tabular-nums">{value}</span>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      </div>

      {/*
       * The verdict ribbon: one cell per run, under the point it belongs to.
       *
       * It answers the question the outcome chart provokes and cannot answer — "we had a bad
       * week, but was any of it us?" A cluster of red points that is entirely orange down
       * here is an environment problem, and reading that off the chart takes one glance
       * instead of opening six runs.
       *
       * Four pixels tall, and drawn only when at least one run has been reviewed. An empty
       * strip of blue TODO under every chart would be noise on the dashboards of teams who
       * do not use verdicts — the feature has to earn its four pixels.
       */}
      {days.some((day) => day.ribbon) ? (
        <div className="mt-1.5 flex items-center" style={{ gap: 1, marginLeft: AXIS_WIDTH }}>
          {days.map((day, index) => (
            <span
              key={index}
              className="h-1 min-w-0 flex-1 rounded-[1px]"
              style={{
                background: day.ribbon?.color ?? "var(--color-border-subtle)",
                opacity: hover === null || hover === index ? 1 : 0.4,
              }}
              aria-hidden
            />
          ))}
        </div>
      ) : null}

      {/*
       * Six evenly spaced ticks, not two and not ten.
       *
       * Two labels was enough when a point was a day and the reader could interpolate. With
       * one point per run the spacing is irregular — five runs on Tuesday, none on Sunday —
       * so the axis has to be sampled or nothing between the ends can be placed.
       *
       * Ten was too many, which only a screenshot showed: a `Mon DD HH:MM` label is about
       * 70px, and ten centred on their ticks across a 700px plot collide into
       * `Jul 27J02:20 07:19`. Six fits with air between them. First and last are always
       * included, so the window's bounds stay stated whatever the count.
       */}
      <div className="relative mt-1 h-3" style={{ marginLeft: AXIS_WIDTH }}>
        {axisTicks(days.length).map((tick) => (
          <span
            key={tick}
            className="absolute font-mono text-[10px] whitespace-nowrap text-[var(--color-ink-muted)]"
            style={{
              left: `${(tick / Math.max(days.length - 1, 1)) * 100}%`,
              // The end labels would overhang the plot and be clipped by the card, so they
              // anchor to their own edge instead of their centre.
              transform:
                tick === 0
                  ? "none"
                  : tick === days.length - 1
                    ? "translateX(-100%)"
                    : "translateX(-50%)",
            }}
          >
            {days[tick]?.label}
          </span>
        ))}
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
    const upper: Point[] = [];
    const lower: Point[] = [];

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
      upper.push({ x, y: 100 - (through / denominator) * 100 });
      lower.push({ x, y: 100 - (below / denominator) * 100 });
    });

    /*
     * Both boundaries are smoothed, and they must be smoothed the same way.
     *
     * Curving only the top would let a band's fill drift away from the band beneath it and
     * open a sliver of background between two areas that are, by definition, adjacent. The
     * monotone fit also matters more here than on a single line: a stacked band cannot be
     * allowed to bulge below its own lower boundary, which is what an overshooting spline
     * does on a day that drops to zero.
     */
    return {
      ...segment,
      // Out along the top of the band, back along the bottom of it.
      fill: `${smoothPath(upper)} ${smoothPath([...lower].reverse(), "L")} Z`,
      edge: smoothPath(upper),
    };
  });

  /*
   * Dots are dropped above a threshold rather than shrunk to nothing.
   *
   * At three hundred runs in a 600px card the points are two pixels apart, so a dot per
   * point is a solid band that hides the very curve it is annotating. Past that density the
   * marks stop being marks; the hover dot still appears, so an individual run is never
   * unreachable, and the shape is what the reader is there for anyway.
   */
  const dense = days.length > 80;
  const dotSize = days.length > 40 ? 3 : days.length > 20 ? 4 : 5;
  const dots = (dense ? days.filter((_, index) => index === hover) : days).map((day) => {
    const index = days.indexOf(day);
    const total = day.passed + day.failed + day.skipped;
    const denominator = mode === "share" ? total || 1 : max;
    const value = mode === "share" ? day.failed : total;
    return {
      index,
      x: index * step,
      y: 100 - (value / denominator) * 100,
      size: dotSize,
      color: mode === "share" ? "var(--color-status-failed)" : "var(--color-ink)",
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

      {/*
       * A dot per data point, positioned as HTML rather than drawn as <circle>.
       *
       * `preserveAspectRatio="none"` stretches the viewBox horizontally, so an SVG circle
       * renders as an ellipse whose eccentricity changes with the card width. The trend
       * chart's end marker solves it the same way: absolute positioning in the parent, where
       * a percentage is a percentage and a round dot stays round.
       *
       * In counts mode the dot sits on the top of the stack — the run's total. In share mode
       * that edge is always 100% and a flat row of dots would say nothing, so it marks the
       * failure share instead, which is the number that view exists to show.
       */}
      {dots.map((dot) => (
        <span
          key={dot.index}
          className="pointer-events-none absolute rounded-full transition-transform"
          style={{
            left: `${dot.x}%`,
            top: `${dot.y}%`,
            width: dot.size,
            height: dot.size,
            transform: `translate(-50%, -50%) scale(${hover === dot.index ? 1.6 : 1})`,
            background: dot.color,
            boxShadow: "0 0 0 1.5px var(--color-surface-raised)",
          }}
          aria-hidden
        />
      ))}

      {/* Hit targets are separate from the marks, because a band four pixels tall on a quiet
          day is impossible to hover and every point must stay reachable. Each one is a link
          when the point is a run: the question after "that run looks bad" is "show me it". */}
      <div className="absolute inset-0 flex">
        {days.map((day, index) => {
          const label = `${day.label}: ${day.passed + day.failed + day.skipped} tests, ${day.failed} failed, ${day.passed} passed, ${day.skipped} skipped${day.detail ? ` — ${day.detail}` : ""}${day.ribbon ? `. ${day.ribbon.label}` : ""}`;
          const handlers = {
            onMouseEnter: () => onHover(index),
            onFocus: () => onHover(index),
            onMouseLeave: () => onHover(null),
            onBlur: () => onHover(null),
          };
          return day.href ? (
            <Link
              key={index}
              href={day.href}
              className="h-full flex-1"
              aria-label={`${label}. Open this run.`}
              {...handlers}
            />
          ) : (
            <button
              key={index}
              type="button"
              className="h-full flex-1 cursor-default"
              aria-label={label}
              {...handlers}
            />
          );
        })}
      </div>
    </>
  );
}

/**
 * Evenly spaced tick indices, first and last always included.
 *
 * Returns fewer than `count` ticks for a short series rather than repeating an index, which
 * is what a naive `round(i * (n-1) / 9)` does when there are fewer than ten points.
 */
function axisTicks(length: number, count = 6): number[] {
  if (length <= 0) return [];
  if (length <= count) return Array.from({ length }, (_, index) => index);
  const last = length - 1;
  const ticks = Array.from({ length: count }, (_, index) =>
    Math.round((index * last) / (count - 1)),
  );
  return [...new Set(ticks)];
}
