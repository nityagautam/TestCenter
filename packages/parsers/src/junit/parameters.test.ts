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
      'Test export on cluster "TIRAUAT" - Example #1.1',
      'Test export on cluster "JMDUAT" - Example #1.2',
    ];
    // Grouped by the example suffix alone; the inlined cluster value is NOT touched, so these
    // two remain distinct. That is the honest limit of a delimiter-based rule, and the reason
    // this project's own corpus barely collapses. See the note in parameters.ts.
    expect(groups(rows)).toBe(2);
    expect(extractTestParameters(rows[0]!)).toEqual({
      name: 'Test export on cluster "TIRAUAT"',
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
