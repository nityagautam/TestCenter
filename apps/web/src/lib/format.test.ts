import { describe, expect, it } from "vitest";
import {
  basename,
  commonPrefix,
  dirname,
  formatAbsoluteTime,
  formatDay,
  formatInteger,
  truncateMiddle,
} from "./format.js";

describe("commonPrefix", () => {
  it("lifts a shared opening back to a separator", () => {
    // The real case: Cucumber scenarios parameterised by cluster.
    expect(
      commonPrefix([
        'On Cluster "SWADESHUAT", Negative Brand import with file "a.csv"',
        'On Cluster "SWADESHUAT", Positive Brand import with file "b.csv"',
        'On Cluster "SWADESHUAT", Partial Brand import with file "c.csv"',
      ]),
    ).toBe('On Cluster "SWADESHUAT", ');
  });

  it("returns nothing when the rows do not really share an opening", () => {
    // One unrelated row must be enough to suppress it, or the caption would lie about
    // what is being hidden.
    expect(commonPrefix(["alpha test", "alpha check", "RunnerTest"])).toBe("");
  });

  it("declines to lift a prefix too short to be worth hiding", () => {
    expect(commonPrefix(["ab_one", "ab_two", "ab_three"])).toBe("");
  });

  it("needs several rows before claiming a shared prefix", () => {
    // Two rows sharing an opening is a coincidence, not a pattern.
    expect(commonPrefix(["the same start here A", "the same start here B"])).toBe("");
  });
});

describe("truncateMiddle", () => {
  it("keeps both ends so the distinguishing tail survives", () => {
    const a =
      'Negative Test for bulk collection with invalid data with file "X-Invalid-3.csv", case no "6"';
    const b =
      'Negative Test for bulk collection with invalid data with file "X-Invalid-3.csv", case no "7"';
    // The whole point: these must not render identically.
    expect(truncateMiddle(a)).not.toBe(truncateMiddle(b));
    expect(truncateMiddle(a).endsWith('case no "6"')).toBe(true);
  });

  it("leaves short values alone", () => {
    expect(truncateMiddle("short name")).toBe("short name");
  });
});

describe("path helpers", () => {
  it("splits a path into leaf and directory", () => {
    expect(basename("specs/scale/group-33.spec.ts")).toBe("group-33.spec.ts");
    expect(dirname("specs/scale/group-33.spec.ts")).toBe("specs/scale");
  });

  it("treats a bare name as its own leaf with no directory", () => {
    // Cucumber puts a report name, not a path, in `suite`.
    expect(basename("JCP On-Page SEO — Product page config")).toBe(
      "JCP On-Page SEO — Product page config",
    );
    expect(dirname("JCP On-Page SEO — Product page config")).toBe("");
  });
});

describe("formatting is independent of the runtime locale", () => {
  /*
   * These are the regression guards for the hydration bug: the server and the browser ran
   * with different locales and produced different strings for the same instant, so React
   * discarded the server HTML. Asserting exact output is the point — if someone reintroduces
   * a bare toLocaleString() these fail.
   */
  const instant = "2026-07-29T23:01:00.000Z";

  it("renders an absolute timestamp in UTC, labelled", () => {
    expect(formatAbsoluteTime(instant)).toBe("29 Jul 2026, 23:01 UTC");
  });

  it("renders a day without a time", () => {
    expect(formatDay(instant)).toBe("29 Jul 2026");
  });

  it("groups integers the same way everywhere", () => {
    expect(formatInteger(13650)).toBe("13,650");
  });

  it("has something to say about missing values", () => {
    expect(formatAbsoluteTime(null)).toBe("—");
    expect(formatDay(undefined)).toBe("—");
    expect(formatInteger(null)).toBe("—");
  });
});
