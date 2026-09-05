import { describe, expect, it } from "vitest";
import { deriveCanonicalTest, testTemplateName } from "./canonical-test.js";

/**
 * Every name below is a real shape from a live project, or the guard against a merge that shape
 * would otherwise cause. Grouping is the kind of rule that is easy to get 90% right and quietly
 * wrong on the rest, and the rest is where two unrelated tests become one row.
 */
describe("testTemplateName", () => {
  it("collapses the example rows of one outline onto a single template", () => {
    const rows = [
      'Test Location export on cluster "TIRAUAT" as case no "1" - Example #1.1',
      'Test Location export on cluster "JMDUAT" as case no "2" - Example #1.2',
      'Test Location export on cluster "SWADESHUAT" as case no "3" - Example #1.5',
    ];
    const templates = new Set(rows.map(testTemplateName));
    expect(templates.size).toBe(1);
    expect([...templates][0]).toBe(
      'Test Location export on cluster "<value>" as case no "<value>"',
    );
  });

  it("lands the expanded and unexpanded forms of a scenario on the same template", () => {
    /*
     * The same outline is reported both ways depending on the runner and its configuration: some
     * substitute the example values into the name, some leave the placeholder. Treating those as
     * two canonical tests would split a scenario in half for no reason a reader could see.
     */
    expect(testTemplateName('Test Auto-complete for query "<QUERY>" on cluster "<CLUSTER>"')).toBe(
      testTemplateName('Test Auto-complete for query "shoes" on cluster "TIRAUAT"'),
    );
  });

  it("normalises a numbered label without touching numbers that carry meaning", () => {
    expect(testTemplateName("Import brand, case no 4")).toBe('Import brand, case no "<value>"');
    // The guard. A status code is part of what the test *is*, and blanking it would merge a test
    // that expects success with one that expects failure — the two most different outcomes there
    // are.
    expect(testTemplateName("Search returns HTTP 404 for a missing brand")).toBe(
      "Search returns HTTP 404 for a missing brand",
    );
    expect(testTemplateName("Show top 10 results")).toBe("Show top 10 results");
  });

  it("keeps genuinely different scenarios apart", () => {
    // Same wording up to the verb. Nothing here is a substituted value, so nothing should merge.
    const a = testTemplateName("Test Collection sorting is stable");
    const b = testTemplateName("Test Collection filtering is stable");
    expect(a).not.toBe(b);
  });

  it("handles a name with no variability at all", () => {
    expect(testTemplateName("Login with valid credentials")).toBe("Login with valid credentials");
  });

  it("does not leave doubled spaces where a value was removed", () => {
    // `Example #1.2` sits after a space and a dash; naive removal leaves ragged whitespace that
    // then makes two templates differ by nothing a reader can see.
    expect(testTemplateName('Import brand "X"  -  Example #1.2')).toBe('Import brand "<value>"');
  });
});

describe("deriveCanonicalTest", () => {
  it("gives one key per template within a project", () => {
    const a = deriveCanonicalTest({
      projectId: "p1",
      classname: "Search",
      name: 'sort by "price_asc"',
    });
    const b = deriveCanonicalTest({
      projectId: "p1",
      classname: "Search",
      name: 'sort by "price_dsc"',
    });
    expect(a.key.equals(b.key)).toBe(true);
    expect(a.template).toBe('sort by "<value>"');
  });

  it("does not merge identically worded scenarios from different suites", () => {
    // Two teams naming a smoke test the same way is ordinary; silently merging their histories
    // would be a wrong answer with nothing on screen to reveal it.
    const a = deriveCanonicalTest({ projectId: "p1", classname: "Search", name: "smoke" });
    const b = deriveCanonicalTest({ projectId: "p1", classname: "Checkout", name: "smoke" });
    expect(a.key.equals(b.key)).toBe(false);
  });

  it("does not merge across projects", () => {
    const a = deriveCanonicalTest({ projectId: "p1", name: "smoke" });
    const b = deriveCanonicalTest({ projectId: "p2", name: "smoke" });
    expect(a.key.equals(b.key)).toBe(false);
  });

  it("is stable across calls, since it becomes a stored key", () => {
    const once = deriveCanonicalTest({ projectId: "p1", name: 'a "b"' });
    const twice = deriveCanonicalTest({ projectId: "p1", name: 'a "c"' });
    expect(once.key.toString("hex")).toBe(twice.key.toString("hex"));
    expect(once.key).toHaveLength(32);
  });
});
