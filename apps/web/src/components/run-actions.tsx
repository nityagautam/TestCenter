"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  MAX_RUN_NAME_LENGTH,
  MAX_VERDICT_NOTE_LENGTH,
  RUN_VERDICT_LABELS,
  RUN_VERDICTS,
  type RunVerdict,
} from "@testcenter/core";
import { ActionMenu, type ActionItem } from "@/components/action-menu";
import { TagEditor } from "@/components/tag-editor";

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
/** One line each, so the picker is self-explanatory without documentation. */
const VERDICT_HINTS: Record<RunVerdict, string> = {
  pass: "Reviewed — the failures here are known and tolerated",
  "product-bug": "A genuine regression; someone owns a fix",
  infra: "Environment or data, not the code under test",
  flaky: "Non-deterministic, so not a real signal either way",
  investigating: "Seen, not yet judged",
};

type Mode = "idle" | "rename" | "delete" | "verdict" | "tags";

export function RunActions({
  runId,
  orgSlug,
  name,
  fallback,
  totalTests,
  canRename,
  canDelete,
  canVerdict = false,
  canEditTags = false,
  tags,
  currentVerdict = null,
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
  canVerdict?: boolean;
  /** Tag editing is `run:edit` (member), unlike the admin-only actions beside it. */
  canEditTags?: boolean;
  tags?: Record<string, string>;
  /** The verdict already on the run, so the picker opens on it rather than blank. */
  currentVerdict?: string | null;
  /** Where to land after deleting; this run's own page will 404. */
  deleteRedirectTo: string;
  align?: "left" | "right";
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("idle");
  const [draft, setDraft] = useState(name ?? "");
  const [confirmation, setConfirmation] = useState("");
  const [verdict, setVerdict] = useState<string>(currentVerdict ?? "investigating");
  const [verdictNote, setVerdictNote] = useState("");
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
    setVerdict(currentVerdict ?? "investigating");
    setVerdictNote("");
    setError(null);
  }

  async function saveVerdict(): Promise<void> {
    setPending(true);
    setError(null);

    const response = await fetch(`/api/v1/runs/${runId}/verdict`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgSlug, verdict, note: verdictNote.trim() || null }),
    });

    if (!response.ok) {
      setError((await messageFrom(response)) ?? "could not record this verdict");
      setPending(false);
      return;
    }
    setPending(false);
    setMode("idle");
    setVerdictNote("");
    router.refresh();
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
    ...(canEditTags && tags ? [{ label: "Edit tags…", onSelect: () => setMode("tags") }] : []),
    ...(canVerdict
      ? [
          {
            label: currentVerdict ? "Change verdict…" : "Add verdict…",
            onSelect: () => setMode("verdict"),
          },
        ]
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

  if (mode === "tags" && tags) {
    return (
      <div className="w-full max-w-md rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3">
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <p className="text-xs font-medium">Tags</p>
          <button
            type="button"
            onClick={reset}
            className="text-[11px] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
          >
            close
          </button>
        </div>
        {/* Chips are rendered here while editing so removal targets exist; the read-only
            view lives in the metadata strip, which is why the editor does not repeat them
            when closed. */}
        <TagEditor runId={runId} initialTags={tags} startOpen />
      </div>
    );
  }

  if (mode === "verdict") {
    return (
      <div className="w-full max-w-sm rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3">
        <p className="text-xs font-medium">Why did this run look like this?</p>
        <p className="mt-1 text-[10px] leading-relaxed text-[var(--color-ink-muted)]">
          Recorded against the run with your name and the time. Corrections are kept as history
          rather than overwriting what was said before.
        </p>

        <div className="mt-2.5 space-y-1">
          {RUN_VERDICTS.map((option) => (
            <label
              key={option}
              className={`flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 text-[11px] ${
                verdict === option
                  ? "bg-[var(--color-surface)] font-medium"
                  : "hover:bg-[var(--color-surface)]"
              }`}
            >
              <input
                type="radio"
                name={`verdict-${runId}`}
                value={option}
                checked={verdict === option}
                onChange={() => setVerdict(option)}
                className="mt-0.5"
              />
              <span className="min-w-0">
                <span className="block">{RUN_VERDICT_LABELS[option]}</span>
                <span className="block text-[10px] text-[var(--color-ink-muted)]">
                  {VERDICT_HINTS[option]}
                </span>
              </span>
            </label>
          ))}
        </div>

        <input
          value={verdictNote}
          onChange={(event) => setVerdictNote(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void saveVerdict();
            if (event.key === "Escape") reset();
          }}
          maxLength={MAX_VERDICT_NOTE_LENGTH}
          placeholder="Optional note — the sentence that helps the next person"
          aria-label="Verdict note"
          className="mt-2.5 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1 text-[11px] outline-none focus:border-[var(--color-ink-muted)]"
        />

        <div className="mt-2.5 flex items-center gap-2">
          <button
            type="button"
            onClick={() => void saveVerdict()}
            disabled={pending}
            className="rounded-md bg-[var(--color-ink)] px-2.5 py-1 text-xs font-medium text-[var(--color-surface)] disabled:opacity-60"
          >
            {pending ? "saving…" : "Record verdict"}
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
