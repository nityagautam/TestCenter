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
}: {
  action: string;
  defaultValue: string;
  hidden?: Record<string, string>;
  placeholder?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <form action={action} method="get" className="flex gap-2">
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
          className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-2 pr-16 text-xs outline-none focus:border-[var(--color-ink-muted)]"
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

      <button
        type="submit"
        className="rounded-md border border-[var(--color-border-subtle)] px-3 py-2 text-xs font-medium hover:border-[var(--color-ink-muted)]"
      >
        Search
      </button>
    </form>
  );
}
