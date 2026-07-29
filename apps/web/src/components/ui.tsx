import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Shared primitives.
 *
 * Status colour is centralised here because a "failed" result must look identical in
 * the run list, the result table, the suite tree and the charts. Divergent status
 * colours across views is the fastest way to make a dashboard untrustworthy.
 */
export type ResultStatus = "passed" | "failed" | "error" | "skipped" | "blocked";
export type RunStatus = "pending" | "parsing" | "complete" | "partial" | "failed";

const STATUS_STYLES: Record<string, { dot: string; text: string; bg: string; label: string }> = {
  passed: {
    dot: "bg-[var(--color-status-passed)]",
    text: "text-[var(--color-status-passed)]",
    bg: "bg-[var(--color-status-passed)]/10",
    label: "Passed",
  },
  failed: {
    dot: "bg-[var(--color-status-failed)]",
    text: "text-[var(--color-status-failed)]",
    bg: "bg-[var(--color-status-failed)]/10",
    label: "Failed",
  },
  error: {
    dot: "bg-[var(--color-status-failed)]",
    text: "text-[var(--color-status-failed)]",
    bg: "bg-[var(--color-status-failed)]/10",
    label: "Error",
  },
  skipped: {
    dot: "bg-[var(--color-status-skipped)]",
    text: "text-[var(--color-ink-muted)]",
    bg: "bg-[var(--color-status-skipped)]/10",
    label: "Skipped",
  },
  blocked: {
    dot: "bg-[var(--color-status-skipped)]",
    text: "text-[var(--color-ink-muted)]",
    bg: "bg-[var(--color-status-skipped)]/10",
    label: "Blocked",
  },
  flaky: {
    dot: "bg-[var(--color-status-flaky)]",
    text: "text-[var(--color-status-flaky)]",
    bg: "bg-[var(--color-status-flaky)]/10",
    label: "Flaky",
  },
  complete: {
    dot: "bg-[var(--color-status-passed)]",
    text: "text-[var(--color-status-passed)]",
    bg: "bg-[var(--color-status-passed)]/10",
    label: "Complete",
  },
  partial: {
    dot: "bg-[var(--color-status-flaky)]",
    text: "text-[var(--color-status-flaky)]",
    bg: "bg-[var(--color-status-flaky)]/10",
    label: "Partial",
  },
  parsing: {
    dot: "bg-sky-500",
    text: "text-sky-500",
    bg: "bg-sky-500/10",
    label: "Parsing",
  },
  pending: {
    dot: "bg-[var(--color-status-skipped)]",
    text: "text-[var(--color-ink-muted)]",
    bg: "bg-[var(--color-status-skipped)]/10",
    label: "Pending",
  },
};

function styleFor(status: string) {
  return STATUS_STYLES[status] ?? STATUS_STYLES.skipped!;
}

export function StatusDot({ status }: { status: string }) {
  return (
    <span
      className={`inline-block size-2 shrink-0 rounded-full ${styleFor(status).dot}`}
      aria-hidden
    />
  );
}

export function StatusBadge({ status, children }: { status: string; children?: ReactNode }) {
  const style = styleFor(status);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium ${style.bg} ${style.text}`}
    >
      <StatusDot status={status} />
      {children ?? style.label}
    </span>
  );
}

export function Card({
  children,
  className = "",
  as: Component = "section",
}: {
  children: ReactNode;
  className?: string;
  as?: "section" | "div" | "article";
}) {
  return (
    <Component
      className={`rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] ${className}`}
    >
      {children}
    </Component>
  );
}

export function CardHeader({ title, action }: { title: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-[var(--color-border-subtle)] px-5 py-3">
      <h2 className="text-sm font-medium">{title}</h2>
      {action}
    </div>
  );
}

export function StatTile({
  label,
  value,
  tone = "neutral",
  hint,
}: {
  label: string;
  value: ReactNode;
  tone?: "neutral" | "passed" | "failed" | "flaky" | "skipped";
  hint?: string;
}) {
  const toneClass =
    tone === "passed"
      ? "text-[var(--color-status-passed)]"
      : tone === "failed"
        ? "text-[var(--color-status-failed)]"
        : tone === "flaky"
          ? "text-[var(--color-status-flaky)]"
          : tone === "skipped"
            ? "text-[var(--color-ink-muted)]"
            : "";
  return (
    <div className="px-4 py-3">
      <div className="text-xs tracking-wide text-[var(--color-ink-muted)] uppercase">{label}</div>
      <div className={`mt-1 font-mono text-xl font-semibold tabular-nums ${toneClass}`}>
        {value}
      </div>
      {hint ? <div className="mt-0.5 text-xs text-[var(--color-ink-muted)]">{hint}</div> : null}
    </div>
  );
}

/**
 * A tag is a link, not a label.
 *
 * Tags are the primary way people slice this data, so every rendered tag is a
 * one-click filter. Making them inert would leave the tagging feature decorative.
 */
export function TagChip({
  tagKey,
  value,
  href,
  onRemove,
}: {
  tagKey: string;
  value: string;
  href?: string;
  onRemove?: () => void;
}) {
  const body = (
    <>
      <span className="text-[var(--color-ink-muted)]">{tagKey}</span>
      <span className="text-[var(--color-border-subtle)]">:</span>
      <span className="font-medium">{value}</span>
    </>
  );

  const className =
    "inline-flex items-center gap-1 rounded border border-[var(--color-border-subtle)] px-1.5 py-0.5 font-mono text-[11px] whitespace-nowrap";

  if (onRemove) {
    return (
      <span className={className}>
        {body}
        <button
          type="button"
          onClick={onRemove}
          className="ml-0.5 text-[var(--color-ink-muted)] hover:text-[var(--color-status-failed)]"
          aria-label={`Remove tag ${tagKey}:${value}`}
        >
          ×
        </button>
      </span>
    );
  }

  if (href) {
    return (
      <Link
        href={href}
        // The visible chip is "key : value" across three spans, which a screen reader
        // reads as disconnected fragments and gives no clue that it filters. Naming the
        // action explicitly is both clearer and shorter to hear.
        aria-label={`Filter by tag ${tagKey}: ${value}`}
        className={`${className} hover:border-[var(--color-ink-muted)]`}
      >
        {body}
      </Link>
    );
  }

  return <span className={className}>{body}</span>;
}

/**
 * Pass/fail/skip proportions as one bar.
 *
 * Shows composition at a glance in a list where a reader scans dozens of rows; the
 * numbers alone require arithmetic per row.
 */
export function ResultBar({
  passed,
  failed,
  skipped,
  flaky = 0,
  total,
}: {
  passed: number;
  failed: number;
  skipped: number;
  flaky?: number;
  total: number;
}) {
  if (total === 0) {
    return <div className="h-1.5 w-full rounded-full bg-[var(--color-border-subtle)]" />;
  }
  const pct = (value: number) => `${(value / total) * 100}%`;
  return (
    <div
      className="flex h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-border-subtle)]"
      role="img"
      aria-label={`${passed} passed, ${failed} failed, ${skipped} skipped of ${total}`}
    >
      {failed > 0 ? (
        <div style={{ width: pct(failed) }} className="bg-[var(--color-status-failed)]" />
      ) : null}
      {flaky > 0 ? (
        <div style={{ width: pct(flaky) }} className="bg-[var(--color-status-flaky)]" />
      ) : null}
      {passed - flaky > 0 ? (
        <div style={{ width: pct(passed - flaky) }} className="bg-[var(--color-status-passed)]" />
      ) : null}
      {skipped > 0 ? (
        <div style={{ width: pct(skipped) }} className="bg-[var(--color-status-skipped)]" />
      ) : null}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="px-5 py-14 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="mx-auto mt-1.5 max-w-md text-xs leading-relaxed text-[var(--color-ink-muted)]">
        {description}
      </p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Button({
  children,
  href,
  variant = "secondary",
  type = "button",
  onClick,
  disabled,
  className = "",
}: {
  children: ReactNode;
  href?: string;
  variant?: "primary" | "secondary" | "ghost";
  type?: "button" | "submit";
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  const base =
    "inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50";
  const variants = {
    primary: "bg-[var(--color-ink)] text-[var(--color-surface)] hover:opacity-90",
    secondary:
      "border border-[var(--color-border-subtle)] hover:border-[var(--color-ink-muted)] hover:bg-[var(--color-surface)]",
    ghost: "text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]",
  };
  const classes = `${base} ${variants[variant]} ${className}`;

  if (href) {
    return (
      <Link href={href} className={classes}>
        {children}
      </Link>
    );
  }
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={classes}>
      {children}
    </button>
  );
}
