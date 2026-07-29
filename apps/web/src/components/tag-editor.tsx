"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RESERVED_TAG_KEYS } from "@testcenter/core";
import { TagChip } from "@/components/ui";

/**
 * Post-upload tag editing.
 *
 * Tags are wrong on first upload more often than not — a CI variable was unset, or a
 * team decides later it wants to slice by release. Making them immutable would push
 * people to re-upload the whole run, so they are editable in place and the results
 * stay put.
 */
export function TagEditor({
  runId,
  initialTags,
}: {
  runId: string;
  initialTags: Record<string, string>;
}) {
  const router = useRouter();
  const [tags, setTags] = useState(initialTags);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function persist(next: Record<string, string>): Promise<void> {
    setError(null);
    const previous = tags;
    // Optimistic: tag edits are trivially reversible, so waiting on a round trip
    // before showing the change just makes the UI feel sluggish.
    setTags(next);

    const response = await fetch(`/api/v1/runs/${runId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tags: next }),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setTags(previous);
      setError(body?.error?.message ?? "could not save tags");
      return;
    }
    startTransition(() => router.refresh());
  }

  function addFromDraft(): void {
    const match = /^([^:=]+)[:=](.*)$/.exec(draft.trim());
    if (!match) {
      setError("use key:value, for example release:24.9");
      return;
    }
    const key = (match[1] ?? "").trim().toLowerCase().replace(/\s+/g, "-");
    const value = (match[2] ?? "").trim();
    if (!key || !value) {
      setError("both a key and a value are required");
      return;
    }
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(key)) {
      setError("keys must be lowercase letters, digits, - or _");
      return;
    }
    setDraft("");
    void persist({ ...tags, [key]: value });
  }

  const entries = Object.entries(tags).sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {entries.length === 0 && !editing ? (
          <span className="text-[11px] text-[var(--color-ink-muted)]">No tags</span>
        ) : null}

        {entries.map(([key, value]) =>
          editing ? (
            <TagChip
              key={key}
              tagKey={key}
              value={value}
              onRemove={() => {
                const next = { ...tags };
                delete next[key];
                void persist(next);
              }}
            />
          ) : (
            <TagChip
              key={key}
              tagKey={key}
              value={value}
              href={`/runs?tag=${encodeURIComponent(`${key}:${value}`)}`}
            />
          ),
        )}

        <button
          type="button"
          onClick={() => {
            setEditing((value) => !value);
            setError(null);
          }}
          className="rounded px-1.5 py-0.5 text-[11px] text-[var(--color-ink-muted)] underline hover:text-[var(--color-ink)]"
        >
          {editing ? "done" : "edit tags"}
        </button>
        {pending ? (
          <span className="text-[11px] text-[var(--color-ink-muted)]">saving…</span>
        ) : null}
      </div>

      {editing ? (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addFromDraft();
                }
              }}
              placeholder="release:24.9"
              aria-label="Add tag as key:value"
              className="w-56 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1 font-mono text-[11px] outline-none focus:border-[var(--color-ink-muted)]"
            />
            <button
              type="button"
              onClick={addFromDraft}
              className="rounded-md border border-[var(--color-border-subtle)] px-2 py-1 text-[11px] hover:border-[var(--color-ink-muted)]"
            >
              add
            </button>
          </div>
          <p className="text-[11px] text-[var(--color-ink-muted)]">
            Reserved keys get first-class treatment:{" "}
            <span className="font-mono">{RESERVED_TAG_KEYS.slice(0, 8).join(", ")}</span>
          </p>
        </div>
      ) : null}

      {error ? <p className="text-[11px] text-[var(--color-status-failed)]">{error}</p> : null}
    </div>
  );
}
