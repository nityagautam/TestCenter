"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { RunResultsOverlay } from "@/components/run-results-overlay";

/**
 * The control that opens the results overlay, and the thing that owns its URL state.
 *
 * Split from the overlay so the overlay is a plain presentational dialog that takes a `runId` and
 * an `onClose`, and this decides when it is open. That split is what lets the same overlay serve
 * the runs list, where many rows each have a button, and the run page, where there is one.
 *
 * `?results=<runId>` rather than component state, per the convention the rest of the app follows:
 * the open dialog is then shareable, survives a reload, and closes on Back. `replace` rather than
 * `push` for closing, so dismissing does not leave a history entry that reopens it.
 */
export function RunResultsButton({
  orgSlug,
  runId,
  label = "test cases",
  wide = false,
  className,
}: {
  orgSlug: string;
  runId: string;
  label?: string;
  wide?: boolean;
  className?: string;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const open = params.get("results") === runId;

  const href = (next: string | null): string => {
    const search = new URLSearchParams(params.toString());
    if (next === null) search.delete("results");
    else search.set("results", next);
    const query = search.toString();
    return query ? `?${query}` : window.location.pathname;
  };

  return (
    <>
      <button
        type="button"
        onClick={() => router.push(href(runId), { scroll: false })}
        className={
          className ??
          "text-[11px] text-[var(--color-ink-muted)] underline hover:text-[var(--color-ink)]"
        }
        title="See the test cases in this run without leaving this page"
      >
        {label}
      </button>
      {open ? (
        <RunResultsOverlay
          orgSlug={orgSlug}
          runId={runId}
          wide={wide}
          /*
           * `replace`, and `scroll: false`. Replace so closing does not stack a history entry
           * whose Back reopens the dialog; no scroll so dismissing returns you to the row you
           * were reading rather than the top of a long list.
           */
          onClose={() => router.replace(href(null), { scroll: false })}
        />
      ) : null}
    </>
  );
}
