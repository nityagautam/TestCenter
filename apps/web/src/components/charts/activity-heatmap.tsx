"use client";

import { useState, type ReactNode } from "react";

/**
 * When runs start — hour of day across, weekday down.
 *
 * Every other chart on this page reads along time; this one folds it. The window's days are
 * collapsed onto seven rows, so four Tuesdays in a 30-day window land in the same row and
 * their counts add up. That is the point: a *rhythm* only becomes visible once repetitions
 * are stacked on top of one another. A nightly job at 02:00 is a vertical band down the
 * weekday rows, a weekly release is one bright cell, and people running suites by hand are
 * scatter through office hours.
 *
 * Hours across rather than down, which is the punchcard convention and not an arbitrary
 * choice: cells have to be square to be read as a matrix, and a square 24 × 7 grid is short
 * and wide — about 110px tall at full card width. The transpose is 7 × 24, which at the same
 * cell size is 360px of chart in a 100px-wide column, and at full width is 900px tall.
 * Squares decide the orientation.
 *
 * It also makes *absence* legible in a way no time series can. A nightly suite that stopped
 * publishing leaves a band with a hole in it; on the trend charts the line simply carries on
 * from Thursday to Saturday.
 *
 * Cells are totals over the window, not averages. "Six runs at 02:00 on Tuesdays" is the
 * honest count of what happened; dividing by the number of Tuesdays yields a rate that reads
 * as if it were measured, and 1.5 runs is not a thing that ever occurred. The tooltip states
 * how many of that weekday the window held, so a total can be turned back into a rate by
 * anyone who wants one.
 */

const HOURS = 24;

/** Monday first: the weekend belongs together at one end, not split across both. */
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

const CELL_GAP = 2;
const RAIL_WIDTH = 26;
const HEADER_HEIGHT = 12;

const STEPS = [
  "var(--color-scale-1)",
  "var(--color-scale-2)",
  "var(--color-scale-3)",
  "var(--color-scale-4)",
  "var(--color-scale-5)",
] as const;

export interface ActivityBucket {
  /** `YYYY-MM-DD`, already in the viewer's zone. */
  day: string;
  /** 0–23, already in the viewer's zone. */
  hour: number;
  runs: number;
}

/** Monday-based index. JS numbers Sunday as 0, and this grid starts on Monday. */
function weekdayIndex(date: Date): number {
  return (date.getUTCDay() + 6) % 7;
}

export function ActivityHeatmap({
  title,
  buckets,
  days,
  action,
  unit = "run",
  timeZoneLabel = "UTC",
  emptyMessage = "No activity in this period.",
}: {
  title: string;
  /** Sparse — only buckets that saw runs. */
  buckets: ActivityBucket[];
  /** Window length in days, used to count how many of each weekday it contained. */
  days: number;
  action?: ReactNode;
  unit?: string;
  /** Printed, never computed with — the buckets already arrive in this zone. */
  timeZoneLabel?: string;
  emptyMessage?: string;
}) {
  const [hover, setHover] = useState<{ weekday: number; hour: number } | null>(null);

  /*
   * A fixed 7 × 24 lattice, always.
   *
   * Built from the axes rather than from the data, so an hour nobody ever publishes in is
   * still drawn as an empty cell. A grid that dropped its empty columns would put 03:00
   * beside 14:00 and destroy the only axis that makes this chart worth reading.
   */
  const grid: number[][] = Array.from({ length: WEEKDAYS.length }, () =>
    new Array<number>(HOURS).fill(0),
  );

  for (const bucket of buckets) {
    if (bucket.hour < 0 || bucket.hour > 23) continue;
    const date = new Date(`${bucket.day}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) continue;
    const weekday = weekdayIndex(date);
    grid[weekday]![bucket.hour] = (grid[weekday]![bucket.hour] ?? 0) + bucket.runs;
  }

  /*
   * How many of each weekday the window actually contained.
   *
   * A 30-day window holds four of some weekdays and five of others, so two equally bright
   * cells can stand for different rates. Counted from the calendar rather than from the
   * data, so a weekday that saw nothing still reports how many chances it had.
   */
  const occurrences = new Array<number>(WEEKDAYS.length).fill(0);
  const now = new Date();
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (let offset = 0; offset < days; offset += 1) {
    const index = weekdayIndex(new Date(end - offset * 86_400_000));
    occurrences[index] = (occurrences[index] ?? 0) + 1;
  }

  const flat = grid.flat();
  const max = Math.max(...flat, 0);
  const total = flat.reduce((sum, value) => sum + value, 0);

  if (total === 0) {
    return (
      <figure className="flex h-full min-w-0 flex-col">
        <Caption title={title} action={action} />
        <p className="flex flex-1 items-center justify-center rounded-md border border-[var(--color-border-subtle)] px-3 py-6 text-center text-[11px] text-[var(--color-ink-muted)]">
          {emptyMessage}
        </p>
      </figure>
    );
  }

  const step = quantileScale(flat);
  const peak = peakCell(grid);

  const label =
    `${title}: ${total} ${unit}${total === 1 ? "" : "s"} over ${days} days, by hour of day and weekday (${timeZoneLabel}). ` +
    (peak
      ? `Busiest ${WEEKDAYS[peak.weekday]} at ${formatHour(peak.hour)} with ${peak.value}.`
      : "");

  return (
    // Same reason as the donut: square cells fix this chart's height to a seventh of its
    // width, so in a narrow card it is far shorter than the chart beside it. The grid takes
    // the middle and the surplus is split above and below rather than dumped at the bottom.
    <figure className="flex h-full min-w-0 flex-col">
      <Caption title={title} action={action} />

      {/*
       * Rail and grid are siblings so the rail stretches to the grid's height, and each of
       * its seven labels takes an equal share of it. The row heights are set by the cells'
       * aspect ratio and are not known here — anything that hard-coded a height would drift
       * out of alignment the moment the card resized.
       */}
      <div className="flex flex-1 items-center gap-1.5 py-1" role="img" aria-label={label}>
        <div
          className="flex shrink-0 flex-col"
          style={{ gap: CELL_GAP, width: RAIL_WIDTH }}
          aria-hidden
        >
          <span style={{ height: HEADER_HEIGHT }} />
          {WEEKDAYS.map((weekday, weekdayIdx) => (
            <span
              key={weekday}
              className={`flex flex-1 items-center justify-end text-[9px] leading-none font-medium tracking-wider uppercase ${
                hover?.weekday === weekdayIdx
                  ? "text-[var(--color-ink)]"
                  : "text-[var(--color-ink-muted)]"
              }`}
            >
              {weekday}
            </span>
          ))}
        </div>

        <div
          className="relative flex min-w-0 flex-1 flex-col"
          style={{ gap: CELL_GAP }}
          onMouseLeave={() => setHover(null)}
        >
          {/* Hour scale, every sixth hour. Twenty-four labels do not fit a nine-pixel
              column, and quarters of the day are the unit people actually reason in —
              "overnight", "morning", "after lunch". The gaps read off the printed ones. */}
          <div className="flex" style={{ gap: CELL_GAP, height: HEADER_HEIGHT }} aria-hidden>
            {Array.from({ length: HOURS }, (_, hour) => (
              <span
                key={hour}
                className={`min-w-0 flex-1 text-center text-[8px] leading-none ${
                  hover?.hour === hour ? "text-[var(--color-ink)]" : "text-[var(--color-ink-muted)]"
                }`}
              >
                {hour % 6 === 0 ? String(hour).padStart(2, "0") : ""}
              </span>
            ))}
          </div>

          {grid.map((hours, weekdayIdx) => (
            <div key={weekdayIdx} className="flex" style={{ gap: CELL_GAP }} aria-hidden>
              {hours.map((value, hour) => {
                const tone = step(value);
                const active = hover?.weekday === weekdayIdx && hover.hour === hour;
                return (
                  <span
                    key={hour}
                    onMouseEnter={() => setHover({ weekday: weekdayIdx, hour })}
                    // `aspect-square` is what makes a cell a cell: the width comes from the
                    // flex share of the row, and the height follows it, so the grid stays
                    // square at every card width instead of stretching into bricks.
                    className="block aspect-square min-w-0 flex-1 rounded-[3px]"
                    style={{
                      /*
                       * An empty hour is a pale fill, not an outline.
                       *
                       * Outlining 168 cells draws a grid of boxes and the eye reads the
                       * lattice instead of the data in it. A wash keeps every cell present —
                       * which matters, because "nothing ran here" is half of what this chart
                       * says — while staying quiet enough that the populated cells are the
                       * only thing with weight.
                       */
                      background:
                        tone < 0
                          ? "color-mix(in srgb, var(--color-border-subtle) 45%, transparent)"
                          : STEPS[tone],
                      boxShadow: active ? "inset 0 0 0 1.5px var(--color-ink)" : undefined,
                      // Crosshair: the hovered row and column stay lit so a cell can be
                      // traced back to its axes among 168 near-identical squares.
                      opacity:
                        hover === null || hover.weekday === weekdayIdx || hover.hour === hour
                          ? 1
                          : 0.45,
                    }}
                  />
                );
              })}
            </div>
          ))}

          {hover ? (
            /*
             * Anchored to the hovered cell, flipping below the top rows and above the rest,
             * so it never covers the cell it describes. Percentages rather than pixels: the
             * row height is the cells' aspect ratio and changes with the card width.
             */
            <div
              className="pointer-events-none absolute z-10 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1 shadow-md"
              style={{
                left: `${Math.min(Math.max(((hover.hour + 0.5) / HOURS) * 100, 12), 88)}%`,
                top: `${((hover.weekday + (hover.weekday < 3 ? 1 : 0)) / WEEKDAYS.length) * 100}%`,
                transform:
                  hover.weekday < 3 ? "translate(-50%, 8px)" : "translate(-50%, calc(-100% - 8px))",
              }}
            >
              <div className="font-mono text-[10px] whitespace-nowrap text-[var(--color-ink-muted)]">
                {WEEKDAYS[hover.weekday]} {formatHour(hover.hour)}–
                {formatHour((hover.hour + 1) % 24)}
              </div>
              <div className="font-mono text-[11px] whitespace-nowrap tabular-nums">
                {grid[hover.weekday]?.[hover.hour] ?? 0} {unit}
                {(grid[hover.weekday]?.[hover.hour] ?? 0) === 1 ? "" : "s"}
              </div>
              {/* The denominator, so a total can be read as a rate. Without it two equally
                  bright cells can quietly mean different things. */}
              <div className="font-mono text-[10px] whitespace-nowrap text-[var(--color-ink-muted)]">
                across {occurrences[hover.weekday]} {WEEKDAYS[hover.weekday]}
                {occurrences[hover.weekday] === 1 ? "" : "s"}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/*
       * "fewer → more", not a numeric axis.
       *
       * The steps are quantiles, so the ramp is deliberately *not* proportional to the
       * count — labelling the ends with numbers would promise a linearity the scale does not
       * have. The busiest cell is stated separately as the one number that anchors it, and
       * every exact count is one hover away.
       */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-[var(--color-ink-muted)]">
        <span>fewer</span>
        <span
          className="block size-2 rounded-[2px]"
          style={{ background: "color-mix(in srgb, var(--color-border-subtle) 45%, transparent)" }}
          aria-hidden
        />
        {STEPS.map((color) => (
          <span
            key={color}
            className="block size-2 rounded-[2px]"
            style={{ background: color }}
            aria-hidden
          />
        ))}
        <span>
          more · busiest {max} · {timeZoneLabel}
        </span>
      </div>

      <p className="mt-1.5 text-[10px] leading-relaxed text-[var(--color-ink-muted)]">
        {peak
          ? `Busiest ${WEEKDAYS[peak.weekday]} around ${formatHour(peak.hour)}. A schedule shows as a vertical band; scatter means people are publishing by hand.`
          : `${total} ${unit}${total === 1 ? "" : "s"} in this window.`}
      </p>
    </figure>
  );
}

/**
 * Buckets by rank among the non-zero cells, not by fraction of the maximum.
 *
 * Activity data is heavily skewed: one nightly job at 02:00 can be forty runs while every
 * other populated hour is one or two. Divided by the maximum, all of those land in the
 * lightest step and the chart is a single dark square on a flat wash — technically accurate
 * and useless, because the shape it exists to show has been quantised away.
 *
 * Quantiles spend the ramp where the data actually is. The cost is that colour now means
 * "busy relative to this team's other hours" rather than an absolute count, which is why the
 * legend says fewer/more instead of printing numbers on it, and why the tooltip carries the
 * real figure.
 *
 * Zero is never a bucket. An hour with no runs is a different kind of thing from a quiet
 * one, and it gets the empty-cell treatment rather than the palest blue.
 */
function quantileScale(values: number[]): (value: number) => number {
  const populated = values.filter((value) => value > 0).sort((a, b) => a - b);
  if (populated.length === 0) return () => -1;

  // Four cut points make five buckets. Duplicates collapse naturally — a grid where every
  // populated hour saw exactly one run has identical thresholds and renders in one tone,
  // which is the honest picture of a perfectly even schedule.
  const cuts = [0.2, 0.4, 0.6, 0.8].map(
    (fraction) =>
      populated[Math.min(Math.floor(fraction * populated.length), populated.length - 1)]!,
  );

  return (value: number): number => {
    if (value <= 0) return -1;
    for (let index = 0; index < cuts.length; index += 1) {
      if (value <= cuts[index]!) return index;
    }
    return STEPS.length - 1;
  };
}

/** The single busiest weekday-and-hour cell, or null when nothing ran. */
function peakCell(grid: number[][]): { weekday: number; hour: number; value: number } | null {
  let best: { weekday: number; hour: number; value: number } | null = null;
  grid.forEach((hours, weekday) => {
    hours.forEach((value, hour) => {
      if (value > 0 && (best === null || value > best.value)) best = { weekday, hour, value };
    });
  });
  return best;
}

function formatHour(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

function Caption({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-2">
      <figcaption className="text-xs font-medium">{title}</figcaption>
      {action}
    </div>
  );
}
