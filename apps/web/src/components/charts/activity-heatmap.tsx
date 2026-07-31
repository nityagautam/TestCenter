import type { ReactNode } from "react";

/**
 * When the suite actually runs — weekday × week, one cell per day.
 *
 * The question is *rhythm*, and it is the one question a time series cannot answer. The
 * pass-rate and volume charts run left to right, so a weekly cadence appears in them as
 * noise: five peaks and two troughs repeating, indistinguishable from instability. Folding
 * the same days into a calendar grid puts every Tuesday above every other Tuesday, and the
 * shape falls out — nightly on weekdays, nothing at weekends, or a team that only publishes
 * when someone remembers.
 *
 * That makes it a diagnostic for the data as much as for the team. A blank Friday column on
 * a suite that is supposed to run nightly means the pipeline stopped publishing, and no
 * other chart here says so: the trend line simply carries on from Thursday to Saturday.
 *
 * Reads the daily series the dashboard has already fetched — no query of its own. Server
 * component, no client JavaScript.
 */

/**
 * Monday-first, matching the working week the data is about.
 *
 * Sunday-first would split the weekend across the two ends of the grid, which is precisely
 * the block a reader is trying to see as a block.
 */
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

const CELL = 13;
const CELL_GAP = 3;

/** Five filled steps, plus an unfilled one for a day with no runs at all. */
const STEPS = [
  "var(--color-scale-1)",
  "var(--color-scale-2)",
  "var(--color-scale-3)",
  "var(--color-scale-4)",
  "var(--color-scale-5)",
] as const;

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

export interface ActivityDay {
  /**
   * A calendar day. Accepts both a `YYYY-MM-DD` string and a `Date`, because the type is
   * not to be trusted — see `parseDay`.
   */
  day: string | Date;
  value: number;
}

interface Cell {
  date: Date;
  value: number | null;
}

/**
 * Normalises a day to UTC midnight, whatever form it arrived in.
 *
 * `DailyPoint.day` is *typed* `string`, and it is not one: postgres.js decodes a `date`
 * column to a `Date`, so the template-string parse produced `Invalid Date` and the grid
 * threw on the first `toISOString()`. Nothing upstream noticed because the only other
 * consumer is `formatDay`, which accepts either. Same family as the `int8`-comes-back-a-
 * string trap — the declared type describes the column, not the driver.
 *
 * Everything downstream then reads UTC accessors. `new Date("2026-07-01")` is midnight
 * *UTC*, but `getDay()` reads it in the viewer's zone, so west of Greenwich every date lands
 * on the previous weekday and the whole grid shifts a column.
 *
 * The hours check is what makes the `Date` branch safe in both directions: postgres.js hands
 * back UTC midnight, so the UTC parts are the calendar day — but a driver or caller passing
 * *local* midnight would have its UTC parts roll back a day east of Greenwich. Reading the
 * local parts in that case keeps the day the day.
 */
function parseDay(day: string | Date): Date | null {
  if (day instanceof Date) {
    if (Number.isNaN(day.getTime())) return null;
    const utcMidnight = day.getUTCHours() === 0 && day.getUTCMinutes() === 0;
    return utcMidnight
      ? new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()))
      : new Date(Date.UTC(day.getFullYear(), day.getMonth(), day.getDate()));
  }

  // Date-only strings get an explicit UTC marker; anything longer is already a timestamp.
  const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day}T00:00:00Z` : day);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
}

/** Monday index: JS numbers Sunday as 0, and this grid starts on Monday. */
function weekdayIndex(date: Date): number {
  return (date.getUTCDay() + 6) % 7;
}

export function ActivityHeatmap({
  title,
  days,
  action,
  unit = "run",
  emptyMessage = "No activity in this period.",
}: {
  title: string;
  /** Ascending, one entry per calendar day. Gaps are days with zero, not missing days. */
  days: ActivityDay[];
  action?: ReactNode;
  /** Singular noun for the tooltip: "3 runs on Tue 14 Jul". */
  unit?: string;
  emptyMessage?: string;
}) {
  /*
   * Unparseable days are dropped, not rendered.
   *
   * A chart is not the place to discover a bad date: the alternative is the whole dashboard
   * failing on one malformed row, which is what happened before `parseDay` returned null.
   * A missing cell is a visible, survivable gap.
   */
  const parsed = days
    .map((entry) => ({ date: parseDay(entry.day), value: entry.value }))
    .filter((entry): entry is { date: Date; value: number } => entry.date !== null);

  if (parsed.length === 0) {
    return (
      <figure className="min-w-0">
        <Caption title={title} action={action} />
        <p className="rounded-md border border-[var(--color-border-subtle)] px-3 py-6 text-center text-[11px] text-[var(--color-ink-muted)]">
          {emptyMessage}
        </p>
      </figure>
    );
  }

  const first = parsed[0]!;
  const last = parsed[parsed.length - 1]!;

  /*
   * The grid is padded to whole weeks at both ends with null cells rather than zero ones.
   *
   * A day before the window started is *unknown*, not quiet, and drawing it as an empty
   * cell identical to a genuine zero would invent a fact — "nothing ran on the 28th" when
   * the window simply began on the 30th. Nulls render as nothing at all.
   */
  const leading = weekdayIndex(first.date);
  const trailing = 6 - weekdayIndex(last.date);

  const cells: Cell[] = [];
  for (let index = leading; index > 0; index -= 1) {
    cells.push({ date: addDays(first.date, -index), value: null });
  }
  for (const entry of parsed) cells.push({ date: entry.date, value: entry.value });
  for (let index = 1; index <= trailing; index += 1) {
    cells.push({ date: addDays(last.date, index), value: null });
  }

  const weeks: Cell[][] = [];
  for (let index = 0; index < cells.length; index += 7) {
    weeks.push(cells.slice(index, index + 7));
  }

  const max = Math.max(...parsed.map((entry) => entry.value), 0);
  const total = parsed.reduce((sum, entry) => sum + entry.value, 0);
  const busiest = parsed.reduce((best, entry) => (entry.value > best.value ? entry : best), first);
  const quietWeekdays = countQuietWeekdays(parsed);

  /*
   * Buckets are linear over the observed maximum, which is the honest default when the
   * measure has no meaningful absolute ceiling — "busy" only means anything relative to this
   * team's own busiest day. Any non-zero value reaches step 1, so a day with a single run is
   * never drawn as an empty day.
   */
  const step = (value: number): number => {
    if (value <= 0) return -1;
    if (max <= 0) return 0;
    return Math.min(Math.ceil((value / max) * STEPS.length) - 1, STEPS.length - 1);
  };

  /*
   * The grid is one image with one accessible name, not 90 announced cells.
   *
   * A screen reader walking every square reads out three months of numbers to convey a
   * shape, which is unusable. The name states what the shape *is*, and the footnote repeats
   * the peak in visible text so the same fact is available without hovering anything.
   */
  const label =
    `${title}: ${total} ${unit}${total === 1 ? "" : "s"} between ${formatDate(first.date)} and ` +
    `${formatDate(last.date)}. Busiest ${formatDate(busiest.date)} with ${busiest.value}. ` +
    (quietWeekdays.length > 0
      ? `No activity at all on ${listOf(quietWeekdays)}.`
      : "Every weekday saw activity.");

  return (
    <figure className="min-w-0">
      <Caption title={title} action={action} />

      <div className="overflow-x-auto">
        <div className="inline-flex gap-2" role="img" aria-label={label}>
          {/* Weekday rail. Alternate labels only — seven stacked 10px words beside a 13px
              grid is more text than grid, and the omitted rows are unambiguous. */}
          <div
            className="flex shrink-0 flex-col"
            style={{ gap: CELL_GAP, paddingTop: 14 }}
            aria-hidden
          >
            {WEEKDAYS.map((weekday, index) => (
              <span
                key={weekday}
                className="text-right text-[9px] leading-none text-[var(--color-ink-muted)]"
                style={{ height: CELL, lineHeight: `${CELL}px`, width: 22 }}
              >
                {index % 2 === 0 ? weekday : ""}
              </span>
            ))}
          </div>

          <div className="flex" style={{ gap: CELL_GAP }} aria-hidden>
            {weeks.map((week, weekIndex) => (
              <div key={weekIndex} className="flex flex-col" style={{ gap: CELL_GAP }}>
                {/* Month label at the column where the month turns over, so a 90-day
                    window is readable without a date under every week. */}
                <span
                  className="text-[9px] leading-none text-[var(--color-ink-muted)]"
                  style={{ height: 11 }}
                >
                  {monthLabel(week, weeks[weekIndex - 1])}
                </span>
                {week.map((cell, dayIndex) => {
                  const index = cell.value === null ? -1 : step(cell.value);
                  return (
                    <span
                      // Position, not the date. The grid is a fixed 7×N lattice, so the
                      // coordinate *is* the identity — and a key derived from the data
                      // cannot then throw on a date the data got wrong.
                      key={`${weekIndex}-${dayIndex}`}
                      title={
                        cell.value === null
                          ? undefined
                          : `${cell.value} ${unit}${cell.value === 1 ? "" : "s"} · ${formatDate(cell.date)}`
                      }
                      className="block rounded-[2px]"
                      style={{
                        width: CELL,
                        height: CELL,
                        // Outside the window: nothing. Inside but zero: the surface with a
                        // hairline, so an idle day is visibly a day rather than a hole.
                        background:
                          cell.value === null
                            ? "transparent"
                            : index < 0
                              ? "var(--color-surface)"
                              : STEPS[index],
                        boxShadow:
                          cell.value === null
                            ? undefined
                            : index < 0
                              ? "inset 0 0 0 1px var(--color-border-subtle)"
                              : undefined,
                      }}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Legend states both ends numerically. "Less → More" alone leaves the reader unable
          to tell whether the darkest cell is four runs or four hundred. */}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-[var(--color-ink-muted)]">
        <span>0</span>
        <span
          className="block rounded-[2px]"
          style={{
            width: CELL - 2,
            height: CELL - 2,
            background: "var(--color-surface)",
            boxShadow: "inset 0 0 0 1px var(--color-border-subtle)",
          }}
          aria-hidden
        />
        {STEPS.map((color) => (
          <span
            key={color}
            className="block rounded-[2px]"
            style={{ width: CELL - 2, height: CELL - 2, background: color }}
            aria-hidden
          />
        ))}
        <span>
          {max} {unit}
          {max === 1 ? "" : "s"} a day
        </span>
      </div>

      <p className="mt-2 text-[10px] leading-relaxed text-[var(--color-ink-muted)]">
        Busiest {formatDate(busiest.date)} · {busiest.value} {unit}
        {busiest.value === 1 ? "" : "s"}.{" "}
        {quietWeekdays.length > 0
          ? `Nothing ran on ${listOf(quietWeekdays)} in this window — a gap on a weekday usually means the pipeline stopped publishing, not that the suite went quiet.`
          : "Every weekday saw at least one run."}
      </p>
    </figure>
  );
}

function addDays(date: Date, offset: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + offset);
  return next;
}

function formatDate(date: Date): string {
  return `${WEEKDAYS[weekdayIndex(date)]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

/** Printed once per month, above the week the month starts in. */
function monthLabel(week: Cell[], previous: Cell[] | undefined): string {
  const inWindow = week.find((cell) => cell.value !== null);
  if (!inWindow) return "";
  const month = inWindow.date.getUTCMonth();
  if (!previous) return MONTHS[month] ?? "";
  const previousInWindow = previous.find((cell) => cell.value !== null);
  const previousMonth = previousInWindow?.date.getUTCMonth();
  return month === previousMonth ? "" : (MONTHS[month] ?? "");
}

/**
 * Weekdays that saw nothing across the whole window.
 *
 * Only reported when the day appeared in the window at all, and Saturday and Sunday are
 * included deliberately — "nothing at weekends" is the normal, healthy answer, and stating
 * it is what makes a *weekday* in the same list alarming by contrast.
 */
function countQuietWeekdays(entries: { date: Date; value: number }[]): string[] {
  const seen = new Set<number>();
  const active = new Set<number>();
  for (const entry of entries) {
    const index = weekdayIndex(entry.date);
    seen.add(index);
    if (entry.value > 0) active.add(index);
  }
  return WEEKDAYS.filter((_, index) => seen.has(index) && !active.has(index)).map(
    (weekday) => weekday,
  );
}

function listOf(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function Caption({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-2">
      <figcaption className="text-xs font-medium">{title}</figcaption>
      {action}
    </div>
  );
}
