import { describe, expect, it } from "vitest";
import { extractTestParameters } from "./parameters.js";

/**
 * The point of this table is coverage across producers, not across cases. The rule this replaces
 * was tuned on one corpus and scored 4.7x on it while handling two of ten conventions, so every
 * framework the product claims to read gets a row here — including the ones where the honest
 * answer is "nothing to extract".
 */
const groups = (names: string[]): number => {
  const keys = names.map((n) => {
    const out = extractTestParameters(n);
    return out ? out.name : n;
  });
  return new Set(keys).size;
};

describe("extractTestParameters — by producer", () => {
  it("pytest parametrize", () => {
    const rows = ["test_login[alice-secret]", "test_login[bob-hunter2]", "test_login[carol-pw]"];
    expect(groups(rows)).toBe(1);
    expect(extractTestParameters(rows[0]!)).toEqual({
      name: "test_login",
      parameters: { arguments: "alice-secret" },
    });
  });

  it("JUnit 5 @ParameterizedTest with a method signature", () => {
    const rows = ["add(int, int)[1]", "add(int, int)[2]", "add(int, int)[3]"];
    expect(groups(rows)).toBe(1);
    // The signature stays: it is what distinguishes an overload, not a value.
    expect(extractTestParameters(rows[0]!)).toEqual({
      name: "add(int, int)",
      parameters: { index: "1" },
    });
  });

  it("JUnit 5 with no display name, where the name is only the arguments", () => {
    const rows = ["[1] 1, 1, 2", "[2] 2, 3, 5", "[3] 5, 8, 13"];
    expect(groups(rows)).toBe(1);
    expect(extractTestParameters(rows[0]!)).toEqual({
      name: "",
      parameters: { index: "1", arguments: "1, 1, 2" },
    });
  });

  it("TestNG data provider rendering its arguments", () => {
    const rows = ['search("shoes")', 'search("hats")', 'search("bags")'];
    expect(groups(rows)).toBe(1);
  });

  it("Cucumber scenario outline", () => {
    const rows = [
      'Test export on cluster "UAT-1" - Example #1.1',
      'Test export on cluster "UAT-2" - Example #1.2',
    ];
    // Grouped by the example suffix alone; the inlined cluster value is NOT touched, so these
    // two remain distinct. That is the honest limit of a delimiter-based rule, and the reason
    // this project's own corpus barely collapses. See the note in parameters.ts.
    expect(groups(rows)).toBe(2);
    expect(extractTestParameters(rows[0]!)).toEqual({
      name: 'Test export on cluster "UAT-1"',
      parameters: { example: "1.1" },
    });
  });

  it("frameworks that inline values with no delimiter get nothing, on purpose", () => {
    // jest .each and Spock @Unroll interpolate into prose. There is no delimiter to key off, and
    // guessing is how `HTTP 200` and `HTTP 404` end up as one test.
    expect(extractTestParameters("adds 1 + 2")).toBeNull();
    expect(extractTestParameters("maximum of 3 and 4")).toBeNull();
    expect(extractTestParameters("returns 3 for 1 and 2")).toBeNull();
  });

  it("leaves an ordinary test name completely alone", () => {
    expect(extractTestParameters("Login with valid credentials")).toBeNull();
    expect(extractTestParameters("login › chromium")).toBeNull();
  });
});

describe("extractTestParameters — guards", () => {
  it("does not mistake a Java method signature for data", () => {
    // Every overload collapsing into one test is the failure this guards.
    expect(extractTestParameters("add(int, int)")).toBeNull();
    expect(extractTestParameters("process(String)")).toBeNull();
  });

  it("keeps a bracket that is part of the name", () => {
    // Only the *trailing* bracket is parameters. An earlier one is prose.
    const out = extractTestParameters("renders [beta] banner[1]");
    expect(out).toEqual({ name: "renders [beta] banner", parameters: { index: "1" } });
  });

  it("survives empty and degenerate brackets", () => {
    expect(extractTestParameters("test[]")).toBeNull();
    expect(extractTestParameters("[]")).toBeNull();
    expect(extractTestParameters("")).toBeNull();
  });

  it("handles a name that is both parameterised and an outline row", () => {
    expect(extractTestParameters("scenario[a-b] - Example #2.3")).toEqual({
      name: "scenario",
      parameters: { example: "2.3", arguments: "a-b" },
    });
  });
});

describe("extractTestParameters — inlineValues, the project-scoped opt-in", () => {
  const on = { inlineValues: true };

  it("is off unless asked for", () => {
    // The whole point of the setting: nothing about default behaviour changes when a project has
    // not made a claim about its own naming.
    expect(extractTestParameters('cluster "UAT-1"')).toBeNull();
  });

  it("collapses a suite that inlines its example values", () => {
    const rows = [
      'Test export on cluster "UAT-1" as case no "1" - Example #1.1',
      'Test export on cluster "UAT-2" as case no "2" - Example #1.2',
      'Test export on cluster "UAT-1" as case no "3" - Example #1.5',
    ];
    const bases = new Set(rows.map((r) => extractTestParameters(r, on)!.name));
    expect(bases.size).toBe(1);
    expect([...bases][0]).toBe('Test export on cluster "<value>" as case no "<value>"');
  });

  it("keeps each variant individually addressable", () => {
    // Grouping must not cost identity: the values land in parameters, which are part of the
    // fingerprint, so the three rows above stay three test cases with three histories.
    const a = extractTestParameters('cluster "UAT-1"', on)!;
    const b = extractTestParameters('cluster "UAT-2"', on)!;
    expect(a.name).toBe(b.name);
    expect(a.parameters).toEqual({ value1: "UAT-1" });
    expect(b.parameters).toEqual({ value1: "UAT-2" });
  });

  it("lands the expanded and unexpanded forms of one scenario together", () => {
    expect(extractTestParameters('cluster "<CLUSTER>"', on)!.name).toBe(
      extractTestParameters('cluster "UAT-1"', on)!.name,
    );
  });

  it("numbers the slots by position, so value1 is the same field on every row", () => {
    const out = extractTestParameters('a "x" b "y" c "z"', on)!;
    expect(out.parameters).toEqual({ value1: "x", value2: "y", value3: "z" });
    expect(out.name).toBe('a "<value>" b "<value>" c "<value>"');
  });

  it("does what the setting warns about, which is why it is a setting", () => {
    /*
     * Two genuinely different tests, merged. Documented here rather than guarded against, because
     * no rule can tell this apart from an outline — and pretending otherwise is what made the
     * previous global attempt wrong. A project enabling this is asserting its titles do not work
     * this way.
     */
    const a = extractTestParameters('returns "404" for a missing brand', on)!;
    const b = extractTestParameters('returns "200" for a known brand', on)!;
    expect(a.name).toBe('returns "<value>" for a missing brand');
    expect(b.name).not.toBe(a.name); // differs by prose, so these two survive
    const c = extractTestParameters('returns "404" for a brand', on)!;
    const d = extractTestParameters('returns "200" for a brand', on)!;
    expect(c.name).toBe(d.name); // identical prose: merged, and that is the accepted cost
  });

  it("still leaves an undecorated name alone", () => {
    expect(extractTestParameters("Login with valid credentials", on)).toBeNull();
  });
});
