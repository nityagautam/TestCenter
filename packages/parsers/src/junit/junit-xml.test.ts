import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CanonicalTestResult } from "@testcenter/core";
import { accumulateTotals, emptyTotals } from "@testcenter/core";
import { junitXmlParser } from "./junit-xml.js";
import type { ParseOutcome } from "../types.js";

/**
 * Golden-file tests, one per real-world dialect.
 *
 * These are the tests that decide whether teams trust the product. Every fixture is
 * shaped like output an actual framework produces — including the parts that are
 * inconvenient: retries expressed three different ways, missing attributes, CDATA,
 * naive timestamps, and control characters in captured stdout.
 */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures");
const PROJECT = "11111111-1111-4111-8111-111111111111";

async function parseFixture(
  name: string,
): Promise<{ results: CanonicalTestResult[]; outcome: ParseOutcome }> {
  const results: CanonicalTestResult[] = [];
  const outcome = await junitXmlParser.parse(
    createReadStream(join(FIXTURES, name)),
    { projectId: PROJECT, filename: name },
    async (batch) => {
      results.push(...batch.results);
    },
  );
  return { results, outcome };
}

async function parseString(
  xml: string,
  filename = "inline.xml",
): Promise<{ results: CanonicalTestResult[]; outcome: ParseOutcome }> {
  const results: CanonicalTestResult[] = [];
  const outcome = await junitXmlParser.parse(
    Readable.from([Buffer.from(xml, "utf8")]),
    { projectId: PROJECT, filename },
    async (batch) => {
      results.push(...batch.results);
    },
  );
  return { results, outcome };
}

function byName(results: CanonicalTestResult[], name: string): CanonicalTestResult {
  const found = results.find((result) => result.name === name);
  if (!found)
    throw new Error(`no result named "${name}" in ${results.map((r) => r.name).join(", ")}`);
  return found;
}

describe("detection", () => {
  it("claims JUnit documents", async () => {
    const head = await readFile(join(FIXTURES, "pytest.xml"));
    expect(junitXmlParser.detect(head, "pytest.xml")).toBeGreaterThan(0.8);
  });

  it("claims a bare <testsuite> root", async () => {
    const head = await readFile(join(FIXTURES, "surefire-retries.xml"));
    expect(junitXmlParser.detect(head, "TEST-com.acme.PaymentTest.xml")).toBeGreaterThan(0.8);
  });

  it("declines formats that have dedicated parsers coming", () => {
    // Claiming these would produce a silently worse import than waiting for the
    // format-specific parser in Phase 2.
    const cases = [
      '<?xml version="1.0"?><testng-results total="3"><suite name="s"/></testng-results>',
      '<?xml version="1.0"?><assemblies><assembly name="x"/></assemblies>',
      '<?xml version="1.0"?><test-run id="2"><test-suite/></test-run>',
      '<?xml version="1.0"?><robot generator="Robot 7"><suite/></robot>',
    ];
    for (const xml of cases) {
      expect(junitXmlParser.detect(Buffer.from(xml), "results.xml")).toBe(0);
    }
  });

  it("declines unrelated XML", () => {
    expect(junitXmlParser.detect(Buffer.from("<project><name>x</name></project>"), "pom.xml")).toBe(
      0,
    );
  });
});

describe("pytest --junitxml", () => {
  it("maps statuses, durations, files and failure detail", async () => {
    const { results, outcome } = await parseFixture("pytest.xml");
    expect(results).toHaveLength(4);

    const failed = byName(results, "test_declines_expired_card");
    expect(failed.status).toBe("failed");
    expect(failed.durationMs).toBe(1204);
    // pytest puts the real path on the testcase; preferring it over the suite name
    // ("pytest") is what keeps this test's identity stable and meaningful.
    expect(failed.suite).toBe("tests/checkout/test_payment.py");
    expect(failed.classname).toBe("tests.checkout.test_payment");
    expect(failed.failure?.message).toContain("assert 'Declined' == 'Approved'");
    expect(failed.failure?.stackTrace).toContain("AssertionError");

    expect(byName(results, "test_accepts_visa").status).toBe("passed");

    const skipped = byName(results, "test_requires_login");
    expect(skipped.status).toBe("skipped");
    expect(skipped.message).toBe("needs staging credentials");

    const withOutput = byName(results, "test_applies_discount[percent-10]");
    expect(withOutput.stdout).toContain("computing totals for cart 88");

    expect(outcome.run.framework).toBe("junit");
    expect(outcome.resultsParsed).toBe(4);
  });

  it("reads a naive suite timestamp as UTC so imports are TZ-independent", async () => {
    const { results } = await parseFixture("pytest.xml");
    // The fixture says 2026-07-29T02:00:00.123456 with no zone. Interpreting that
    // as local time would put results in a different partition depending on the
    // server, so it is pinned to UTC.
    expect(byName(results, "test_accepts_visa").startedAt?.toISOString()).toBe(
      "2026-07-29T02:00:00.123Z",
    );
  });

  it("produces a pass rate that ignores skipped tests", async () => {
    const { results } = await parseFixture("pytest.xml");
    const totals = accumulateTotals(emptyTotals(), results);
    expect(totals.total).toBe(4);
    expect(totals.skipped).toBe(1);
    // 2 passed of 3 executed.
    expect(totals.passRate).toBe(66.67);
  });
});

describe("Playwright junit reporter", () => {
  it("uses the spec file as the suite and keeps the describe path", async () => {
    const { results } = await parseFixture("playwright.xml");
    expect(results).toHaveLength(3);

    const failed = byName(results, "Checkout › Payment › declines an expired card");
    expect(failed.status).toBe("failed");
    expect(failed.suite).toBe("specs/checkout/payment.spec.ts");
    expect(failed.durationMs).toBe(6200);
    expect(failed.failure?.type).toBe("FAILURE");
    expect(failed.failure?.stackTrace).toContain("payment.spec.ts:31:38");
  });

  it("treats a testcase with an empty body as passed", async () => {
    const { results } = await parseFixture("playwright.xml");
    expect(byName(results, "Checkout › Payment › accepts a valid card").status).toBe("passed");
  });
});

describe("Maven Surefire retries", () => {
  it("reads flakyFailure as an attempt that recovered", async () => {
    const { results } = await parseFixture("surefire-retries.xml");
    const flaky = byName(results, "declinesExpiredCard");

    // flakyFailure means an attempt failed but the test ultimately passed. Getting
    // this wrong would either hide a real flake or report a false failure.
    expect(flaky.status).toBe("passed");
    expect(flaky.retries).toHaveLength(2);
    expect(flaky.retries?.[0]?.status).toBe("failed");
    expect(flaky.retries?.[1]?.status).toBe("passed");
    expect(flaky.retries?.[0]?.failure?.type).toBe("org.junit.ComparisonFailure");
    expect(flaky.retries?.[0]?.failure?.stackTrace).toContain("PaymentTest.java:58");
  });

  it("reads rerunFailure as an attempt that never recovered", async () => {
    const { results } = await parseFixture("surefire-retries.xml");
    const failed = byName(results, "rejectsNegativeAmount");
    expect(failed.status).toBe("failed");
    expect(failed.retries?.at(-1)?.status).toBe("failed");
    expect(failed.failure?.type).toBe("java.util.concurrent.TimeoutException");
  });

  it("counts the recovered test as flaky and not as a failure", async () => {
    const { results } = await parseFixture("surefire-retries.xml");
    const totals = accumulateTotals(emptyTotals(), results);
    expect(totals.total).toBe(3);
    expect(totals.passed).toBe(2);
    expect(totals.failed).toBe(1);
    expect(totals.flaky).toBe(1);
  });

  it("decodes XML entities in messages", async () => {
    const { results } = await parseFixture("surefire-retries.xml");
    expect(byName(results, "declinesExpiredCard").retries?.[0]?.failure?.message).toBe(
      "expected:<Approved> but was:<Declined>",
    );
  });
});

describe("jest-junit", () => {
  it("falls back to the element body when no message attribute exists", async () => {
    const { results } = await parseFixture("jest.xml");
    const failed = byName(results, "cart rejects a negative quantity");
    expect(failed.status).toBe("failed");
    // jest-junit omits @message; the first line of the body is the best summary.
    expect(failed.failure?.message).toBe("Error: expected function to throw");
    expect(failed.failure?.stackTrace).toContain("cart.test.ts:88:24");
  });

  it("uses the suite name as the file when the testcase has none", async () => {
    const { results } = await parseFixture("jest.xml");
    expect(byName(results, "cart applies a discount").suite).toBe("src/lib/cart.test.ts");
  });
});

describe("duplicate testcase entries (Cypress-style retries)", () => {
  it("folds repeated entries into one result with an attempt chain", async () => {
    const { results } = await parseFixture("cypress-duplicate-attempts.xml");

    // Counting these as two tests would report the same test as both a pass and a
    // failure, inflating totals and wrecking the pass rate.
    expect(results).toHaveLength(2);

    const retried = byName(results, "Login logs in with valid credentials");
    expect(retried.status).toBe("passed");
    expect(retried.retries).toHaveLength(2);
    expect(retried.retries?.[0]?.status).toBe("failed");
    expect(retried.retries?.[1]?.status).toBe("passed");
    // Duration is the total across attempts, which is what a duration budget or a
    // "slowest tests" view should reflect.
    expect(retried.durationMs).toBe(9700);
  });

  it("reports the folded test as flaky rather than failed", async () => {
    const { results } = await parseFixture("cypress-duplicate-attempts.xml");
    const totals = accumulateTotals(emptyTotals(), results);
    expect(totals.total).toBe(2);
    expect(totals.failed).toBe(0);
    expect(totals.flaky).toBe(1);
    expect(totals.passRate).toBe(100);
  });
});

describe("edge cases", () => {
  it("handles a bare <testsuite> root, nested suites, CDATA and errors", async () => {
    const { results } = await parseFixture("edge-cases.xml");
    expect(results).toHaveLength(4);

    expect(byName(results, "no time attribute").durationMs).toBeUndefined();
    expect(byName(results, "no time attribute").status).toBe("passed");

    const errored = byName(results, "explicit error");
    expect(errored.status).toBe("error");
    expect(errored.failure?.type).toBe("RuntimeError");

    const cdata = byName(results, "cdata failure");
    expect(cdata.status).toBe("failed");
    expect(cdata.failure?.stackTrace).toBe("expected <a> got <b> & more");

    // A nested suite's own timestamp applies to its children.
    const nested = byName(results, "inside nested suite");
    expect(nested.suite).toBe("nested-child");
    expect(nested.startedAt?.toISOString()).toBe("2026-07-29T03:00:00.000Z");
  });

  it("survives control characters that real test output contains", async () => {
    // A test printing ANSI colour would otherwise make the whole document
    // unparseable and fail an entire nightly import.
    const esc = String.fromCharCode(0x1b);
    const nul = String.fromCharCode(0x00);
    const xml =
      `<testsuite name="ansi"><testcase name="colourful" time="0.1">` +
      `<system-out>${esc}[32mPASS${esc}[0m${nul} done</system-out></testcase></testsuite>`;

    const { results, outcome } = await parseString(xml);
    expect(results).toHaveLength(1);
    expect(results[0]?.stdout).toBe("[32mPASS[0m done");
    expect(outcome.warnings.map((w) => w.code)).toContain("illegal_xml_chars");
  });

  it("strips a BOM and leading noise before the declaration", async () => {
    const bom = String.fromCharCode(0xfeff);
    const xml = `${bom}\n  <testsuite name="bom"><testcase name="works" time="0.1"/></testsuite>`;
    const { results } = await parseString(xml);
    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe("works");
  });

  it("keeps results from a truncated document and warns", async () => {
    // CI killed mid-write; salvaging what exists beats discarding the run.
    const xml =
      `<testsuites><testsuite name="cut" timestamp="2026-07-29T04:00:00">` +
      `<testcase name="survived" time="0.2"/>`;
    const { results, outcome } = await parseString(xml);
    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe("survived");
    const codes = outcome.warnings.map((w) => w.code);
    expect(codes).toContain("truncated_document");
    expect(codes).toContain("unclosed_suite");
  });

  it("warns when a valid report contains no tests", async () => {
    const { results, outcome } = await parseString('<testsuites name="empty"/>');
    expect(results).toHaveLength(0);
    expect(outcome.warnings.map((w) => w.code)).toContain("no_results");
  });

  it("rejects XML that is not a report at all", async () => {
    await expect(parseString("<project><name>x</name></project>")).rejects.toThrow(
      /no <testsuite>/,
    );
  });

  it("rejects genuinely malformed XML with a clear error", async () => {
    await expect(
      parseString('<testsuite name="bad"><testcase name="x"</testsuite>'),
    ).rejects.toThrow(/malformed JUnit XML/);
  });

  it("names an unnamed testcase rather than dropping it", async () => {
    const { results } = await parseString('<testsuite name="s"><testcase time="0.1"/></testsuite>');
    expect(results[0]?.name).toBe("(unnamed test)");
  });
});

describe("streaming behaviour", () => {
  it("emits in bounded batches and reports progress", async () => {
    const cases = Array.from(
      { length: 250 },
      (_, index) => `<testcase classname="c" name="test_${index}" time="0.01"/>`,
    ).join("");
    const xml = `<testsuite name="big" timestamp="2026-07-29T05:00:00">${cases}</testsuite>`;

    const batchSizes: number[] = [];
    const progress: number[] = [];
    const outcome = await junitXmlParser.parse(
      Readable.from([Buffer.from(xml, "utf8")]),
      {
        projectId: PROJECT,
        filename: "big.xml",
        batchSize: 100,
        onProgress: (p) => progress.push(p.resultsParsed),
      },
      async (batch) => {
        batchSizes.push(batch.results.length);
      },
    );

    expect(outcome.resultsParsed).toBe(250);
    // Bounded: no batch may exceed the requested size, which is what keeps memory
    // flat on a 300 MB report.
    expect(Math.max(...batchSizes)).toBeLessThanOrEqual(100);
    expect(batchSizes.reduce((sum, n) => sum + n, 0)).toBe(250);
    expect(progress.length).toBeGreaterThan(0);
  });

  it("handles multi-byte characters split across chunk boundaries", async () => {
    // A UTF-8 sequence straddling a chunk must not be corrupted; the sanitizer
    // holds back partial surrogates for exactly this reason.
    const name = "测试 émoji 🎯 case";
    const xml = `<testsuite name="s"><testcase name="${name}" time="0.1"/></testsuite>`;
    const bytes = Buffer.from(xml, "utf8");
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < bytes.length; offset += 7) {
      chunks.push(bytes.subarray(offset, offset + 7));
    }

    const results: CanonicalTestResult[] = [];
    await junitXmlParser.parse(
      Readable.from(chunks),
      { projectId: PROJECT, filename: "utf8.xml" },
      async (batch) => {
        results.push(...batch.results);
      },
    );
    expect(results[0]?.name).toBe(name);
  });

  it("truncates pathological output instead of storing megabytes per test", async () => {
    const huge = "x".repeat(200_000);
    const xml = `<testsuite name="s"><testcase name="loud" time="0.1"><system-out>${huge}</system-out></testcase></testsuite>`;
    const { results } = await parseString(xml);
    const stdout = results[0]?.stdout ?? "";
    expect(stdout.length).toBeLessThan(huge.length);
    expect(stdout).toContain("truncated by Test Center");
  });
});
