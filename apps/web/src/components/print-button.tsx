"use client";

/**
 * Download as PDF, via the browser's own print pipeline.
 *
 * `window.print()` plus an `@media print` stylesheet, rather than a PDF library or headless
 * Chromium. The charts are already SVG and HTML, so the browser renders them faithfully with
 * no second implementation to keep in sync — a PDF library would mean drawing every chart
 * twice in two different rendering models.
 *
 * The trade-off is that this cannot run server-side, so scheduled or emailed reports would
 * need headless Chromium in the worker. That is a different feature, and this one does not
 * have to pay for it.
 */
export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs font-medium hover:border-[var(--color-ink-muted)]"
    >
      Download PDF
    </button>
  );
}
