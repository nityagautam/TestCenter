"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ActionMenu, type ActionItem } from "@/components/action-menu";

/**
 * Actions on a test, behind the same ⋯ trigger runs use.
 *
 * Replaces the bespoke `QuarantineToggle`, which existed only on the test detail page —
 * so the flaky leaderboard could tell you a test was flaky but not let you do anything
 * about it, which is the one screen where you actually want to.
 *
 * Quarantining asks for a reason and reactivating does not, deliberately. Quarantine is a
 * claim about a test that someone else will read later ("flaky under load"), and an
 * unexplained one is indistinguishable from a test nobody looked at. Reactivating is the
 * reversal of that claim, needs no justification, and is one click.
 */
type Mode = "idle" | "quarantine";

export function TestActions({
  testId,
  orgSlug,
  testName,
  quarantined,
  align = "right",
}: {
  testId: number;
  orgSlug: string;
  /** Names the trigger, so fifty rows are not fifty identical "Actions" buttons. */
  testName: string;
  quarantined: boolean;
  align?: "left" | "right";
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("idle");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(next: boolean): Promise<void> {
    setPending(true);
    setError(null);

    const response = await fetch(`/api/v1/tests/${testId}/quarantine`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        orgSlug,
        quarantined: next,
        reason: next ? reason.trim() || undefined : undefined,
      }),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setError(body?.error?.message ?? "could not update quarantine");
      setPending(false);
      return;
    }

    setPending(false);
    setMode("idle");
    setReason("");
    router.refresh();
  }

  const items: ActionItem[] = quarantined
    ? [{ label: "Remove from quarantine", onSelect: () => void submit(false) }]
    : [{ label: "Quarantine…", onSelect: () => setMode("quarantine") }];

  if (mode === "quarantine") {
    return (
      <div className="w-full max-w-xs rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-2.5">
        <p className="text-[11px] font-medium">Quarantine this test?</p>
        <p className="mt-1 text-[10px] leading-relaxed text-[var(--color-ink-muted)]">
          It keeps running and reporting, but stops counting against dashboards and gates.
        </p>
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void submit(true);
            if (event.key === "Escape") setMode("idle");
          }}
          autoFocus
          placeholder="Why? e.g. flaky under load"
          aria-label={`Reason for quarantining ${testName}`}
          className="mt-2 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1 text-[11px] outline-none focus:border-[var(--color-ink-muted)]"
        />
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => void submit(true)}
            disabled={pending}
            className="rounded-md bg-[var(--color-ink)] px-2 py-1 text-[11px] font-medium text-[var(--color-surface)] disabled:opacity-60"
          >
            {pending ? "saving…" : "Quarantine"}
          </button>
          <button
            type="button"
            onClick={() => {
              setMode("idle");
              setError(null);
            }}
            className="px-1 text-[11px] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
          >
            Cancel
          </button>
        </div>
        {error ? (
          <p role="alert" className="mt-1.5 text-[10px] text-[var(--color-status-failed)]">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1">
      {error ? (
        <span role="alert" className="text-[10px] text-[var(--color-status-failed)]">
          {error}
        </span>
      ) : null}
      <ActionMenu items={items} label={`Actions for test ${testName}`} align={align} />
    </div>
  );
}
