"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * Quarantine a known-flaky test.
 *
 * Quarantining keeps a test visible and still reported, but marks it as known-bad so
 * it stops dominating dashboards and (from Phase 4) stops failing quality gates.
 * That is deliberately different from deleting or skipping it — the goal is to stop
 * the noise without losing the signal that it is still broken.
 */
export function QuarantineToggle({
  orgSlug,
  testId,
  quarantined,
  reason,
}: {
  orgSlug: string;
  testId: number;
  quarantined: boolean;
  reason: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(reason ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function submit(next: boolean): Promise<void> {
    setError(null);
    const response = await fetch(`/api/v1/tests/${testId}/quarantine`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgSlug, quarantined: next, reason: draft.trim() || undefined }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setError(body?.error?.message ?? "could not update quarantine");
      return;
    }
    setOpen(false);
    startTransition(() => router.refresh());
  }

  if (quarantined) {
    return (
      <div className="text-right">
        <span className="inline-flex items-center gap-1.5 rounded bg-[var(--color-status-skipped)]/15 px-2 py-1 text-[11px]">
          <span className="inline-block size-2 rounded-full bg-[var(--color-status-skipped)]" />
          Quarantined
        </span>
        {reason ? (
          <p className="mt-1 max-w-56 text-[10px] text-[var(--color-ink-muted)]">{reason}</p>
        ) : null}
        <button
          type="button"
          onClick={() => void submit(false)}
          disabled={pending}
          className="mt-1 text-[10px] text-[var(--color-ink-muted)] underline hover:text-[var(--color-ink)]"
        >
          {pending ? "updating…" : "remove from quarantine"}
        </button>
        {error ? (
          <p className="mt-1 text-[10px] text-[var(--color-status-failed)]">{error}</p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="text-right">
      {open ? (
        <div className="space-y-1.5">
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Why? e.g. flaky under load"
            className="w-56 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1 text-[11px] outline-none focus:border-[var(--color-ink-muted)]"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-[11px] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
            >
              cancel
            </button>
            <button
              type="button"
              onClick={() => void submit(true)}
              disabled={pending}
              className="rounded-md border border-[var(--color-border-subtle)] px-2 py-1 text-[11px] font-medium hover:border-[var(--color-ink-muted)]"
            >
              {pending ? "saving…" : "Quarantine"}
            </button>
          </div>
          {error ? <p className="text-[10px] text-[var(--color-status-failed)]">{error}</p> : null}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1 text-[11px] hover:border-[var(--color-ink-muted)]"
        >
          Quarantine test
        </button>
      )}
    </div>
  );
}
