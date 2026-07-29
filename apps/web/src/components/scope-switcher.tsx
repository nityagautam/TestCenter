"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

/**
 * Organisation and project switcher.
 *
 * Navigates rather than mutating hidden session state, because scope lives in the URL —
 * switching organisation changes the address, so the result is shareable and the back
 * button behaves. A dropdown that silently changed a server-side "current org" would
 * make every link ambiguous to whoever received it.
 *
 * Keyboard behaviour is the part worth reading. A menu that only responds to a mouse is
 * a dead end for anyone navigating by keyboard, so this implements the pattern people
 * expect: Enter/Space/ArrowDown to open, arrows to move, Home/End to jump, typing to
 * filter, Escape to close, and focus returned to the trigger on close so Tab order does
 * not restart at the top of the page.
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
  const [activeIndex, setActiveIndex] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLAnchorElement | null)[]>([]);

  const visible = filter.trim()
    ? options.filter(
        (option) =>
          option.name.toLowerCase().includes(filter.toLowerCase()) ||
          option.slug.toLowerCase().includes(filter.toLowerCase()),
      )
    : options;

  function close(returnFocus = true): void {
    setOpen(false);
    setFilter("");
    if (returnFocus) triggerRef.current?.focus();
  }

  // Opening lands on the current selection rather than the first row, so the highlight
  // starts where the reader's attention already is.
  function openMenu(): void {
    const index = Math.max(
      options.findIndex((option) => option.slug === current?.slug),
      0,
    );
    setActiveIndex(index);
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    itemRefs.current[activeIndex]?.focus();
  }, [open, activeIndex]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent): void {
      if (!containerRef.current?.contains(event.target as Node)) close(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  function onMenuKeyDown(event: React.KeyboardEvent): void {
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        close();
        break;
      case "ArrowDown":
        event.preventDefault();
        setActiveIndex((index) => Math.min(index + 1, visible.length - 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((index) => Math.max(index - 1, 0));
        break;
      case "Home":
        event.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        event.preventDefault();
        setActiveIndex(Math.max(visible.length - 1, 0));
        break;
      case "Tab":
        // Tabbing out of a menu should dismiss it, not leave it hanging open behind
        // whatever gains focus next.
        close(false);
        break;
      default:
        break;
    }
  }

  const menuId = `scope-${label.toLowerCase()}-menu`;

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openMenu();
          }
        }}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={open ? menuId : undefined}
        /*
         * Stated explicitly rather than inferred from the child spans. The `label` span
         * is hidden below the `sm` breakpoint, and a hidden element is excluded from the
         * accessible name — so on a phone the button would announce only the current
         * value with no hint of what it switches.
         */
        aria-label={`${label}: ${current?.name ?? emptyLabel}. Change ${label.toLowerCase()}.`}
        className="flex max-w-[9rem] items-center gap-1.5 rounded-md border border-[var(--color-border-subtle)] px-2 py-1.5 text-xs transition-colors hover:border-[var(--color-ink-muted)] sm:max-w-[13rem]"
      >
        <span className="hidden text-[10px] tracking-wide text-[var(--color-ink-muted)] uppercase sm:inline">
          {label}
        </span>
        <span className="truncate font-medium">{current?.name ?? emptyLabel}</span>
        <svg viewBox="0 0 12 12" className="size-3 shrink-0 opacity-50" aria-hidden>
          <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>

      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label={`Switch ${label.toLowerCase()}`}
          onKeyDown={onMenuKeyDown}
          className="absolute left-0 z-40 mt-1 w-72 overflow-hidden rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] shadow-lg"
        >
          {options.length > 7 ? (
            <div className="border-b border-[var(--color-border-subtle)] p-2">
              <input
                value={filter}
                onChange={(event) => {
                  setFilter(event.target.value);
                  setActiveIndex(0);
                }}
                placeholder={`Filter ${label.toLowerCase()}…`}
                aria-label={`Filter ${label.toLowerCase()}`}
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
            {visible.map((option, index) => {
              const selected = option.slug === current?.slug;
              return (
                <li key={option.slug}>
                  <Link
                    ref={(node) => {
                      itemRefs.current[index] = node;
                    }}
                    href={hrefFor(option.slug)}
                    role="menuitemradio"
                    aria-checked={selected}
                    tabIndex={index === activeIndex ? 0 : -1}
                    onClick={() => close(false)}
                    className={`flex items-center justify-between gap-2 rounded px-2 py-1.5 text-xs outline-none hover:bg-[var(--color-surface)] focus-visible:bg-[var(--color-surface)] ${
                      selected ? "bg-[var(--color-surface)] font-semibold" : ""
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
              );
            })}
          </ul>

          {createHref ? (
            <div className="border-t border-[var(--color-border-subtle)] p-1">
              <Link
                href={createHref}
                role="menuitem"
                tabIndex={-1}
                onClick={() => close(false)}
                className="block rounded px-2 py-1.5 text-xs text-[var(--color-ink-muted)] outline-none hover:bg-[var(--color-surface)] hover:text-[var(--color-ink)] focus-visible:bg-[var(--color-surface)]"
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
