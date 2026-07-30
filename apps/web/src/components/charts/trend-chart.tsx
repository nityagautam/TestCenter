"use client";

import { useId, useMemo, useState } from "react";
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

export function TrendChart({
  points,
  title,
  unit = "",
  height = 160,
  color = "var(--color-series-1)",
  yMax,
  yMin = 0,
  format = "number",
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

  if (present.length < 2) {
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
  const step = width / Math.max(points.length - 1, 1);
  const toY = (value: number): number => {
    const ratio = (value - scale.min) / scale.span;
    return 100 - Math.max(0, Math.min(1, ratio)) * 100;
  };

  const coordinates = points.map((point, index) => ({
    x: index * step,
    y: point.value === null ? null : toY(point.value),
    point,
    index,
  }));

  // Breaks in the line where data is missing are honest: a straight segment across a
  // gap would imply measurements nobody took.
  const segments: string[] = [];
  let current: string[] = [];
  for (const coordinate of coordinates) {
    if (coordinate.y === null) {
      if (current.length > 1) segments.push(current.join(" "));
      current = [];
      continue;
    }
    current.push(`${current.length === 0 ? "M" : "L"}${coordinate.x},${coordinate.y}`);
  }
  if (current.length > 1) segments.push(current.join(" "));

  const areaPath =
    segments.length === 1
      ? `${segments[0]} L${coordinates.at(-1)?.x ?? width},100 L${coordinates[0]?.x ?? 0},100 Z`
      : null;

  const last = [...coordinates].reverse().find((coordinate) => coordinate.y !== null);
  const hovered = hover !== null ? coordinates[hover] : null;

  return (
    <figure className="min-w-0">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <figcaption className="min-w-0 truncate text-xs font-medium">{title}</figcaption>
        {action}
        <span className="ml-auto font-mono text-xs text-[var(--color-ink-muted)] tabular-nums">
          {hovered?.point.value != null
            ? formatted(hovered.point.value)
            : last?.point.value != null
              ? formatted(last.point.value)
              : "—"}
        </span>
      </div>

      <div className="relative" style={{ height }}>
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="size-full overflow-visible"
          role="img"
          aria-label={`${title}. ${present.length} points from ${points[0]?.label} to ${points.at(-1)?.label}.`}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.14" />
              <stop offset="100%" stopColor={color} stopOpacity="0.01" />
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
            />
          ))}

          {hovered?.y != null ? (
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
        {last?.y != null ? <Dot xPercent={last.x} yPercent={last.y} color={color} /> : null}
        {hovered?.y != null && hovered.index !== last?.index ? (
          <Dot xPercent={hovered.x} yPercent={hovered.y} color={color} />
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
              }`}
            />
          ))}
        </div>

        {hovered ? (
          <div
            className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1 shadow-md"
            style={{
              left: `${Math.min(Math.max(hovered.x, 12), 88)}%`,
              top: 0,
            }}
          >
            <div className="font-mono text-[10px] whitespace-nowrap text-[var(--color-ink-muted)]">
              {hovered.point.label}
            </div>
            <div className="font-mono text-xs whitespace-nowrap tabular-nums">
              {hovered.point.value === null ? "no data" : formatted(hovered.point.value)}
            </div>
            {hovered.point.detail ? (
              <div className="font-mono text-[10px] whitespace-nowrap text-[var(--color-ink-muted)]">
                {hovered.point.detail}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="mt-1 flex justify-between font-mono text-[10px] text-[var(--color-ink-muted)]">
        <span>{points[0]?.label}</span>
        <span>{points.at(-1)?.label}</span>
      </div>
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
