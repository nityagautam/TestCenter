import { describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, readViewerTimeZone, TIMEZONE_COOKIE } from "./timezone.js";

/**
 * The viewer's time zone, parsed from a cookie.
 *
 * This function is small and unusually consequential. Its output reaches `AT TIME ZONE` in a
 * Postgres query, and an unrecognised zone makes Postgres *raise* rather than return rows —
 * so a malformed cookie that got past this would not degrade the dashboard, it would take it
 * down. The cookie is client-written, which means "malformed" includes whatever anyone cares
 * to put there.
 *
 * The tests are therefore organised around two properties rather than around the branches:
 *
 *   1. Anything that comes back is a zone `Intl` accepts, for every input including hostile
 *      ones. That is the same authority Postgres uses, so it is the guarantee that matters.
 *   2. The label is display-only and never reaches a query, so it is allowed to be wrong —
 *      but it is still constrained, because it is printed next to a timestamp.
 */
describe("readViewerTimeZone", () => {
  describe("the zone", () => {
    it("falls back to UTC when the cookie is absent or empty", () => {
      // The first render of a first visit, before the client has written anything.
      expect(readViewerTimeZone(undefined)).toEqual(DEFAULT_TIME_ZONE);
      expect(readViewerTimeZone("")).toEqual(DEFAULT_TIME_ZONE);
    });

    it("reads a zone and its label", () => {
      expect(readViewerTimeZone("Asia/Kolkata|IST")).toEqual({
        zone: "Asia/Kolkata",
        label: "IST",
      });
    });

    it("uses the zone as the label when none was sent", () => {
      expect(readViewerTimeZone("Europe/London")).toEqual({
        zone: "Europe/London",
        label: "Europe/London",
      });
    });

    it("rejects a zone Intl does not recognise", () => {
      /*
       * The load-bearing case. `AT TIME ZONE 'Not/AZone'` is an error, not an empty result,
       * so anything that reaches the query has to be known-good first.
       */
      expect(readViewerTimeZone("Not/AZone|XX")).toEqual(DEFAULT_TIME_ZONE);
      expect(readViewerTimeZone("../../etc/passwd")).toEqual(DEFAULT_TIME_ZONE);
      expect(readViewerTimeZone("'; DROP TABLE runs; --")).toEqual(DEFAULT_TIME_ZONE);
    });

    it("rejects an empty zone even when a label is present", () => {
      expect(readViewerTimeZone("|IST")).toEqual(DEFAULT_TIME_ZONE);
    });

    it("accepts the offset zones that motivated passing a zone at all", () => {
      /*
       * The reason bucketing happens in the target zone rather than being shifted in the
       * browser: these are not whole-hour offsets, so a UTC hour maps onto two local hours.
       * If any of them were rejected, the heatmap would silently fall back to UTC for the
       * readers who most need it not to.
       */
      for (const zone of ["Asia/Kolkata", "Asia/Kathmandu", "Pacific/Chatham", "Australia/Eucla"]) {
        expect(readViewerTimeZone(zone).zone).toBe(zone);
      }
    });

    it("accepts UTC itself", () => {
      expect(readViewerTimeZone("UTC|UTC")).toEqual({ zone: "UTC", label: "UTC" });
    });
  });

  describe("the label", () => {
    it("keeps the abbreviations a browser actually reports", () => {
      // Real `Intl.DateTimeFormat(...).formatToParts` timeZoneName values.
      for (const label of ["IST", "PDT", "GMT+5:30", "UTC", "GMT-3"]) {
        expect(readViewerTimeZone(`Asia/Kolkata|${label}`).label).toBe(label);
      }
    });

    it("falls back to the zone when the label is not label-shaped", () => {
      /*
       * The label is printed beside every timestamp, so it is constrained rather than
       * trusted. Falling back to the zone id keeps the timestamp unambiguous — the point of
       * printing a label at all — instead of dropping it.
       */
      const hostile = [
        "<script>alert(1)</script>",
        "a-very-long-label-indeed", // over the 12-character ceiling
        "IST\nX",
        "IST;DROP",
      ];
      for (const label of hostile) {
        expect(readViewerTimeZone(`Asia/Kolkata|${label}`).label).toBe("Asia/Kolkata");
      }
    });

    it("ignores anything after a second separator", () => {
      // `split("|")` yields three parts; only the first two are taken.
      expect(readViewerTimeZone("Asia/Kolkata|IST|ignored")).toEqual({
        zone: "Asia/Kolkata",
        label: "IST",
      });
    });
  });

  describe("the guarantee", () => {
    it("never returns a zone that Intl — and therefore Postgres — would reject", () => {
      /*
       * The property, asserted over the branches rather than one case at a time. Whatever
       * arrives, the value handed to the query is usable. A future edit that adds a path
       * returning the raw cookie fails here.
       */
      const inputs = [
        undefined,
        "",
        "|",
        "||",
        "Asia/Kolkata",
        "Asia/Kolkata|IST",
        "UTC",
        "Not/AZone",
        "Not/AZone|IST",
        "../../etc/passwd|IST",
        "'; DROP TABLE runs; --",
        " Asia/Kolkata ",
        "asia/kolkata",
        "A".repeat(500),
        "🙂|🙂",
      ];

      for (const input of inputs) {
        const { zone } = readViewerTimeZone(input);
        expect(() => new Intl.DateTimeFormat("en-GB", { timeZone: zone })).not.toThrow();
      }
    });

    it("always returns a non-empty label, because it is printed", () => {
      for (const input of [undefined, "", "|IST", "Asia/Kolkata|", "Asia/Kolkata|<bad>"]) {
        expect(readViewerTimeZone(input).label.length).toBeGreaterThan(0);
      }
    });
  });

  it("names the cookie the client writes", () => {
    // The client component writes this key directly; a rename on one side only would mean
    // the server silently never sees a zone and every reader quietly gets UTC.
    expect(TIMEZONE_COOKIE).toBe("tc_tz");
    expect(DEFAULT_TIME_ZONE).toEqual({ zone: "UTC", label: "UTC" });
  });
});
