import Link from "next/link";

/**
 * The page-level "how far back" selector.
 *
 * Shared by the org dashboard and the project overview so the control looks and behaves
 * the same on both, rather than each page growing its own copy that drifts.
 *
 * Deliberately heavier than `ChartToggle`: this changes what every chart on the page is
 * measuring, where a chart toggle changes one chart's question. Controls with different
 * reach should not look identical.
 *
 * The caller supplies the option set, because the useful windows differ by page — and
 * supplies each href itself, so the range change carries the page's other selections
 * instead of resetting them.
 */
export function TimeRangeNav({
  options,
}: {
  options: { days: number; href: string; active: boolean }[];
}) {
  return (
    <nav className="flex gap-1" aria-label="Time range">
      {options.map((option) => (
        <Link
          key={option.days}
          href={option.href}
          aria-current={option.active ? "true" : undefined}
          className={`rounded-md border px-2 py-1 text-xs ${
            option.active
              ? "border-[var(--color-ink-muted)] font-semibold"
              : "border-[var(--color-border-subtle)] text-[var(--color-ink-muted)] hover:border-[var(--color-ink-muted)]"
          }`}
        >
          {option.days}d
        </Link>
      ))}
    </nav>
  );
}
