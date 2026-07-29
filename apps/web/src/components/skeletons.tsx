/**
 * Loading placeholders.
 *
 * Every page in this app is `force-dynamic`, so a navigation cannot render until the server
 * has finished. Without a `loading.tsx` boundary Next keeps the *previous* page on screen
 * until the new one is completely ready, which means a click produces no feedback at all —
 * the app looks frozen rather than busy, and the natural reaction is to click again.
 *
 * These are deliberately shaped like the page that follows: same header block, same table
 * geometry, same column count. A skeleton whose proportions differ from the real content
 * swaps one jarring moment for two, because the layout jumps when the data lands. The point
 * is for the arrival to be unremarkable.
 *
 * Server components — they hold no state and never need to be interactive, so there is no
 * reason to ship them to the browser.
 */

/** One shimmering block. `aria-hidden` because the live region on the page announces state. */
function Bar({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`animate-pulse rounded bg-[var(--color-border-subtle)] ${className}`}
    />
  );
}

/**
 * The wrapper every skeleton uses.
 *
 * `role="status"` with a single polite announcement, rather than leaving a screen reader to
 * infer a page change from a screenful of decorative blocks. `aria-busy` lets assistive
 * technology treat the region as in-flight.
 */
function Loading({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="status" aria-busy="true" aria-live="polite">
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

/** Title, subtitle and an action, matching the page headers. */
function HeaderSkeleton() {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="space-y-2">
        <Bar className="h-5 w-40" />
        <Bar className="h-3 w-56" />
      </div>
      <Bar className="h-8 w-28" />
    </div>
  );
}

/**
 * A table with the row rhythm of the real one: two lines per row, right-aligned numerics.
 * `rows` is 8 rather than a full page — enough to read as a table, not so many that the
 * skeleton itself becomes the slow thing to paint.
 */
export function TableSkeleton({ rows = 8, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--color-border-subtle)]">
      <div className="border-b border-[var(--color-border-subtle)] px-4 py-2.5">
        <Bar className="h-3 w-24" />
      </div>
      <div className="divide-y divide-[var(--color-border-subtle)]">
        {Array.from({ length: rows }, (_, row) => (
          <div key={row} className="flex items-center gap-4 px-4 py-3">
            <div className="min-w-0 flex-1 space-y-1.5">
              {/* Varying widths, because a column of identical bars reads as a pattern
                  rather than as text that has not arrived yet. */}
              <Bar className={`h-3 ${["w-3/5", "w-4/5", "w-2/5", "w-3/4"][row % 4]}`} />
              <Bar className="h-2 w-1/4" />
            </div>
            {Array.from({ length: Math.max(columns - 1, 0) }, (_, col) => (
              <Bar key={col} className="h-3 w-12 shrink-0" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Generic org page: header, a strip of tiles, then a table. */
export function PageSkeleton({ label }: { label: string }) {
  return (
    <Loading label={label}>
      <main className="mx-auto max-w-7xl px-6 py-6">
        <HeaderSkeleton />
        <div className="mb-5 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-[var(--color-border-subtle)] sm:grid-cols-3 lg:grid-cols-6">
          {Array.from({ length: 6 }, (_, tile) => (
            <div key={tile} className="space-y-2 p-4">
              <Bar className="h-2 w-16" />
              <Bar className="h-6 w-20" />
            </div>
          ))}
        </div>
        <TableSkeleton />
      </main>
    </Loading>
  );
}

/** List pages — runs, tests, flaky: a toolbar, then a table beside a narrow panel. */
export function ListSkeleton({
  label,
  withSidePanel = true,
  withToolbar = true,
}: {
  label: string;
  withSidePanel?: boolean;
  /**
   * The flaky page has no search toolbar, so drawing one would promise a control that never
   * arrives — the same layout jump this file exists to avoid, just in the other direction.
   */
  withToolbar?: boolean;
}) {
  return (
    <Loading label={label}>
      <main className="mx-auto max-w-7xl px-6 py-6">
        <HeaderSkeleton />
        {/* The toolbar row, at the same 36px control height as the real one. */}
        {withToolbar ? (
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Bar className="h-9 flex-1 basis-56" />
            <Bar className="h-9 w-20" />
            <Bar className="h-9 w-72" />
            <Bar className="h-9 w-36" />
          </div>
        ) : null}
        <div
          className={
            withSidePanel
              ? "grid gap-5 lg:grid-cols-[minmax(0,1fr)_220px]"
              : "grid gap-5 lg:grid-cols-1"
          }
        >
          <TableSkeleton columns={6} />
          {withSidePanel ? (
            <aside className="hidden lg:block">
              <div className="space-y-2 rounded-xl border border-[var(--color-border-subtle)] p-4">
                <Bar className="h-2 w-16" />
                {Array.from({ length: 6 }, (_, row) => (
                  <Bar key={row} className="h-3 w-full" />
                ))}
              </div>
            </aside>
          ) : null}
        </div>
      </main>
    </Loading>
  );
}
