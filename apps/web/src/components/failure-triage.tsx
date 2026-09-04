"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  FAILURE_TRIAGE_LABELS,
  FAILURE_TRIAGES,
  MAX_VERDICT_NOTE_LENGTH,
  type FailureTriage,
} from "@testcenter/core";

/**
 * One line each, so the picker explains itself without documentation. Same idea as
 * `VERDICT_HINTS` in `run-actions`, and worth repeating because the two vocabularies are
 * genuinely different and a reader will otherwise assume they mean the same things.
 */
const TRIAGE_HINTS: Record<FailureTriage, string> = {
  "product-bug": "A genuine regression; someone owns a fix",
  "test-bug": "The test is wrong, not the product",
  infra: "Environment, data or dependency — not the code under test",
  flaky: "Non-deterministic, so not a real signal either way",
  "known-issue": "Real, understood and tracked elsewhere; stop re-triaging it",
  investigating: "Seen, not yet concluded",
};

/**
 * The current category on a failure signature, and the control to change it.
 *
 * Renders as a chip plus an inline picker rather than a modal, for the reason `run-actions`
 * gives: a dialog covers the very thing being judged — the error message and how often it has
 * happened — which is the evidence the decision rests on.
 *
 * Read-only for anyone without `failure:triage`. The chip still shows, because the category is
 * information everyone needs; only the claim is restricted. A viewer sees no dead control.
 */
export function FailureTriageControl({
  orgSlug,
  projectId,
  signatureHex,
  title,
  sampleMessage,
  current,
  currentNote,
  author,
  canTriage,
}: {
  orgSlug: string;
  projectId: string;
  signatureHex: string;
  title: string;
  sampleMessage?: string | null;
  current?: string | null;
  currentNote?: string | null;
  author?: string | null;
  canTriage: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState<FailureTriage | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const label = current
    ? (FAILURE_TRIAGE_LABELS[current as FailureTriage] ?? current)
    : "Untriaged";

  async function submit(category: FailureTriage): Promise<void> {
    setSaving(category);
    setError(null);
    try {
      const response = await fetch(`/api/v1/failures/${signatureHex}/triage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orgSlug,
          projectId,
          category,
          note: note.trim() || undefined,
          // Sent, not derived server-side, because it has to be stored: `test_results` is
          // retention-bound, so a triage older than its failures would otherwise render as a
          // bare hex digest.
          title,
          sampleMessage,
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(body?.error?.message ?? `request failed (${response.status})`);
        return;
      }
      setOpen(false);
      setNote("");
      // The category is read by the dashboard tiles and this page's own list, so a refresh is
      // the honest way to reflect it — optimistically patching one chip would leave the rest
      // of the page disagreeing with the database.
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "request failed");
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="mt-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {/* Dashed when untriaged, matching how VerdictBadge distinguishes "nothing recorded"
            from a real judgement — an open item rather than a bad one. */}
        <span
          className={
            current
              ? "inline-flex shrink-0 items-center rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap"
              : "inline-flex shrink-0 items-center rounded border border-dashed border-[var(--color-series-1)]/50 bg-[var(--color-series-1)]/10 px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap text-[var(--color-series-1)]"
          }
          title={
            current
              ? `${label}${author ? ` — ${author}` : ""}${currentNote ? `: ${currentNote}` : ""}`
              : "Nobody has categorised this failure cause yet"
          }
        >
          {label}
        </span>
        {canTriage ? (
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="text-[10px] text-[var(--color-ink-muted)] underline hover:text-[var(--color-ink)]"
          >
            {open ? "cancel" : current ? "change" : "categorise"}
          </button>
        ) : null}
      </div>

      {open ? (
        <div className="mt-2 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-2">
          <p className="mb-1.5 text-[10px] leading-relaxed text-[var(--color-ink-muted)]">
            Applies to this failure <em>cause</em>, so every later occurrence inherits it —
            including in tests nobody has opened yet. Corrections are recorded, not overwritten.
          </p>
          <div className="flex flex-wrap gap-1">
            {FAILURE_TRIAGES.map((category) => (
              <button
                key={category}
                type="button"
                disabled={saving !== null}
                onClick={() => void submit(category)}
                title={TRIAGE_HINTS[category]}
                className={`rounded border px-1.5 py-0.5 text-[10px] disabled:opacity-50 ${
                  category === current
                    ? "border-[var(--color-ink-muted)] font-semibold"
                    : "border-[var(--color-border-subtle)] hover:border-[var(--color-ink-muted)]"
                }`}
              >
                {saving === category ? "saving…" : FAILURE_TRIAGE_LABELS[category]}
              </button>
            ))}
          </div>
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={MAX_VERDICT_NOTE_LENGTH}
            placeholder="Optional note — a ticket id, or why"
            className="mt-2 w-full rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1 text-[11px]"
          />
          {error ? (
            <p className="mt-1.5 text-[10px] text-[var(--color-status-failed)]">{error}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
