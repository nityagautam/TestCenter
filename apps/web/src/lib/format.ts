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

/*
 * Dates and numbers are formatted with an explicit locale and time zone, never with the
 * runtime's own.
 *
 * `toLocaleString()` with no arguments asks whichever runtime is executing. Node here is
 * en-US and the browser was en-GB, so the server rendered `6/12/2026, 8:13:00 PM` and the
 * client rendered `12/06/2026, 20:13:00` for the same instant — a hydration mismatch on
 * every timestamp, which made React throw away the server HTML for that subtree and
 * re-render it. It surfaced as the "1 issue" badge on the test history page, where a
 * 60-cell strip meant 120 mismatched attributes.
 *
 * Pinning both is also the right answer independent of hydration. `6/12` and `12/06` are
 * the same string to a machine and different dates to a reader, and a test dashboard is
 * read by people in different places looking at the same run. UTC matches what CI logs and
 * what the database stores, and is labelled so it is never guessed at.
 */
const DATE_LOCALE = "en-GB";
const DISPLAY_TIME_ZONE = "UTC";

const dayFormat = new Intl.DateTimeFormat(DATE_LOCALE, {
  timeZone: DISPLAY_TIME_ZONE,
  day: "numeric",
  month: "short",
  year: "numeric",
});

const dayTimeFormat = new Intl.DateTimeFormat(DATE_LOCALE, {
  timeZone: DISPLAY_TIME_ZONE,
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** Thousands separators without asking the runtime which ones it prefers. */
const integerFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function formatInteger(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "—";
  return integerFormat.format(value);
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
  return dayFormat.format(date);
}

/** Absolute, unambiguous, and identical on the server and in the browser. */
export function formatAbsoluteTime(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  return `${dayTimeFormat.format(date)} ${DISPLAY_TIME_ZONE}`;
}

/** Day only, for chart axis labels. */
export function formatDay(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  return dayFormat.format(date);
}

export function formatCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/** Trims a long suite path from the left, keeping the meaningful tail. */
/**
 * The prefix every one of these strings shares, trimmed to a sensible boundary.
 *
 * Test names are frequently mostly boilerplate. In a Cucumber suite parameterised by
 * cluster, fifty rows all begin `On Cluster "SWADESHUAT", ` — so a list truncated at the
 * right ends up showing the same 25 characters fifty times and eliding the only part that
 * differs. Lifting the shared opening into a caption once, and dropping it from the rows,
 * gives that space back to the words that actually distinguish them.
 *
 * Deliberately conservative: it only reports a prefix long enough to be worth removing,
 * and it cuts back to a separator so the remainder starts at something readable rather
 * than mid-word. Returns "" when there is nothing worth lifting, which callers treat as
 * "show the names as they are".
 */
export function commonPrefix(values: readonly string[], minLength = 12): string {
  if (values.length < 3) return "";
  const first = values[0] as string;
  let end = first.length;
  for (const value of values) {
    let i = 0;
    while (i < end && i < value.length && value[i] === first[i]) i += 1;
    end = i;
    if (end < minLength) return "";
  }
  // Back off to the last separator, so the visible remainder is not a word fragment.
  const candidate = first.slice(0, end);
  const cut = Math.max(
    candidate.lastIndexOf(", "),
    candidate.lastIndexOf(" · "),
    candidate.lastIndexOf("."),
    candidate.lastIndexOf(" "),
    candidate.lastIndexOf("_"),
  );
  if (cut < minLength) return "";
  return candidate.slice(0, cut + 1);
}

/**
 * Truncates in the middle, keeping both ends.
 *
 * CSS can only ellipsize one end, which is the wrong end for names like
 * `Negative Test for bulk collection with invalid data with file "…-Invalid-3-Rec.csv",
 * case no "2"` — three such rows are identical for the first eighty characters and differ
 * only in the fixture and the case number. Clipping the right made them indistinguishable;
 * keeping a tail makes each row identifiable at a glance.
 *
 * The budget is in characters rather than pixels, so it is approximate — the CSS
 * `truncate` stays on as a backstop for narrow columns.
 */
export function truncateMiddle(value: string, max = 78, tail = 24): string {
  if (value.length <= max) return value;
  const head = Math.max(max - tail - 1, 8);
  return `${value.slice(0, head).trimEnd()}…${value.slice(-tail).trimStart()}`;
}

/** `specs/scale/group-33.spec.ts` → `group-33.spec.ts`. The part that differs. */
export function basename(value: string): string {
  const parts = value.split(/[/\\]/);
  return parts[parts.length - 1] || value;
}

/** The directory part, for showing context beside a basename. */
export function dirname(value: string): string {
  const index = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  return index > 0 ? value.slice(0, index) : "";
}

export function truncateStart(value: string, max = 60): string {
  if (value.length <= max) return value;
  return `…${value.slice(value.length - max + 1)}`;
}

export function shortSha(sha: string | null | undefined): string | null {
  if (!sha) return null;
  return sha.slice(0, 7);
}
