import Link from "next/link";

/**
 * A two-or-three way switch between *views of the same data*, as links.
 *
 * Links, not client state, for the same reason every filter in this app lives in the URL:
 * the view is then shareable ("here's the share-of-outcome chart"), survives a reload, and
 * needs no stored per-user preference to stay consistent.
 *
 * This deliberately does not switch chart *type*. The form is chosen by the question the
 * data answers, so a line/bar/pie picker offers the reader a way to misread it — a time
 * series as a pie discards the axis that carries the information. Every option here
 * changes the question instead: counts versus share, aggregate versus per-branch, speed
 * versus spend.
 */
export function ChartToggle({
  options,
  label,
}: {
  options: { label: string; href: string; active: boolean }[];
  /** Names the group, e.g. "Outcome view". */
  label: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex items-center overflow-hidden rounded border border-[var(--color-border-subtle)]"
    >
      {options.map((option, index) => (
        <Link
          key={option.label}
          href={option.href}
          aria-current={option.active ? "true" : undefined}
          className={`px-1.5 py-0.5 text-[10px] whitespace-nowrap transition-colors ${
            index > 0 ? "border-l border-[var(--color-border-subtle)]" : ""
          } ${
            option.active
              ? "bg-[var(--color-ink)] font-semibold text-[var(--color-surface)]"
              : "text-[var(--color-ink-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-ink)]"
          }`}
        >
          {option.label}
        </Link>
      ))}
    </div>
  );
}
