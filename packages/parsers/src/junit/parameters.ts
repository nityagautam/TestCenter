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
 * A quoted literal or an unsubstituted placeholder anywhere in the name.
 *
 * Only consulted under `inlineValues`. The lookahead skips the token this module writes, or the
 * second pass matches what the first inserted and the name degenerates to nested tokens.
 */
const INLINE_QUOTED = /(["'])((?:(?!\1).)*)\1/g;
const INLINE_PLACEHOLDER = /<(?!value>)([A-Za-z_][\w .-]*)>/g;

/**
 * What an inlined value leaves behind in the name.
 *
 * Quoted, so a name that quoted its value and one that used a bare placeholder read alike once
 * both are normalised, and so the result still reads as a sentence with a hole in it rather than
 * as a mangled title.
 */
const VALUE_TOKEN = '"<value>"';

export interface ExtractOptions {
  /**
   * Also treat quoted literals and `<PLACEHOLDER>` tokens *anywhere* in the name as parameters.
   *
   * Off by default, and opt-in per project rather than global, because it is a guess about naming
   * rather than a fact about a format. The delimited rules above hold for every producer; this one
   * holds for a suite that inlines its example values into scenario titles, and is wrong for a
   * suite whose titles legitimately quote things — "returns \"404\" for a missing brand" and
   * "returns \"200\" for a known brand" become one test under it.
   *
   * The project that enables it is asserting something true about its own conventions. That is a
   * claim the product cannot make on anybody's behalf, which is exactly why it is a setting and
   * not a default.
   */
  inlineValues?: boolean;
}

/**
 * Pull whatever is unambiguously a parameter out of a test name.
 *
 * Returns `null` when the name carries no delimited parameters, so callers can leave the result
 * untouched rather than storing an empty object that would look like a considered decision.
 */
export function extractTestParameters(
  rawName: string,
  options: ExtractOptions = {},
): ExtractedParameters | null {
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

  if (options.inlineValues) {
    /*
     * Numbered rather than named, and numbered by position.
     *
     * The name gives no clue what each slot means — "cluster" and "case no" are prose around the
     * value, not keys for it — so inventing names would be fabricating structure. Position is the
     * one thing actually known, and it is stable: the same scenario always renders its values in
     * the same order, so value1 is the same field on every row of an outline.
     */
    let slot = 0;
    name = name.replace(INLINE_QUOTED, (_match, _quote: string, inner: string) => {
      parameters[`value${(slot += 1)}`] = inner;
      return VALUE_TOKEN;
    });
    name = name.replace(INLINE_PLACEHOLDER, (_match, inner: string) => {
      // An unexpanded placeholder has no value; its own name is the most that is known.
      parameters[`value${(slot += 1)}`] = inner;
      return VALUE_TOKEN;
    });
    name = name.replace(/\s+/g, " ").trim();
  }

  return Object.keys(parameters).length > 0 ? { name, parameters } : null;
}
