"use client";

import { formatInteger } from "@/lib/format";

import { useState } from "react";

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
}) {
  const [hover, setHover] = useState<number | null>(null);

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

      <div className="relative flex items-end gap-[2px]" style={{ height }}>
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
              key={day.label}
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
