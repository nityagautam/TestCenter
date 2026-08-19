import { describe, expect, it } from "vitest";
import {
  DASHBOARD_DAY_OPTIONS,
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
});
