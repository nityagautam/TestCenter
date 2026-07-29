"use client";

import { useRef } from "react";

/**
 * Search input that submits as a GET form.
 *
 * A plain form rather than debounced fetch-as-you-type: the result is a real URL, so
 * a search is shareable and the back button returns to the previous query. Existing
 * filters ride along as hidden fields so searching does not silently discard them.
 */
export function SearchBox({
  action,
  defaultValue,
  hidden = {},
  placeholder = "Search…",
  className = "flex-1",
}: {
  action: string;
  defaultValue: string;
  hidden?: Record<string, string>;
  placeholder?: string;
  /**
   * Width, decided by the caller.
   *
   * It used to stretch to the full content width, which is a lot of runway for a query
   * that is usually one word, and it pushed the filters onto a row of their own. The page
   * knows what else is on the line; the input does not.
   */
  className?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <form action={action} method="get" className={`flex gap-2 ${className}`}>
      {Object.entries(hidden).map(([key, value]) => (
        <input key={key} type="hidden" name={key} value={value} />
      ))}

      <div className="relative flex-1">
        <input
          ref={inputRef}
          name="q"
          defaultValue={defaultValue}
          placeholder={placeholder}
          aria-label="Search tests"
          className={`h-9 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 text-xs outline-none focus:border-[var(--color-ink-muted)] ${
            // Room for the clear button, but only when there is one to make room for.
            defaultValue ? "pr-12" : ""
          }`}
        />
        {defaultValue ? (
          <button
            type="button"
            onClick={() => {
              if (inputRef.current) inputRef.current.value = "";
              inputRef.current?.form?.requestSubmit();
            }}
            className="absolute top-1/2 right-2 -translate-y-1/2 text-[11px] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
          >
            clear
          </button>
        ) : null}
      </div>

      {/* h-9 is the shared control height for this toolbar. Padding-derived heights left
          the segmented filter visibly shorter than the field and the buttons beside it,
          which reads as three unrelated controls rather than one row. */}
      <button
        type="submit"
        className="h-9 shrink-0 rounded-md border border-[var(--color-border-subtle)] px-3 text-xs font-medium hover:border-[var(--color-ink-muted)]"
      >
        Search
      </button>
    </form>
  );
}
