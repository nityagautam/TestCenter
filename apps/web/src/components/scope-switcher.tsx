"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

/**
 * Organisation and project switchers.
 *
 * Both navigate rather than mutating hidden session state, because scope lives in
 * the URL — switching org changes the address, so the result is shareable and the
 * back button behaves. A dropdown that silently changed a server-side "current org"
 * would make every link ambiguous to whoever received it.
 */
export interface ScopeOption {
  slug: string;
  name: string;
  badge?: string;
}

export function ScopeSwitcher({
  label,
  current,
  options,
  hrefFor,
  emptyLabel,
  createHref,
  createLabel,
}: {
  label: string;
  current: ScopeOption | null;
  options: ScopeOption[];
  hrefFor: (slug: string) => string;
  emptyLabel: string;
  createHref?: string;
  createLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click and on Escape, which is what every dropdown should do and
  // what keyboard users will try first.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent): void {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const visible = filter.trim()
    ? options.filter(
        (option) =>
          option.name.toLowerCase().includes(filter.toLowerCase()) ||
          option.slug.toLowerCase().includes(filter.toLowerCase()),
      )
    : options;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen((value) => !value);
          setFilter("");
        }}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="flex max-w-[15rem] items-center gap-1.5 rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1.5 text-xs transition-colors hover:border-[var(--color-ink-muted)]"
      >
        <span className="text-[10px] tracking-wide text-[var(--color-ink-muted)] uppercase">
          {label}
        </span>
        <span className="truncate font-medium">{current?.name ?? emptyLabel}</span>
        <svg viewBox="0 0 12 12" className="size-3 shrink-0 opacity-50" aria-hidden>
          <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>

      {open ? (
        <div
          role="listbox"
          className="absolute left-0 z-30 mt-1 w-72 overflow-hidden rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] shadow-lg"
        >
          {/* Only worth a filter box once the list is long enough to scan poorly. */}
          {options.length > 7 ? (
            <div className="border-b border-[var(--color-border-subtle)] p-2">
              <input
                autoFocus
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder={`Filter ${label.toLowerCase()}…`}
                className="w-full rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1 text-xs outline-none focus:border-[var(--color-ink-muted)]"
              />
            </div>
          ) : null}

          <ul className="max-h-72 overflow-y-auto p-1">
            {visible.length === 0 ? (
              <li className="px-2 py-3 text-center text-xs text-[var(--color-ink-muted)]">
                Nothing matches
              </li>
            ) : null}
            {visible.map((option) => (
              <li key={option.slug}>
                <Link
                  href={hrefFor(option.slug)}
                  onClick={() => setOpen(false)}
                  className={`flex items-center justify-between gap-2 rounded px-2 py-1.5 text-xs hover:bg-[var(--color-surface)] ${
                    option.slug === current?.slug ? "bg-[var(--color-surface)] font-semibold" : ""
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block truncate">{option.name}</span>
                    <span className="block truncate font-mono text-[10px] text-[var(--color-ink-muted)]">
                      {option.slug}
                    </span>
                  </span>
                  {option.badge ? (
                    <span className="shrink-0 rounded bg-[var(--color-border-subtle)] px-1.5 py-0.5 text-[10px]">
                      {option.badge}
                    </span>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>

          {createHref ? (
            <div className="border-t border-[var(--color-border-subtle)] p-1">
              <Link
                href={createHref}
                onClick={() => setOpen(false)}
                className="block rounded px-2 py-1.5 text-xs text-[var(--color-ink-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-ink)]"
              >
                + {createLabel ?? "Create new"}
              </Link>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
