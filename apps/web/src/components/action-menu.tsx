"use client";

import { useEffect, useRef, useState } from "react";

/**
 * An overflow menu of actions, opened from a ⋯ trigger.
 *
 * Sibling to `FilterMenu`, not a variant of it: that one is a single-choice control whose
 * options are links carrying `menuitemradio` semantics, because the choice lives in the
 * URL. These are commands — they mutate something and have no "current value" — so the
 * items are buttons with `menuitem`, and the trigger shows no state.
 *
 * The keyboard behaviour is copied from it deliberately, down to Escape returning focus
 * to the trigger and Tab dismissing without it. Two menus in one app that answer the
 * keyboard differently is worse than either behaviour on its own.
 *
 * Why a menu rather than a row of buttons: an action per row, spelled out, is a word
 * repeated down the whole list — the same noise that made a per-row "history" link and a
 * per-row "rename" link wrong. One ⋯ is labelled once, and it has somewhere to put the
 * next action rather than growing the row.
 */
export interface ActionItem {
  label: string;
  onSelect: () => void;
  /** Destructive items are red and sit below a divider. */
  tone?: "default" | "destructive";
  disabled?: boolean;
}

export function ActionMenu({
  items,
  label,
  align = "right",
}: {
  items: ActionItem[];
  /** Names the trigger for screen readers, e.g. "Actions for run Nightly sanity". */
  label: string;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  function close(returnFocus = true): void {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }

  function openMenu(): void {
    // Commands have no current value, so the highlight starts at the top rather than on
    // a "selected" item — and never on a destructive one.
    setActiveIndex(0);
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
        setActiveIndex((index) => Math.min(index + 1, items.length - 1));
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
        setActiveIndex(Math.max(items.length - 1, 0));
        break;
      case "Tab":
        close(false);
        break;
      default:
        break;
    }
  }

  if (items.length === 0) return null;

  return (
    <div ref={containerRef} className="relative shrink-0">
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
        aria-label={label}
        // 24px square: the glyph is small but the target clears the minimum, which a
        // 10px text link never did.
        className="flex size-6 items-center justify-center rounded text-[var(--color-ink-muted)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-ink)] focus-visible:ring-2 focus-visible:ring-[var(--color-ink)] focus-visible:outline-none"
      >
        <Ellipsis />
      </button>

      {open ? (
        <div
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKeyDown}
          className={`absolute z-40 mt-1 w-44 overflow-hidden rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-1 shadow-lg ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          {items.map((item, index) => (
            <div key={item.label}>
              {/* A divider above the first destructive item, so "delete" is never the
                  thing the pointer lands on by momentum. */}
              {item.tone === "destructive" && index > 0 ? (
                <div className="my-1 h-px bg-[var(--color-border-subtle)]" />
              ) : null}
              <button
                ref={(node) => {
                  itemRefs.current[index] = node;
                }}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                tabIndex={index === activeIndex ? 0 : -1}
                onClick={() => {
                  close(false);
                  item.onSelect();
                }}
                className={`block w-full rounded px-2 py-1.5 text-left text-xs outline-none disabled:opacity-40 ${
                  item.tone === "destructive"
                    ? "text-[var(--color-status-failed)] hover:bg-[var(--color-status-failed)]/10 focus-visible:bg-[var(--color-status-failed)]/10"
                    : "hover:bg-[var(--color-surface)] focus-visible:bg-[var(--color-surface)]"
                }`}
              >
                {item.label}
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Ellipsis() {
  return (
    <svg viewBox="0 0 16 16" className="size-4" fill="currentColor" aria-hidden>
      <circle cx="3.5" cy="8" r="1.4" />
      <circle cx="8" cy="8" r="1.4" />
      <circle cx="12.5" cy="8" r="1.4" />
    </svg>
  );
}
