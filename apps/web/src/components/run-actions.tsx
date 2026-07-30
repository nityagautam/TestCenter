"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { MAX_RUN_NAME_LENGTH } from "@testcenter/core";
import { ActionMenu, type ActionItem } from "@/components/action-menu";

/**
 * Every action on a run, behind one ⋯ trigger.
 *
 * Replaces a separate inline rename control and a separate delete button. Those were two
 * affordances competing for the same corner of the row, and the rename one was a word
 * repeated down every list — the noise we removed from the per-row "history" link, then
 * reintroduced. One menu, labelled once, with room for the next action.
 *
 * The menu only lists what the viewer can actually do, and renders nothing at all when
 * that set is empty, so a viewer's list has no dead controls in it.
 *
 * Each action expands in place rather than in a modal: renaming shows an input where the
 * name is, deleting shows its confirmation under the row. A modal would cover the very
 * thing you are deciding about — which run this is, and how many results it holds.
 */
type Mode = "idle" | "rename" | "delete";

export function RunActions({
  runId,
  orgSlug,
  name,
  fallback,
  totalTests,
  canRename,
  canDelete,
  deleteRedirectTo,
  align = "right",
}: {
  runId: string;
  orgSlug: string;
  /** Stored name; null when the run has never been named. */
  name: string | null;
  /** Shown when there is no name — usually the framework. */
  fallback: string;
  totalTests: number;
  canRename: boolean;
  canDelete: boolean;
  /** Where to land after deleting; this run's own page will 404. */
  deleteRedirectTo: string;
  align?: "left" | "right";
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("idle");
  const [draft, setDraft] = useState(name ?? "");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (mode === "rename") inputRef.current?.select();
  }, [mode]);

  const label = name ?? fallback;

  function reset(): void {
    setMode("idle");
    setDraft(name ?? "");
    setConfirmation("");
    setError(null);
  }

  async function saveName(): Promise<void> {
    const next = draft.trim();
    if (next === (name ?? "")) {
      reset();
      return;
    }
    setPending(true);
    setError(null);

    const response = await fetch(`/api/v1/runs/${runId}/name`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // null clears the name, restoring the framework fallback.
      body: JSON.stringify({ orgSlug, name: next.length > 0 ? next : null }),
    });

    if (!response.ok) {
      setError((await messageFrom(response)) ?? "could not rename this run");
      setPending(false);
      return;
    }
    setPending(false);
    setMode("idle");
    router.refresh();
  }

  async function remove(): Promise<void> {
    if (confirmation.trim() !== label.trim()) return;
    setPending(true);
    setError(null);

    const response = await fetch(`/api/v1/runs/${runId}?orgSlug=${encodeURIComponent(orgSlug)}`, {
      method: "DELETE",
    });

    if (!response.ok) {
      setError((await messageFrom(response)) ?? "could not delete this run");
      setPending(false);
      return;
    }
    // replace(), not push(): the deleted run's URL must not sit in history where Back
    // returns to a page that now 404s.
    router.replace(deleteRedirectTo);
  }

  const items: ActionItem[] = [
    ...(canRename
      ? [{ label: name ? "Rename…" : "Name this run…", onSelect: () => setMode("rename") }]
      : []),
    ...(canDelete
      ? [
          {
            label: "Delete run…",
            tone: "destructive" as const,
            onSelect: () => setMode("delete"),
          },
        ]
      : []),
  ];

  if (mode === "rename") {
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void saveName();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              reset();
            }
          }}
          maxLength={MAX_RUN_NAME_LENGTH}
          autoFocus
          aria-label="Run name"
          placeholder={fallback}
          className="min-w-0 flex-1 basis-56 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1 text-sm font-medium outline-none focus:border-[var(--color-ink-muted)]"
        />
        <button
          type="button"
          onClick={() => void saveName()}
          disabled={pending}
          className="shrink-0 rounded-md bg-[var(--color-ink)] px-2.5 py-1 text-xs font-medium text-[var(--color-surface)] disabled:opacity-60"
        >
          {pending ? "saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={reset}
          className="shrink-0 px-1 text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
        >
          Cancel
        </button>
        <span className="basis-full font-mono text-[10px] text-[var(--color-ink-muted)]">
          {draft.trim().length === 0
            ? `empty clears the name — falls back to "${fallback}"`
            : "enter saves · esc cancels"}
        </span>
        {error ? (
          <span role="alert" className="basis-full text-[11px] text-[var(--color-status-failed)]">
            {error}
          </span>
        ) : null}
      </div>
    );
  }

  if (mode === "delete") {
    const matches = confirmation.trim() === label.trim();
    return (
      <div className="w-full max-w-md rounded-md border border-[var(--color-status-failed)]/40 bg-[var(--color-status-failed)]/5 p-3">
        <p className="text-xs font-medium">Delete this run permanently?</p>
        <p className="mt-1 text-[11px] leading-relaxed text-[var(--color-ink-muted)]">
          {totalTests.toLocaleString()} result{totalTests === 1 ? "" : "s"}, their stack traces and
          captured output, and the uploaded report go with it. Trends and flake scores are
          recalculated without it. This cannot be undone.
        </p>

        <label className="mt-2.5 block">
          <span className="text-[11px] text-[var(--color-ink-muted)]">
            Type <span className="font-mono text-[var(--color-ink)]">{label}</span> to confirm
          </span>
          <input
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && matches) void remove();
              if (event.key === "Escape") reset();
            }}
            autoFocus
            aria-label={`Type the run name ${label} to confirm deletion`}
            className="mt-1 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1 font-mono text-xs outline-none focus:border-[var(--color-status-failed)]"
          />
        </label>

        <div className="mt-2.5 flex items-center gap-2">
          <button
            type="button"
            onClick={() => void remove()}
            disabled={!matches || pending}
            className="rounded-md bg-[var(--color-status-failed)] px-2.5 py-1 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pending ? "deleting…" : "Delete permanently"}
          </button>
          <button
            type="button"
            onClick={reset}
            className="px-1 text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
          >
            Cancel
          </button>
        </div>

        {error ? (
          <p role="alert" className="mt-2 text-[11px] text-[var(--color-status-failed)]">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return <ActionMenu items={items} label={`Actions for run ${label}`} align={align} />;
}

async function messageFrom(response: Response): Promise<string | null> {
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  return body?.error?.message ?? null;
}
