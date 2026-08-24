/*
 * One day keeps a busy current day readable, seven answers "how is this week going", and
 * ninety asks whether a trend is real. Both overview pages share this set so a reader does
 * not have to learn two versions of the same control.
 */
export const DASHBOARD_DAY_OPTIONS = [1, 7, 15, 30, 45, 90] as const;

export type DashboardDays = (typeof DASHBOARD_DAY_OPTIONS)[number];

export const DEFAULT_DASHBOARD_DAYS: DashboardDays = 7;

/** Unknown URL values snap to the default so the data and highlighted control agree. */
export function resolveDashboardDays(value: string | undefined): DashboardDays {
  const requested = Number(value);
  return DASHBOARD_DAY_OPTIONS.find((option) => option === requested) ?? DEFAULT_DASHBOARD_DAYS;
}

/**
 * How to name the selected window in prose.
 *
 * "last 1 days" is not the only problem with printing the number: the window predicate is
 * `started_at >= (now() - (days - 1) days)::date`, so it starts at a calendar boundary and
 * one day means *since midnight*, not the last twenty-four hours. "today" is what that is.
 */
export function dashboardRangeLabel(days: DashboardDays): string {
  return days === 1 ? "today" : `last ${days} days`;
}
