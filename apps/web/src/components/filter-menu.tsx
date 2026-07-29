"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

/**
 * A single-choice dropdown whose options are links.
 *
 * Links rather than a `<select>` because the choice lives in the URL: the result is
 * shareable, the back button undoes it, and it works before hydration. A select would need
 * JavaScript to navigate and would leave the URL and the control disagreeing until it ran.
 *
 * Used for ordering, where a menu is the right shape — one answer, five options, and the
 * current one worth showing on the trigger. Status stays a segmented control instead: it is
 * the filter people reach for constantly, and a menu would turn "show me the failing tests"
 * from one click into two while hiding which state is active.
 *
 * The keyboard behaviour here is deliberately the same as the scope switcher's: Enter,
 * Space or ArrowDown to open, arrows and Home/End to move, Escape to close with focus
 * returned to the trigger, Tab to dismiss. Two menus in one app that answer the keyboard
 * differently is worse than either behaviour on its own.
 */
export interface FilterOption {
  label: string;
  href: string;
  active: boolean;
}

export function FilterMenu({
  label,
  options,
  align = "right",
}: {
  label: string;
  options: FilterOption[];
  /** Which edge the panel hangs from, so it never opens off-screen. */
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLAnchorElement | null)[]>([]);

  const current = options.find((option) => option.active) ?? options[0];

  function close(returnFocus = true): void {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }

  // Opening lands on the current choice, so the highlight starts where attention is.
  function openMenu(): void {
    setActiveIndex(
      Math.max(
        options.findIndex((option) => option.active),
        0,
      ),
    );
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
        setActiveIndex((index) => Math.min(index + 1, options.length - 1));
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
        setActiveIndex(Math.max(options.length - 1, 0));
        break;
      case "Tab":
        close(false);
        break;
      default:
        break;
    }
  }

  const menuId = `filter-${label.toLowerCase().replace(/\s+/g, "-")}-menu`;

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
        // Stated in full: the label is what the control does, the value is its state, and a
        // trigger that announces only one of the two is ambiguous read on its own.
        aria-label={`${label}: ${current?.label ?? "none"}. Change ${label.toLowerCase()}.`}
        className="flex h-9 items-center gap-1.5 rounded-md border border-[var(--color-border-subtle)] px-3 text-xs whitespace-nowrap transition-colors hover:border-[var(--color-ink-muted)]"
      >
        <span className="text-[var(--color-ink-muted)]">{label}</span>
        <span className="font-medium">{current?.label}</span>
        <Chevron open={open} />
      </button>

      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label={`Change ${label.toLowerCase()}`}
          onKeyDown={onMenuKeyDown}
          className={`absolute z-40 mt-1 w-48 overflow-hidden rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-1 shadow-lg ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          {options.map((option, index) => (
            <Link
              key={option.label}
              ref={(node) => {
                itemRefs.current[index] = node;
              }}
              href={option.href}
              role="menuitemradio"
              aria-checked={option.active}
              tabIndex={index === activeIndex ? 0 : -1}
              onClick={() => close(false)}
              className={`flex items-center justify-between gap-2 rounded px-2 py-1.5 text-xs outline-none hover:bg-[var(--color-surface)] focus-visible:bg-[var(--color-surface)] ${
                option.active ? "bg-[var(--color-surface)] font-semibold" : ""
              }`}
            >
              {option.label}
              {option.active ? <Check /> : null}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={`size-3 shrink-0 text-[var(--color-ink-muted)] transition-transform ${
        open ? "rotate-180" : ""
      }`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 6.5 8 10.5l4-4" />
    </svg>
  );
}

function Check() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-3 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3.5 8.5 6.5 11.5l6-7" />
    </svg>
  );
}
