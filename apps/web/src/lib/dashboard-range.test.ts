import { describe, expect, it } from "vitest";
import {
  DASHBOARD_DAY_OPTIONS,
  dashboardRangeLabel,
  DEFAULT_DASHBOARD_DAYS,
  resolveDashboardDays,
} from "./dashboard-range";

describe("dashboard range", () => {
  it("offers a one-day window without changing the default", () => {
    expect(DASHBOARD_DAY_OPTIONS).toEqual([1, 7, 15, 30, 45, 90]);
    expect(DEFAULT_DASHBOARD_DAYS).toBe(7);
    expect(resolveDashboardDays(undefined)).toBe(7);
  });

  it("accepts offered values and snaps unknown values to seven days", () => {
    expect(resolveDashboardDays("1")).toBe(1);
    expect(resolveDashboardDays("90")).toBe(90);
    expect(resolveDashboardDays("2")).toBe(7);
    expect(resolveDashboardDays("not-a-number")).toBe(7);
  });

  it("names one day 'today' rather than pluralising it", () => {
    // Not cosmetic. The window predicate starts at a calendar boundary, so one day means
    // since midnight — "last 1 days" would be wrong twice over.
    expect(dashboardRangeLabel(1)).toBe("today");
    expect(dashboardRangeLabel(7)).toBe("last 7 days");
    expect(dashboardRangeLabel(90)).toBe("last 90 days");
  });

  it("labels every offered option", () => {
    // The label goes in a stat tile hint and the export's subtitle; an option with no label
    // would ship an empty caption on a document.
    for (const option of DASHBOARD_DAY_OPTIONS) {
      expect(dashboardRangeLabel(option)).toBeTruthy();
    }
  });
});
