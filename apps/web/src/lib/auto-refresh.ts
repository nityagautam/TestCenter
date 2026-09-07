/**
 * How often a viewer wants the page to pick up new reports.
 *
 * A plain module, not a `"use server"` file, for the reason `theme.ts` records: an action file may
 * only export async functions, so a constant beside the action breaks the build at request time.
 *
 * WHY THIS IS A VIEWER PREFERENCE AND NOT AN ORGANISATION POLICY
 *
 * Every other setting in this product describes the data — retention, gate thresholds, roles. This
 * one describes somebody's browser: how often it may make requests, and how willing they are to
 * have a page change while they are reading it. Two people watching the same dashboard reasonably
 * want different answers, and an admin has no standing to decide it for them. So it lives in a
 * cookie beside the theme and the sidebar, and the settings page that hosts it is readable by
 * everyone rather than gated on an admin capability.
 */
export const AUTO_REFRESH_COOKIE = "tc_refresh";

/**
 * Seconds between checks, or `0` for off.
 *
 * Ten seconds is the floor deliberately. The check is cheap but it is not free, and a dashboard
 * left open on a wall display would otherwise be configurable into a self-inflicted load test.
 * Five minutes is the ceiling because beyond that a reader will refresh by hand before it fires,
 * so the setting would be pretending to do something.
 */
export const AUTO_REFRESH_INTERVALS = [0, 10, 30, 60, 300] as const;
export type AutoRefreshInterval = (typeof AUTO_REFRESH_INTERVALS)[number];

export const DEFAULT_AUTO_REFRESH: AutoRefreshInterval = 0;

export const AUTO_REFRESH_LABELS: Record<AutoRefreshInterval, string> = {
  0: "Off",
  10: "Every 10 seconds",
  30: "Every 30 seconds",
  60: "Every minute",
  300: "Every 5 minutes",
};

/** Short forms for the header control, where there is room for a word and not a sentence. */
export const AUTO_REFRESH_SHORT: Record<AutoRefreshInterval, string> = {
  0: "off",
  10: "10s",
  30: "30s",
  60: "1m",
  300: "5m",
};

/**
 * Unknown values fall back to off rather than to a default interval.
 *
 * A malformed cookie should not silently start a project making requests every ten seconds; and
 * off is the state a reader can always tell is wrong, because the page visibly stops updating.
 */
export function readAutoRefresh(value: string | undefined): AutoRefreshInterval {
  const parsed = Number(value);
  return (AUTO_REFRESH_INTERVALS as readonly number[]).includes(parsed)
    ? (parsed as AutoRefreshInterval)
    : DEFAULT_AUTO_REFRESH;
}
