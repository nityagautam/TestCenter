/**
 * Hoisting data-driven parameters out of a reported test name.
 *
 * `CanonicalTestResult.parameters` has always been documented as the place these belong —
 * "parametrized frameworks embed values in the test name; hoisting them here is what keeps a
 * test's fingerprint stable across parameter sets" — but nothing ever populated it, so the column
 * is empty in every row and every example row of a scenario arrives as an unrelated test.
 *
 * WHY SHAPE AND NOT FRAMEWORK
 *
 * JUnit XML almost never states which tool wrote it, and this parser does not know: `framework` is
 * inferred later from the report as a whole, not per test case. So the rules below key off the
 * *delimiters* a framework leaves behind, which are unambiguous, rather than off a guess about the
 * producer.
 *
 * WHY ONLY DELIMITED FORMS
 *
 * An earlier attempt normalised quoted substrings anywhere in a name. On a Cucumber corpus that
 * scored 4.7x and looked general; measured against ten framework conventions it grouped two, and
 * it was one narrow guard away from merging somebody's `HTTP 200` test with their `HTTP 404` one.
 * Values inlined into prose with no delimiter — jest `.each` giving "adds 1 + 2", Spock giving
 * "maximum of 3 and 4" — are not recoverable, and this returns nothing for them rather than
 * guessing. One test per variant is a worse answer than grouping; a wrong grouping is worse than
 * both.
 */

export interface ExtractedParameters {
  /** The name with the parameter text removed. May be empty when the name was only parameters. */
  name: string;
  parameters: Record<string, string>;
}

/**
 * A trailing bracket holding the arguments or an index.
 *
 * pytest: `test_login[alice-secret]`. JUnit 5: `add(int, int)[1]`. TestNG and Spock also emit this
 * shape. Anchored to the end, and non-greedy from the last `[`, so a name containing an earlier
 * bracket keeps it.
 */
const TRAILING_BRACKET = /^(.*?)\s*\[([^\]]*)\]\s*$/;

/**
 * A leading index, which is how JUnit 5 renders a parameterised test with no display name:
 * `[1] 1, 1, 2`. The remainder is the argument list, not a name, so the base becomes empty and the
 * test is identified by its classname — which is exactly what the method is.
 */
const LEADING_INDEX = /^\[(\d+)\]\s*(.*)$/;

/** Cucumber's example row, appended to every expansion of one scenario outline. */
const EXAMPLE_SUFFIX = /^(.*?)\s*[-–—]?\s*Example\s+#(\d+(?:\.\d+)*)\s*$/i;

/**
 * Trailing parentheses holding *values* rather than a type signature.
 *
 * `search("shoes")` is data; `add(int, int)` is a Java method signature and must not be stripped,
 * or every overload in a Surefire report collapses into one test. The discriminator is that a
 * signature contains only identifiers and commas, so parentheses are treated as data only when
 * they contain a quote or a digit.
 */
const TRAILING_PARENS = /^(.*?)\s*\(([^()]*)\)\s*$/;
const LOOKS_LIKE_VALUES = /["'\d]/;

/**
 * Pull whatever is unambiguously a parameter out of a test name.
 *
 * Returns `null` when the name carries no delimited parameters, so callers can leave the result
 * untouched rather than storing an empty object that would look like a considered decision.
 */
export function extractTestParameters(rawName: string): ExtractedParameters | null {
  let name = rawName.trim();
  const parameters: Record<string, string> = {};

  const example = EXAMPLE_SUFFIX.exec(name);
  if (example) {
    parameters.example = example[2]!;
    name = example[1]!.trim();
  }

  const leading = LEADING_INDEX.exec(name);
  if (leading) {
    parameters.index = leading[1]!;
    const rest = leading[2]!.trim();
    if (rest) parameters.arguments = rest;
    // Deliberately empty: the method is the classname, and the remainder was the argument list.
    name = "";
  } else {
    const bracket = TRAILING_BRACKET.exec(name);
    if (bracket) {
      const inner = bracket[2]!.trim();
      // `[1]` is an index; anything else is the argument text as the framework rendered it.
      if (/^\d+$/.test(inner)) parameters.index = inner;
      else if (inner) parameters.arguments = inner;
      name = bracket[1]!.trim();
    }

    const parens = TRAILING_PARENS.exec(name);
    if (parens && LOOKS_LIKE_VALUES.test(parens[2]!)) {
      parameters.arguments = [parameters.arguments, parens[2]!.trim()].filter(Boolean).join(" ");
      name = parens[1]!.trim();
    }
  }

  return Object.keys(parameters).length > 0 ? { name, parameters } : null;
}
