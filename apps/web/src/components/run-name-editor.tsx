"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * Inline rename for a run's name, for admins.
 *
 * Reads as text until you choose to edit it, rather than sitting in a text input
 * permanently: the run title is read a hundred times for every time it is changed, and a
 * boxed input would suggest the name is a form field you must fill in. The control only
 * renders for someone who can actually use it, and non-admins get plain text with no
 * affordance at all.
 *
 * Two variants, because the same name is a page title in one place and one row of a list
 * in another:
 *
 * - `heading` — the run page's `<h1>`, with the full "empty clears the name" helper text.
 * - `inline` — a list row, where the name stays a link to the run and the rename control
 *   sits beside it. It must not swallow the link: navigating to a run is the common
 *   action by orders of magnitude, and renaming is the rare one.
 *
 * Not optimistic, unlike `TagEditor`. A tag is one chip among many and a failed write is
 * obvious; the name is the thing you identify the run by, and showing a rename that did
 * not persist would leave you believing shared links now say something they do not. So it
 * saves, then refreshes from the server.
 */
export function RunNameEditor({
  runId,
  orgSlug,
  name,
  fallback,
  variant = "heading",
  href,
  textClass = "text-sm",
}: {
  runId: string;
  orgSlug: string;
  /** Current stored name; null when the run has never been named. */
  name: string | null;
  /** What is shown when there is no name — usually the framework. */
  fallback: string;
  variant?: "heading" | "inline";
  /** Where the name links to. Required for `inline`; ignored for `heading`. */
  href?: string;
  /**
   * Type scale for the `inline` name, so it matches the text it replaces. The runs list
   * sets `text-sm`; the compact "recent runs" widgets on the dashboards are `text-xs`.
   */
  textClass?: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  function cancel(): void {
    setDraft(name ?? "");
    setError(null);
    setEditing(false);
  }

  async function save(): Promise<void> {
    const next = draft.trim();
    if (next === (name ?? "")) {
      cancel();
      return;
    }

    setError(null);
    const response = await fetch(`/api/v1/runs/${runId}/name`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // null clears the name, restoring the framework fallback.
      body: JSON.stringify({ orgSlug, name: next.length > 0 ? next : null }),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setError(body?.error?.message ?? "could not rename this run");
      return;
    }

    setEditing(false);
    startTransition(() => router.refresh());
  }

  const renameButton = (
    <button
      type="button"
      onClick={() => setEditing(true)}
      // Named for what it does to what: a screen reader hears "Rename run <name>", not a
      // list of fifty identical "edit" buttons.
      aria-label={`Rename run ${name ?? fallback}`}
      className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-[var(--color-ink-muted)] underline hover:text-[var(--color-ink)] focus-visible:ring-2 focus-visible:ring-[var(--color-ink)] focus-visible:outline-none"
    >
      rename
    </button>
  );

  if (!editing) {
    if (variant === "inline") {
      return (
        <span className="flex min-w-0 items-center gap-2">
          <Link
            href={href ?? "#"}
            className={`truncate font-medium hover:underline ${textClass}`}
            title={name ?? fallback}
          >
            {name ?? fallback}
          </Link>
          {renameButton}
        </span>
      );
    }
    return (
      <span className="flex min-w-0 items-center gap-2">
        <h1 className="min-w-0 truncate text-xl font-semibold tracking-tight" title={name ?? ""}>
          {name ?? fallback}
        </h1>
        {renameButton}
      </span>
    );
  }

  return (
    <span className="flex min-w-0 flex-wrap items-center gap-2">
      <input
        ref={inputRef}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          // Enter saves and Escape reverts, so the common path never needs the buttons.
          if (event.key === "Enter") {
            event.preventDefault();
            void save();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            cancel();
          }
        }}
        maxLength={200}
        autoFocus
        aria-label="Run name"
        placeholder={fallback}
        className={`min-w-0 flex-1 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1 focus-visible:ring-2 focus-visible:ring-[var(--color-ink)] focus-visible:outline-none ${
          // Matches the text it replaces in each context, so nothing jumps size on click.
          variant === "inline"
            ? `basis-48 font-medium ${textClass}`
            : "basis-64 text-lg font-semibold tracking-tight"
        }`}
      />
      <button
        type="button"
        onClick={() => void save()}
        disabled={pending}
        className="shrink-0 rounded-md bg-[var(--color-ink)] px-2.5 py-1 text-xs font-medium text-[var(--color-surface)] disabled:opacity-60"
      >
        {pending ? "saving…" : "Save"}
      </button>
      <button
        type="button"
        onClick={cancel}
        className="shrink-0 rounded-md px-2 py-1 text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
      >
        Cancel
      </button>
      {/* Empty means "clear the name", which is not obvious, so it is stated. Suppressed in
          a list row, where a helper line per row would push every other row down. */}
      {variant === "heading" ? (
        <span className="basis-full font-mono text-[10px] text-[var(--color-ink-muted)]">
          {draft.trim().length === 0
            ? `empty clears the name — the heading falls back to "${fallback}"`
            : "enter saves · esc cancels"}
        </span>
      ) : null}
      {error ? (
        <span role="alert" className="basis-full text-[11px] text-[var(--color-status-failed)]">
          {error}
        </span>
      ) : null}
    </span>
  );
}
