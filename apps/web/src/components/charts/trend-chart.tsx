"use client";

import { useId, useMemo, useState } from "react";
import { smoothPath, type Point } from "@/components/charts/curve";
import { rollingAverage } from "@/components/charts/rolling-average";
import { positionTooltip } from "@/components/charts/tooltip-position";
import { formatDuration, formatPercent } from "@/lib/format";

/**
 * Single-measure trend over time.
 *
 * One series, one colour — a value-ramp across the points would double-encode the
 * height as hue and burn the only free channel on information the line already
 * shows. Deliberately never dual-axis: pass rate and duration are separate charts
 * because aligning two y-scales invents a correlation the data does not contain.
 *
 * Marks follow the spec: 2px line with round caps, ~10% area wash, hairline solid
 * gridlines one step off the surface, and an ≥8px end marker carrying a 2px surface
 * ring so it stays legible where it crosses the line.
 */
export interface TrendPoint {
  label: string;
  value: number | null;
  /** Shown in the tooltip under the value, e.g. "12 runs". */
  detail?: string;
}

/** Enough room for percentage and compact duration labels without crowding the plot. */
const AXIS_WIDTH = 52;

export function TrendChart({
  points,
  title,
  unit = "",
  height = 160,
  color = "var(--color-series-1)",
  yMax,
  yMin = 0,
  format = "number",
  shape = "line",
  action,
}: {
  points: TrendPoint[];
  title: string;
  /** Rendered opposite the caption — the view toggle, where there is one. */
  action?: React.ReactNode;
  unit?: string;
  height?: number;
  color?: string;
  yMax?: number;
  yMin?: number;
  /** A name rather than a callback: functions cannot be serialized to a client component. */
  format?: "number" | "percent" | "duration";
  /** Bars show exact runs while the line shows their trailing five-run average. */
  shape?: "line" | "bars-line";
}) {
  const gradientId = useId();
  const [hover, setHover] = useState<number | null>(null);

  const present = points.filter((point) => point.value !== null);
  const formatted = (value: number): string => {
    if (format === "percent") return formatPercent(value);
    if (format === "duration") return formatDuration(value);
    return `${Math.round(value * 10) / 10}${unit}`;
  };

  const scale = useMemo(() => {
    const values = present.map((point) => point.value as number);
    const max = yMax ?? (values.length > 0 ? Math.max(...values) : 1);
    const min = yMin;
    // A flat series would otherwise divide by zero and collapse to the baseline.
    const span = max - min || 1;
    return { min, max, span };
  }, [present, yMax, yMin]);

  if (present.length < (shape === "bars-line" ? 1 : 2)) {
    return (
      <figure className="min-w-0">
        {/* The action stays rendered when there is no data: switching into an empty view
            must not remove the control that switches back out of it. */}
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <figcaption className="text-xs font-medium">{title}</figcaption>
          {action}
        </div>
        <div
          className="flex items-center justify-center rounded-md border border-[var(--color-border-subtle)] text-[11px] text-[var(--color-ink-muted)]"
          style={{ height }}
        >
          Not enough history yet
        </div>
      </figure>
    );
  }

  const width = 100; // viewBox units; the SVG scales to its container
  const step =
    shape === "bars-line"
      ? width / Math.max(points.length, 1)
      : width / Math.max(points.length - 1, 1);
  const lineValues =
    shape === "bars-line"
      ? rollingAverage(
          points.map((point) => point.value),
          5,
        )
      : points.map((point) => point.value);
  const toY = (value: number): number => {
    const ratio = (value - scale.min) / scale.span;
    return 100 - Math.max(0, Math.min(1, ratio)) * 100;
  };

  const coordinates = points.map((point, index) => {
    const lineValue = lineValues[index] ?? null;
    return {
      x: shape === "bars-line" ? (index + 0.5) * step : index * step,
      y: point.value === null ? null : toY(point.value),
      lineY: lineValue === null ? null : toY(lineValue),
      lineValue,
      point,
      index,
    };
  });

  /*
   * Breaks in the line where data is missing are honest: a straight segment across a gap
   * would imply measurements nobody took. Runs of present points are collected first and
   * smoothed independently, so a curve is never fitted *through* a gap either — the
   * interpolation only ever connects points that exist.
   */
  const runs: Point[][] = [];
  let current: Point[] = [];
  for (const coordinate of coordinates) {
    if (coordinate.lineY === null) {
      if (current.length > 1) runs.push(current);
      current = [];
      continue;
    }
    current.push({ x: coordinate.x, y: coordinate.lineY });
  }
  if (current.length > 1) runs.push(current);

  const segments = runs.map((run) => smoothPath(run));

  /*
   * The area reuses the *same* curve as the line, then drops to the baseline.
   *
   * Recomputing it would risk the fill and the stroke disagreeing by a fraction of a pixel,
   * which shows up as a hairline of background colour along the top of the fill.
   */
  const areaRun = shape === "line" && runs.length === 1 ? runs[0]! : null;
  const areaPath = areaRun
    ? `${smoothPath(areaRun)} L${areaRun.at(-1)!.x},100 L${areaRun[0]!.x},100 Z`
    : null;

  const last = [...coordinates].reverse().find((coordinate) => coordinate.lineY !== null);
  const lastPoint = [...coordinates].reverse().find((coordinate) => coordinate.y !== null);
  const hovered = hover !== null ? coordinates[hover] : null;
  const barWidth = Math.min(step * 0.62, 5);
  const tooltipStyle = hovered
    ? positionTooltip({
        x: hovered.x,
        // Use the upper mark so the tooltip does not jump through the average line when
        // the exact run and its rolling average are far apart.
        y: Math.min(hovered.y ?? hovered.lineY ?? 0, hovered.lineY ?? hovered.y ?? 0),
        beside: shape === "bars-line",
      })
    : undefined;

  return (
    <figure className="min-w-0">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <figcaption className="min-w-0 truncate text-xs font-medium">{title}</figcaption>
        {action}
        <span className="ml-auto font-mono text-xs text-[var(--color-ink-muted)] tabular-nums">
          {hovered?.point.value != null
            ? formatted(hovered.point.value)
            : lastPoint?.point.value != null
              ? formatted(lastPoint.point.value)
              : "—"}
        </span>
      </div>

      <div className="flex" style={{ height }}>
        {/* Values align with the same top, middle and baseline gridlines drawn in the plot.
            Run timestamps remain available in the dynamic tooltip: printing them below
            every compact card made the x-axis collide at normal publish volumes. */}
        <div
          className="flex shrink-0 flex-col justify-between pr-1.5 text-right font-mono text-[10px] text-[var(--color-ink-muted)] tabular-nums"
          style={{ width: AXIS_WIDTH }}
          aria-hidden
        >
          <span>{formatted(scale.max)}</span>
          <span>{formatted(scale.min + scale.span / 2)}</span>
          <span>{formatted(scale.min)}</span>
        </div>

        <div className="relative min-w-0 flex-1">
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            className="size-full overflow-visible"
            role="img"
            aria-label={`${title}. ${present.length} points from ${points[0]?.label} to ${points.at(-1)?.label}.`}
          >
            <defs>
              {/* Deep enough at the line to read as an area chart, gone by the baseline so
                the fill never competes with the line that carries the actual values. */}
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity="0.32" />
                <stop offset="55%" stopColor={color} stopOpacity="0.12" />
                <stop offset="100%" stopColor={color} stopOpacity="0.02" />
              </linearGradient>
            </defs>

            {/* Hairline, solid, one step off surface — chrome must stay recessive. */}
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

            {shape === "bars-line"
              ? coordinates.map((coordinate) =>
                  coordinate.y === null ? null : (
                    <rect
                      key={coordinate.index}
                      x={coordinate.x - barWidth / 2}
                      y={coordinate.y}
                      width={barWidth}
                      height={100 - coordinate.y}
                      fill={color}
                      opacity="0.24"
                    />
                  ),
                )
              : null}

            {areaPath ? <path d={areaPath} fill={`url(#${gradientId})`} /> : null}

            {segments.map((segment, index) => (
              <path
                key={index}
                d={segment}
                fill="none"
                stroke={color}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
                className="tc-line-shadow"
                /*
                 * A CSS filter, not an SVG one.
                 *
                 * `feDropShadow` blurs in user space, and this viewBox is stretched by
                 * `preserveAspectRatio="none"` — a round blur becomes a horizontal smear at
                 * whatever the container's aspect ratio happens to be. CSS filters run after
                 * layout, in device pixels, so the shadow stays the same soft shadow at every
                 * width. Neutral rather than tinted, and barely there: it lifts the line off
                 * its own fill, which is all it is for.
                 */
                style={{ filter: "drop-shadow(0 2px 3px rgb(0 0 0 / 0.22))" }}
              />
            ))}

            {hovered?.lineY != null ? (
              <line
                x1={hovered.x}
                y1="0"
                x2={hovered.x}
                y2="100"
                stroke="var(--color-ink-muted)"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
          </svg>

          {/* End marker and hover dot are absolutely positioned so they stay circular
            despite the non-uniform viewBox scaling. */}
          {last?.lineY != null ? (
            <Dot xPercent={last.x} yPercent={last.lineY} color={color} />
          ) : null}
          {hovered?.lineY != null && hovered.index !== last?.index ? (
            <Dot xPercent={hovered.x} yPercent={hovered.lineY} color={color} />
          ) : null}

          {/* Hit targets span the full height and are wider than the marks, because a
            2px line is impossible to hover precisely. */}
          <div className="absolute inset-0 flex">
            {coordinates.map((coordinate) => (
              <button
                key={coordinate.index}
                type="button"
                className="h-full flex-1 cursor-default"
                onMouseEnter={() => setHover(coordinate.index)}
                onFocus={() => setHover(coordinate.index)}
                onMouseLeave={() => setHover(null)}
                onBlur={() => setHover(null)}
                aria-label={`${coordinate.point.label}: ${
                  coordinate.point.value === null ? "no data" : formatted(coordinate.point.value)
                }${
                  shape === "bars-line" && coordinate.lineValue !== null
                    ? `, five-run rolling average ${formatted(coordinate.lineValue)}`
                    : ""
                }`}
              />
            ))}
          </div>

          {hovered ? (
            /*
             * Follow the mark instead of occupying a fixed corner of the plot. High points
             * put the tooltip below themselves; lower points put it above. The dot therefore
             * remains visible. Combo charts move it beside the publish instead: a bar fills
             * everything below its value, so a vertical flip alone must overlap the bar.
             */
            <div
              className="pointer-events-none absolute z-10 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1 shadow-md"
              style={tooltipStyle}
            >
              <div className="font-mono text-[10px] whitespace-nowrap text-[var(--color-ink-muted)]">
                {hovered.point.label}
              </div>
              <div className="font-mono text-xs whitespace-nowrap tabular-nums">
                {hovered.point.value === null
                  ? "no data"
                  : shape === "bars-line"
                    ? `Run ${formatted(hovered.point.value)}`
                    : formatted(hovered.point.value)}
              </div>
              {shape === "bars-line" && hovered.lineValue !== null ? (
                <div className="font-mono text-[10px] whitespace-nowrap text-[var(--color-ink-muted)] tabular-nums">
                  5-run rolling avg {formatted(hovered.lineValue)}
                </div>
              ) : null}
              {hovered.point.detail ? (
                <div className="font-mono text-[10px] whitespace-nowrap text-[var(--color-ink-muted)]">
                  {hovered.point.detail}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {shape === "bars-line" ? (
        <ul className="mt-2 flex items-center gap-4" style={{ marginLeft: AXIS_WIDTH }}>
          <li className="flex items-center gap-1.5 text-[10px] text-[var(--color-ink-muted)]">
            <span className="size-2 rounded-[1px]" style={{ background: color, opacity: 0.24 }} />
            Run duration
          </li>
          <li className="flex items-center gap-1.5 text-[10px] text-[var(--color-ink-muted)]">
            <span className="h-0.5 w-3 rounded-full" style={{ background: color }} />
            5-run rolling average
          </li>
        </ul>
      ) : null}
    </figure>
  );
}

/** ≥8px marker with a 2px surface ring, per the mark spec. */
function Dot({ xPercent, yPercent, color }: { xPercent: number; yPercent: number; color: string }) {
  return (
    <span
      className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full"
      style={{
        left: `${xPercent}%`,
        top: `${yPercent}%`,
        background: color,
        boxShadow: "0 0 0 2px var(--color-surface)",
      }}
      aria-hidden
    />
  );
}
