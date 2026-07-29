"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/**
 * Navigation link that knows whether it is the current page.
 *
 * Needs the pathname, so it is the one client component in the shell. `exact`
 * distinguishes a section root from its children: without it, "Dashboard"
 * (`/o/acme`) would highlight while you are on `/o/acme/runs`, since every path in
 * the org starts with the dashboard's href.
 */
export function NavLink({
  href,
  children,
  exact = false,
}: {
  href: string;
  children: ReactNode;
  exact?: boolean;
}) {
  const pathname = usePathname();
  const active = exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <li>
      <Link
        href={href}
        aria-current={active ? "page" : undefined}
        className={`block rounded px-2 py-1.5 text-xs transition-colors ${
          active
            ? "bg-[var(--color-surface-raised)] font-semibold"
            : "text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-ink)]"
        }`}
      >
        {children}
      </Link>
    </li>
  );
}
