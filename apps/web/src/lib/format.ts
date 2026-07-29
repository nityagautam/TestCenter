/**
 * Display formatting.
 *
 * Test durations span six orders of magnitude — a unit test takes 2 ms, a nightly
 * suite takes 40 minutes — so a single unit makes one end of the range unreadable.
 * These helpers pick the unit from the magnitude.
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m ${remainder}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function formatPercent(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const numeric = typeof value === "string" ? Number.parseFloat(value) : value;
  if (!Number.isFinite(numeric)) return "—";
  // Whole numbers read better without a trailing .00 in a dense table.
  return Number.isInteger(numeric) ? `${numeric}%` : `${numeric.toFixed(1)}%`;
}

/**
 * Relative time, because "3 minutes ago" answers the question people actually have
 * about a test run. Falls back to an absolute date once relative stops being useful.
 */
export function formatRelativeTime(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";

  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 0) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function formatAbsoluteTime(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/** Trims a long suite path from the left, keeping the meaningful tail. */
export function truncateStart(value: string, max = 60): string {
  if (value.length <= max) return value;
  return `…${value.slice(value.length - max + 1)}`;
}

export function shortSha(sha: string | null | undefined): string | null {
  if (!sha) return null;
  return sha.slice(0, 7);
}
