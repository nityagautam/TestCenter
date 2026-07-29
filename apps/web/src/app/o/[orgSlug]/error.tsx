"use client";

import Link from "next/link";

/**
 * Safety net for anything that escapes an explicit check inside the org scope.
 *
 * Pages handle expected permission failures themselves with a clear message; this
 * catches the unexpected so a reader gets something coherent instead of a blank
 * screen, and gets a route out rather than a dead end.
 */
export default function OrgError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="mx-auto max-w-lg px-6 py-14 text-center">
      <h1 className="text-sm font-semibold">Something went wrong</h1>
      <p className="mt-2 text-xs leading-relaxed text-[var(--color-ink-muted)]">
        This page could not be loaded. The error has been logged on the server.
      </p>
      <div className="mt-4 flex justify-center gap-3">
        <button type="button" onClick={reset} className="text-xs underline">
          Try again
        </button>
        <Link href="/" className="text-xs underline">
          Back to start
        </Link>
      </div>
    </main>
  );
}
