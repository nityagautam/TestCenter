import { describe, expect, it } from "vitest";
import { cleanFailureText, extractFailureIdentity } from "./failure-identity.js";

/**
 * The point of moving this out of SQL: these are the cases that were previously only checkable by
 * running a query against production-shaped data and eyeballing the totals.
 *
 * Each test below is a real report shape. Where a number appears in a comment it was measured
 * against a real project, not estimated.
 */
describe("extractFailureIdentity", () => {
  describe("finding the error whichever field it is in", () => {
    it("prefers a specific type, the way Surefire and pytest report", () => {
      const identity = extractFailureIdentity({
        type: "java.lang.AssertionError",
        message: "expected [1] but found [2]",
      });
      expect(identity.errorClass).toBe("java.lang.AssertionError");
      expect(identity.source).toBe("type");
      expect(identity.category).toBe("assertion");
    });

    it("ignores a placeholder type and reads the message instead", () => {
      // `type="FAILURE"` says a test failed, which we knew. Treating it as the class is what made
      // Error and FAILURE the two largest categories in a real project — 698 of 838 failures.
      const identity = extractFailureIdentity({
        type: "FAILURE",
        message: "AuthError: fpInstall set no cookies (status 403)",
      });
      expect(identity.errorClass).toBe("AuthError");
      expect(identity.source).toBe("message");
      expect(identity.category).toBe("auth");
    });

    it("recovers the error from the body when the message holds the test's identity", () => {
      /*
       * Playwright's shape, and the reason 296 failures in one project were uncategorisable: the
       * message attribute is the scenario title and the real error is in the element body, which
       * arrives here as the stack trace.
       */
      const identity = extractFailureIdentity({
        type: "FAILURE",
        message: 'bulk.feature.spec.js:8:5 Import brand on cluster "TIRAUAT" of case no "1"',
        stackTrace:
          "bulk.feature.spec.js:8:5 › Feature › Import brand\n\n    AuthError: fpInstall set no cookies (status 403)\n   at ../../src/pom/api/JCPAuth.ts:387",
      });
      expect(identity.errorClass).toBe("AuthError");
      expect(identity.source).toBe("stack");
      expect(identity.summary).toContain("fpInstall set no cookies");
      // Specifically NOT the scenario title, which is what the message attribute held.
      expect(identity.summary).not.toContain("Import brand on cluster");
      expect(identity.category).toBe("auth");
    });

    it("says so when the report carried no error at all", () => {
      // An upstream gap rather than a missing rule here, which is why it is not "other".
      const identity = extractFailureIdentity({
        type: "FAILURE",
        message: 'x.feature.spec.js:8:5 Something on cluster "UAT" of case no "1"',
      });
      expect(identity.category).toBe("no-detail");
      expect(identity.source).toBe("none");
    });
  });

  describe("not being fooled by the source excerpt", () => {
    it("ignores a keyword that only appears in the rendered code frame", () => {
      /*
       * The single most important case here. A reporter renders the failing source line, so
       * whatever that line calls sits next to every failure from that site. Searching the
       * un-stripped text filed 91% of one real suite as assertions — auth failures included —
       * because `expect(` was visible in the excerpt of almost every one.
       */
      const identity = extractFailureIdentity({
        type: "FAILURE",
        message: "y.spec.js:1:1 Some scenario",
        stackTrace: [
          "y.spec.js:1:1 › Feature › Some scenario",
          "",
          "    AuthError: no cookies for cluster",
          "   at ../../src/pom/api/JCPAuth.ts:387",
          "",
          "  385 |   const value = await expect(response).toBeOK();",
          "> 387 |     throw new AuthError(`no cookies for cluster ${name}`);",
          "      |           ^",
        ].join("\n"),
      });
      expect(identity.category).toBe("auth");
      expect(identity.summary).not.toContain("expect(");
    });

    it("does not call something a timeout because the source names a timeout variable", () => {
      // Measured: the SQL version this replaces called three real failures timeouts for exactly
      // this reason — right answer, wrong evidence, and it would have gone the other way for a
      // test whose source happened not to name the variable.
      const identity = extractFailureIdentity({
        type: "FAILURE",
        message: "z.spec.js:1:1 Scenario",
        stackTrace: [
          "z.spec.js:1:1 › Feature › Scenario",
          "",
          "    Error: brand payload was rejected",
          "  12 |   await poll(job, { timeout: 600_000 });",
          "     |        ^",
        ].join("\n"),
      });
      expect(identity.category).not.toBe("timeout");
    });
  });

  describe("categorising what the failure says", () => {
    it("treats an actual-vs-expected pair as an assertion whatever it was thrown as", () => {
      /*
       * Generic on purpose. An earlier version matched one suite's own `==[ASSERT MISMATCH]==`
       * banner; measured, the number of rows that banner caught which this pair did not was zero,
       * so the bespoke pattern was pure coupling to one helper's formatting.
       */
      const identity = extractFailureIdentity({
        type: "FAILURE",
        message: "a.spec.js:1:1 Poll job",
        stackTrace:
          "a.spec.js:1:1 › F › Poll job\n\n    Error:\n     job did not reach a terminal status\n     ACTUAL: INPROGRESS\n     EXPECTED: SUCCESS",
      });
      expect(identity.category).toBe("assertion");
    });

    it("reads a wait budget stated in words as a timeout", () => {
      // "did not reach a terminal status within 600s" is a timeout, and no reporter spells it
      // with the word. Found by inspecting the rows the class rules left in "other".
      const identity = extractFailureIdentity({
        type: "FAILURE",
        message: "b.spec.js:1:1 Import",
        stackTrace:
          "b.spec.js:1:1 › F › Import\n\n    Error: Import job 6a85 did not reach a terminal status within 600s.",
      });
      expect(identity.category).toBe("timeout");
    });

    it("reads a transport that went away as network, not other", () => {
      const identity = extractFailureIdentity({
        type: "FAILURE",
        message: "c.spec.js:1:1 Fetch",
        stackTrace:
          "c.spec.js:1:1 › F › Fetch\n\n    Error: apiRequestContext.fetch: Target page, context or browser has been closed",
      });
      expect(identity.category).toBe("network");
    });

    it("separates a crash from a checked expectation", () => {
      /*
       * The distinction generic reporting loses, and the one that decides whether a developer
       * reads the diff or the stack. Both arrive as type Error.
       */
      const assertion = extractFailureIdentity({
        type: "AssertionError",
        message: "expected 1 to equal 2",
      });
      const crash = extractFailureIdentity({
        type: "TypeError",
        message: "Cannot read properties of undefined",
      });
      expect(assertion.category).toBe("assertion");
      expect(crash.category).toBe("code-error");
    });

    it("prefers auth over network for a 401, since they send you to different people", () => {
      const identity = extractFailureIdentity({
        type: "",
        message: "Request failed: 401 Unauthorized",
      });
      expect(identity.category).toBe("auth");
    });
  });

  describe("the summary a reader would see", () => {
    it("reaches past a bare class and its banner to the description", () => {
      /*
       * Three bugs met in this one shape, all found by running over real reports:
       *   - a bare `Error:` on its own line summarised as the single word "Error:" — 570 of 838
       *   - joined naively, it then summarised as "Error: ==[ASSERT MISMATCH]=====", the banner
       *   - the description carries a leading glyph, which is decoration rather than content
       */
      const identity = extractFailureIdentity({
        type: "FAILURE",
        message: "p.spec.js:1:1 Scenario",
        stackTrace: [
          "p.spec.js:1:1 › F › Scenario",
          "",
          "Error: ",
          "==[ASSERT MISMATCH]=============================",
          " \u274C products page 2 must preserve price_dsc order",
          " ACTUAL: false",
          " EXPECTED: true",
        ].join("\n"),
      });
      expect(identity.summary).toBe("products page 2 must preserve price_dsc order");
      expect(identity.category).toBe("assertion");
    });

    it("sees a short banner as decoration too", () => {
      // Five repeats passed every test here and then leaked on a real upload: banners are padded
      // to a fixed width, so a long title leaves only `====` on the end.
      const identity = extractFailureIdentity({
        type: "FAILURE",
        message: "q.spec.js:1:1 S",
        stackTrace:
          "q.spec.js:1:1 › F › S\n\nError:\n==[ASSERT MISMATCH]====\n job did not reach terminal status\n ACTUAL: INPROGRESS\n EXPECTED: SUCCESS",
      });
      expect(identity.summary).toBe("job did not reach terminal status");
    });

    it("keeps a class that says something, drops one that does not", () => {
      const specific = extractFailureIdentity({
        type: "FAILURE",
        message: "AuthError:\nfpInstall set no cookies",
      });
      expect(specific.summary).toBe("AuthError: fpInstall set no cookies");

      // `Error` prefixed to a description adds nothing a reader did not already know.
      const generic = extractFailureIdentity({
        type: "FAILURE",
        message: "Error:\namount must be greater than zero",
      });
      expect(generic.summary).toBe("amount must be greater than zero");
    });

    it("prefers the message over a body of frames", () => {
      // Surefire and pytest put the error in the message and only frames in the body. Preferring
      // the body returned `at tests/orders/test_create.py:31` for every row of one project.
      const identity = extractFailureIdentity({
        type: "AssertionError",
        message: "expected 'Approved' to equal 'Declined'",
        stackTrace:
          "at tests/orders/test_create.py:31\nat connectDb (tests/orders/test_create.py:12)",
      });
      expect(identity.summary).toBe("expected 'Approved' to equal 'Declined'");
      expect(identity.summary).not.toContain("at tests/");
    });
  });

  describe("cleanFailureText", () => {
    it("removes the location chain and the code frame, keeping the error", () => {
      const cleaned = cleanFailureText(
        [
          "  features/api/x.feature.spec.js:8:5 › Suite › Scenario › And User should see",
          "",
          "    Error: the real problem",
          "  385 |   const c = parse(r);",
          "      |           ^",
        ].join("\n"),
      );
      expect(cleaned).toContain("Error: the real problem");
      expect(cleaned).not.toContain("x.feature.spec.js");
      expect(cleaned).not.toContain("385 |");
    });

    it("is safe on undefined and on text with nothing to strip", () => {
      expect(cleanFailureText(undefined)).toBe("");
      expect(cleanFailureText("AssertionError: plain")).toBe("AssertionError: plain");
    });
  });
});
