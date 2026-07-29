"use client";

import Link from "next/link";
import { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/**
 * Navigation item.
 *
 * Carries an icon and an optional count, because the count is the point of the
 * collapsed rail: losing the label is acceptable, losing the signal is not. A nav
 * that still tells you "6 failing" when it is 56px wide is doing its job.
 *
 * `exact` distinguishes a section root from its children — without it, Dashboard
 * (`/o/acme`) would highlight while you are on `/o/acme/runs`, since every path in the
 * organisation starts with the dashboard's href.
 */
export type NavIcon =
  | "dashboard"
  | "runs"
  | "tests"
  | "flaky"
  | "projects"
  | "members"
  | "tokens"
  | "admin"
  | "upload"
  | "settings"
  | "overview";

export function NavLink({
  href,
  children,
  icon,
  count,
  tone = "neutral",
  exact = false,
  collapsed = false,
}: {
  href: string;
  children: ReactNode;
  icon?: NavIcon;
  /** Rendered as a badge, and kept visible when collapsed. */
  count?: number | undefined;
  tone?: "neutral" | "failed" | "flaky";
  exact?: boolean;
  collapsed?: boolean;
}) {
  const pathname = usePathname();
  const active = exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
  const label = typeof children === "string" ? children : undefined;

  const badgeTone =
    tone === "failed"
      ? "text-[var(--color-status-failed)]"
      : tone === "flaky"
        ? "text-[var(--color-status-flaky)]"
        : "text-[var(--color-ink-muted)]";

  return (
    <li>
      <Link
        href={href}
        aria-current={active ? "page" : undefined}
        // The accessible name must survive collapsing, so it is stated explicitly
        // rather than inferred from visible text that may be hidden.
        aria-label={collapsed && label ? label : undefined}
        title={collapsed && label ? label : undefined}
        data-active={active ? "true" : undefined}
        className={`group relative flex items-center gap-2.5 rounded-md px-2 py-1.5 text-xs transition-colors ${
          collapsed ? "justify-center" : ""
        } ${
          active
            ? "bg-[var(--color-surface-raised)] font-semibold text-[var(--color-ink)]"
            : "text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-ink)]"
        }`}
      >
        {/* A 2px bar rather than a background change: it reads as a position marker in
            a rail, and stays legible when the label is gone. */}
        {active ? (
          <span
            className="absolute top-1/2 left-0 h-4 w-0.5 -translate-y-1/2 rounded-r bg-[var(--color-status-passed)]"
            aria-hidden
          />
        ) : null}

        {/* The icon slot doubles as the pending slot, so the row does not reflow when a
            navigation starts — the glyph is replaced in place, not pushed aside. */}
        <NavIndicator icon={icon} />

        {collapsed ? null : <span className="min-w-0 flex-1 truncate">{children}</span>}

        {count !== undefined && count > 0 ? (
          collapsed ? (
            <span
              className={`absolute top-0.5 right-0.5 min-w-3 rounded-full bg-[var(--color-surface)] px-1 text-center font-mono text-[9px] leading-tight tabular-nums ${badgeTone}`}
            >
              {count > 99 ? "99+" : count}
            </span>
          ) : (
            <span className={`shrink-0 font-mono text-[10px] tabular-nums ${badgeTone}`}>
              {count > 999 ? "999+" : count}
            </span>
          )
        ) : null}
      </Link>
    </li>
  );
}

/**
 * Swaps the nav glyph for a spinner while this link's target is loading.
 *
 * `useLinkStatus` reports the pending state of the enclosing Link, which is the piece the
 * page-level skeleton cannot provide: the skeleton says "something is loading", this says
 * *which thing*. On a slow route that is the difference between "did my click register?"
 * and "yes, Tests is on its way".
 *
 * It must be a child of the Link to read that context, which is also why it owns the icon
 * rather than sitting beside it.
 */
function NavIndicator({ icon }: { icon?: NavIcon }) {
  const { pending } = useLinkStatus();
  if (pending) return <Spinner />;
  return icon ? <NavGlyph icon={icon} /> : null;
}

function Spinner() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5 shrink-0 animate-spin" aria-hidden>
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeOpacity="0.25"
      />
      {/* A quarter arc, so the rotation is legible at 14px. */}
      <path
        d="M8 2 a6 6 0 0 1 6 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Inline SVG rather than an icon dependency: eleven glyphs at 14px do not justify a
 * package, and these are drawn from the subject — a run is a play mark, flakiness is a
 * wave, a test is a check.
 */
function NavGlyph({ icon }: { icon: NavIcon }) {
  const paths: Record<NavIcon, ReactNode> = {
    dashboard: (
      <>
        <rect x="2" y="2" width="4.5" height="4.5" rx="1" />
        <rect x="9.5" y="2" width="4.5" height="7" rx="1" />
        <rect x="2" y="9.5" width="4.5" height="4.5" rx="1" />
        <rect x="9.5" y="11.5" width="4.5" height="2.5" rx="1" />
      </>
    ),
    runs: (
      <>
        <path d="M3 3.5 L3 12.5" />
        <path d="M6 5 L12.5 8 L6 11 Z" />
      </>
    ),
    tests: (
      <>
        <path d="M3 8.5 L6 11.5 L13 4.5" />
      </>
    ),
    flaky: (
      <>
        <path d="M2 10.5 Q5 4.5 8 10.5 Q11 16.5 14 10.5" />
      </>
    ),
    projects: (
      <>
        <path d="M2 5 L6.5 5 L8 7 L14 7 L14 13 L2 13 Z" />
      </>
    ),
    members: (
      <>
        <circle cx="6" cy="6" r="2.5" />
        <path d="M2 13.5 Q2 9.5 6 9.5 Q10 9.5 10 13.5" />
        <path d="M11 5.5 A2 2 0 0 1 11 9.5" />
      </>
    ),
    tokens: (
      <>
        <circle cx="5.5" cy="8" r="2.5" />
        <path d="M8 8 L14 8 M11.5 8 L11.5 10.5" />
      </>
    ),
    admin: (
      <>
        <path d="M8 2 L13.5 4.5 V8 Q13.5 12 8 14 Q2.5 12 2.5 8 V4.5 Z" />
      </>
    ),
    upload: (
      <>
        <path d="M8 11.5 L8 3.5 M5 6.5 L8 3.5 L11 6.5" />
        <path d="M3 12.5 L13 12.5" />
      </>
    ),
    settings: (
      <>
        <circle cx="8" cy="8" r="2.25" />
        <path d="M8 1.5 v1.75 M8 12.75 V14.5 M1.5 8 h1.75 M12.75 8 H14.5 M3.4 3.4 l1.25 1.25 M11.35 11.35 l1.25 1.25 M12.6 3.4 l-1.25 1.25 M4.65 11.35 L3.4 12.6" />
      </>
    ),
    overview: (
      <>
        <circle cx="8" cy="8" r="5.5" />
        <path d="M8 8 L8 4.5 M8 8 L11 9.5" />
      </>
    ),
  };

  return (
    <svg
      viewBox="0 0 16 16"
      className="size-3.5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {paths[icon]}
    </svg>
  );
}
