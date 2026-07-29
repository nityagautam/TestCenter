import { describe, expect, it } from "vitest";
import {
  computeFailureSignature,
  computeFingerprint,
  extractUserFrames,
  normalizeFailureMessage,
  normalizeSuitePath,
  normalizeTestName,
} from "./fingerprint.js";

const PROJECT = "11111111-1111-4111-8111-111111111111";

/**
 * These tests guard the single most expensive-to-change decision in the schema.
 * If a fingerprint shifts, every test in the product silently loses its history —
 * so the interesting cases are all "same logical test, different environment".
 */
describe("normalizeSuitePath", () => {
  it("strips machine-specific absolute prefixes so laptop and CI agree", () => {
    const laptop = normalizeSuitePath("/Users/amishra/dev/checkout/tests/checkout/payment.spec.ts");
    const githubRunner = normalizeSuitePath(
      "/home/runner/work/checkout/checkout/tests/checkout/payment.spec.ts",
    );
    const gitlabRunner = normalizeSuitePath("/builds/fynd/checkout/tests/checkout/payment.spec.ts");

    expect(laptop).toBe("tests/checkout/payment.spec.ts");
    expect(githubRunner).toBe(laptop);
    expect(gitlabRunner).toBe(laptop);
  });

  it("normalizes Windows separators and drive letters to the POSIX form", () => {
    // The requirement is agreement between platforms, not a particular depth:
    // a Windows dev box and a Linux runner must normalize to the same string.
    const windows = normalizeSuitePath("C:\\src\\checkout\\tests\\payment.spec.ts");
    const linuxRunner = normalizeSuitePath(
      "/home/runner/work/checkout/checkout/src/checkout/tests/payment.spec.ts",
    );
    expect(windows).toBe("src/checkout/tests/payment.spec.ts");
    expect(linuxRunner).toBe(windows);
  });

  it("removes shard and worker decorations", () => {
    expect(normalizeSuitePath("tests/payment.spec.ts-shard-3")).toBe("tests/payment.spec.ts");
    expect(normalizeSuitePath("tests/payment-gw2.spec.ts")).toBe("tests/payment.spec.ts");
  });

  it("keeps already-relative paths untouched", () => {
    expect(normalizeSuitePath("./specs/login.spec.ts")).toBe("specs/login.spec.ts");
  });

  it("returns empty string for a missing suite", () => {
    expect(normalizeSuitePath(undefined)).toBe("");
  });
});

describe("normalizeTestName", () => {
  it("strips retry decorations", () => {
    expect(normalizeTestName("declines expired card (retry 2)")).toBe("declines expired card");
    expect(normalizeTestName("declines expired card [retry #1]")).toBe("declines expired card");
  });

  it("scrubs generated values that would otherwise fragment history", () => {
    const first = normalizeTestName(
      "creates order 3f0e6b1a-9c4d-4a2e-8f10-2b7d5c9e1a44 at 2026-07-29T02:00:00Z",
    );
    const second = normalizeTestName(
      "creates order 7a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d at 2026-07-30T03:11:09Z",
    );
    expect(first).toBe(second);
  });

  it("collapses whitespace", () => {
    expect(normalizeTestName("  handles   empty cart ")).toBe("handles empty cart");
  });
});

describe("computeFingerprint", () => {
  it("is stable across machines for the same logical test", () => {
    const laptop = computeFingerprint({
      projectId: PROJECT,
      suite: "/Users/amishra/dev/checkout/tests/payment.spec.ts",
      classname: "Checkout > Payment",
      name: "declines expired card",
    });
    const ci = computeFingerprint({
      projectId: PROJECT,
      suite: "/home/runner/work/checkout/checkout/tests/payment.spec.ts",
      classname: "Checkout > Payment",
      name: "declines expired card (retry 1)",
    });
    expect(ci.hex).toBe(laptop.hex);
  });

  it("ignores parameter ordering", () => {
    const a = computeFingerprint({
      projectId: PROJECT,
      name: "charges card",
      parameters: { cardType: "visa", amount: 100 },
    });
    const b = computeFingerprint({
      projectId: PROJECT,
      name: "charges card",
      parameters: { amount: 100, cardType: "visa" },
    });
    expect(b.hex).toBe(a.hex);
  });

  it("separates different parameter sets", () => {
    const visa = computeFingerprint({
      projectId: PROJECT,
      name: "charges card",
      parameters: { cardType: "visa" },
    });
    const amex = computeFingerprint({
      projectId: PROJECT,
      name: "charges card",
      parameters: { cardType: "amex" },
    });
    expect(amex.hex).not.toBe(visa.hex);
  });

  it("scopes identity to the project so two teams never share history", () => {
    const first = computeFingerprint({ projectId: PROJECT, name: "logs in" });
    const second = computeFingerprint({
      projectId: "22222222-2222-4222-8222-222222222222",
      name: "logs in",
    });
    expect(second.hex).not.toBe(first.hex);
  });

  it("produces a 32-byte digest and records its version", () => {
    const fingerprint = computeFingerprint({ projectId: PROJECT, name: "logs in" });
    expect(fingerprint.digest).toHaveLength(32);
    expect(fingerprint.version).toBe(1);
    expect(fingerprint.canonicalForm).toContain("v1");
  });
});

describe("failure signatures", () => {
  it("clusters the same bug reported with different values", () => {
    const first = normalizeFailureMessage("expected 'Approved' to equal 'Declined' after 1200ms");
    const second = normalizeFailureMessage("expected 'Pending' to equal 'Declined' after 950ms");
    expect(second).toBe(first);
  });

  it("drops framework frames so unrelated failures do not collapse together", () => {
    const frames = extractUserFrames(
      [
        "at Object.<anonymous> (/repo/node_modules/@playwright/test/lib/worker.js:120:5)",
        "at expect (/repo/node_modules/expect/build/index.js:44:1)",
        "at chargeCard (/repo/src/payments/charge.ts:88:12)",
        "at Object.test (/repo/tests/payment.spec.ts:14:3)",
      ].join("\n"),
    );
    expect(frames.join(" ")).not.toContain("node_modules");
    expect(frames[0]).toContain("charge.ts");
  });

  it("falls back to top frames when every frame is framework code", () => {
    const frames = extractUserFrames(
      [
        "at internal (/repo/node_modules/a/index.js:1:1)",
        "at other (/repo/node_modules/b/x.js:2:2)",
      ].join("\n"),
    );
    expect(frames.length).toBeGreaterThan(0);
  });

  it("gives one signature to one root cause across many tests", () => {
    const stack = "at connectDb (/repo/src/db/client.ts:20:9)";
    const a = computeFailureSignature(PROJECT, {
      type: "ConnectionError",
      message: "connect ECONNREFUSED 10.0.0.4:5432",
      stackTrace: stack,
    });
    const b = computeFailureSignature(PROJECT, {
      type: "ConnectionError",
      message: "connect ECONNREFUSED 10.0.0.9:5432",
      stackTrace: stack,
    });
    expect(a).not.toBeNull();
    expect(b?.hex).toBe(a?.hex);
    expect(a?.title).toContain("ConnectionError");
  });

  it("distinguishes genuinely different causes", () => {
    const timeout = computeFailureSignature(PROJECT, {
      type: "TimeoutError",
      message: "waiting for selector",
      stackTrace: "at click (/repo/src/ui/button.ts:5:1)",
    });
    const assertion = computeFailureSignature(PROJECT, {
      type: "AssertionError",
      message: "expected true to be false",
      stackTrace: "at check (/repo/src/ui/form.ts:9:1)",
    });
    expect(assertion?.hex).not.toBe(timeout?.hex);
  });

  it("returns null when there is nothing to cluster on", () => {
    expect(computeFailureSignature(PROJECT, {})).toBeNull();
  });
});
