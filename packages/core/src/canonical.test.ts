import { describe, expect, it } from "vitest";
import {
  accumulateTotals,
  canonicalReportSchema,
  emptyTotals,
  isRetryFlaky,
  type CanonicalTestResult,
} from "./canonical.js";
import { normalizeTags, parseTagArgs } from "./tags.js";

function result(overrides: Partial<CanonicalTestResult> = {}): CanonicalTestResult {
  return { name: "a test", status: "passed", ...overrides };
}

describe("run totals", () => {
  it("excludes skipped tests from the pass rate denominator", () => {
    // A suite that skips half its tests must not report 50%: that would make
    // every conditional-skip suite look broken.
    const totals = accumulateTotals(emptyTotals(), [
      result({ status: "passed" }),
      result({ status: "skipped" }),
      result({ status: "skipped" }),
    ]);
    expect(totals.total).toBe(3);
    expect(totals.passRate).toBe(100);
  });

  it("counts errors against the pass rate", () => {
    const totals = accumulateTotals(emptyTotals(), [
      result({ status: "passed" }),
      result({ status: "failed" }),
      result({ status: "error" }),
      result({ status: "passed" }),
    ]);
    expect(totals.passRate).toBe(50);
    expect(totals.errored).toBe(1);
  });

  it("sums durations", () => {
    const totals = accumulateTotals(emptyTotals(), [
      result({ durationMs: 100 }),
      result({ durationMs: 250 }),
    ]);
    expect(totals.durationMs).toBe(350);
  });

  it("reports zero pass rate for an empty run rather than dividing by zero", () => {
    expect(accumulateTotals(emptyTotals(), []).passRate).toBe(0);
  });
});

describe("in-run flake detection", () => {
  it("flags a test that only passed after failing", () => {
    const flaky = result({
      status: "passed",
      retries: [
        { attempt: 1, status: "failed" },
        { attempt: 2, status: "passed" },
      ],
    });
    expect(isRetryFlaky(flaky)).toBe(true);
    expect(accumulateTotals(emptyTotals(), [flaky]).flaky).toBe(1);
  });

  it("does not flag a first-attempt pass", () => {
    expect(
      isRetryFlaky(result({ status: "passed", retries: [{ attempt: 1, status: "passed" }] })),
    ).toBe(false);
  });

  it("does not flag a test that never recovered", () => {
    expect(
      isRetryFlaky(
        result({
          status: "failed",
          retries: [
            { attempt: 1, status: "failed" },
            { attempt: 2, status: "failed" },
          ],
        }),
      ),
    ).toBe(false);
  });
});

describe("tags", () => {
  it("normalizes keys so Env and env never diverge", () => {
    expect(normalizeTags({ Env: "Staging", "Test Suite": "smoke" })).toEqual({
      env: "Staging",
      "test-suite": "smoke",
    });
  });

  it("drops empty values", () => {
    expect(normalizeTags({ env: "  ", branch: "main" })).toEqual({ branch: "main" });
  });

  it("accepts both key:value and key=value from CI authors", () => {
    expect(parseTagArgs(["suite:smoke", "browser=chromium", "garbage"])).toEqual({
      suite: "smoke",
      browser: "chromium",
    });
  });

  it("keeps values containing colons intact", () => {
    expect(parseTagArgs(["jobUrl:https://ci.example.com/build/1"])).toEqual({
      joburl: "https://ci.example.com/build/1",
    });
  });
});

describe("canonical report schema", () => {
  it("accepts a minimal report and applies defaults", () => {
    const parsed = canonicalReportSchema.parse({
      schemaVersion: "1.0",
      run: { project: "checkout-web" },
      results: [{ name: "logs in", status: "passed" }],
    });
    expect(parsed.run.attempt).toBe(1);
    expect(parsed.run.tags).toEqual({});
  });

  it("coerces ISO date strings, which is what every reporter emits", () => {
    const parsed = canonicalReportSchema.parse({
      schemaVersion: "1.0",
      run: { project: "checkout-web", startedAt: "2026-07-29T02:00:00Z" },
      results: [],
    });
    expect(parsed.run.startedAt).toBeInstanceOf(Date);
  });

  it("rejects an unknown status instead of silently coercing it", () => {
    const outcome = canonicalReportSchema.safeParse({
      schemaVersion: "1.0",
      run: { project: "checkout-web" },
      results: [{ name: "logs in", status: "flaky" }],
    });
    expect(outcome.success).toBe(false);
  });

  it("rejects invalid tag keys", () => {
    const outcome = canonicalReportSchema.safeParse({
      schemaVersion: "1.0",
      run: { project: "checkout-web", tags: { "Bad Key": "x" } },
      results: [],
    });
    expect(outcome.success).toBe(false);
  });
});
