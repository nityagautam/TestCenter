"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { RunResultsOverlay } from "@/components/run-results-overlay";

/**
 * The control that opens the results overlay, and the thing that owns its URL state.
 *
 * Split from the overlay so the overlay is a plain presentational dialog that takes a `runId` and
 * an `onClose`, and this decides when it is open. That split is what lets the same overlay serve
 * the runs list, where the trigger is a menu item in each row, and the run page, where it is a
 * link beside the results table.
 *
 * `?results=<runId>` rather than component state, per the convention the rest of the app follows:
 * the open dialog is then shareable, survives a reload, and closes on Back. `replace` rather than
 * `push` for closing, so dismissing does not leave a history entry that reopens it.
 */

/** Optional columns, comma-separated. Only the suite is optional today. */
const COLUMNS_PARAM = "cols";

export function RunResultsButton({
  orgSlug,
  runId,
  label = "test cases",
  wide = false,
  className,
  /*
   * `"none"` renders the overlay and no trigger of its own.
   *
   * The runs list needs exactly that: its trigger is an item in the row's ⋯ menu, because a
   * per-row text link was the same word repeated down every row — the noise `RunActions` was
   * built to remove. The menu item and this both read `?results=` from the URL, so the trigger
   * and the dialog compose without a callback passing between them.
   */
  trigger = "text",
}: {
  orgSlug: string;
  runId: string;
  label?: string;
  wide?: boolean;
  className?: string;
  trigger?: "text" | "none";
}) {
  const router = useRouter();
  const params = useSearchParams();
  const open = params.get("results") === runId;
  const showSuite = (params.get(COLUMNS_PARAM) ?? "").split(",").includes("suite");

  const hrefWith = (mutate: (search: URLSearchParams) => void): string => {
    const search = new URLSearchParams(params.toString());
    mutate(search);
    const query = search.toString();
    return query ? `?${query}` : window.location.pathname;
  };

  function toggleSuite(): void {
    const next = hrefWith((search) => {
      const columns = new Set((search.get(COLUMNS_PARAM) ?? "").split(",").filter(Boolean));
      if (columns.has("suite")) columns.delete("suite");
      else columns.add("suite");
      if (columns.size > 0) search.set(COLUMNS_PARAM, [...columns].join(","));
      else search.delete(COLUMNS_PARAM);
    });
    // `replace`, so a few column toggles do not bury the list under history entries that Back
    // has to walk back through one at a time.
    router.replace(next, { scroll: false });
  }

  return (
    <>
      {trigger === "text" ? (
        <button
          type="button"
          onClick={() =>
            router.push(
              hrefWith((search) => search.set("results", runId)),
              { scroll: false },
            )
          }
          className={
            className ??
            "text-[11px] text-[var(--color-ink-muted)] underline hover:text-[var(--color-ink)]"
          }
          title="See the test cases in this run without leaving this page"
        >
          {label}
        </button>
      ) : null}
      {open ? (
        <RunResultsOverlay
          orgSlug={orgSlug}
          runId={runId}
          wide={wide}
          showSuite={showSuite}
          onToggleSuite={toggleSuite}
          /*
           * `replace`, and `scroll: false`. Replace so closing does not stack a history entry
           * whose Back reopens the dialog; no scroll so dismissing returns you to the row you
           * were reading rather than the top of a long list.
           */
          onClose={() =>
            router.replace(
              hrefWith((search) => search.delete("results")),
              {
                scroll: false,
              },
            )
          }
        />
      ) : null}
    </>
  );
}
