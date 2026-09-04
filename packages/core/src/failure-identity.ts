import { FAILURE_CATEGORIES, type FailureCategory } from "./canonical.js";

/**
 * What a failure actually is, extracted once from whatever field the reporter put it in.
 *
 * THE PROBLEM THIS EXISTS TO SOLVE
 *
 * JUnit's `<failure>` has three places an error can live — the `type` attribute, the `message`
 * attribute, and the element body — and reporters disagree about which to use:
 *
 *   Playwright        type="FAILURE"                  message=<test identity>   body=<the error>
 *   Surefire, TestNG  type="java.lang.AssertionError" message=<the error>       body=<stack>
 *   pytest, jest      type varies                     message=<the error>       body=<stack>
 *
 * So "categorise the message" is only a generic rule if it means *all three, most specific
 * first*. Reading one field works for one framework and silently fails for the next: 296 of one
 * real project's failures were uncategorisable purely because the reporter put the error in the
 * body and the classifier read the attribute.
 *
 * WHY EXTRACT RATHER THAN CLASSIFY IN PLACE
 *
 * This logic previously existed twice — as TypeScript in `fingerprint.ts` for the clustering key,
 * and again as nested `regexp_replace` calls inside the category query's SQL. Neither knew about
 * the other, and the SQL copy cost three separate escaping bugs (a backslash escape silently
 * dropped by the enclosing template literal, a backtick that closed it, and a block comment that
 * terminated early). Doing it once here means the rules are unit-testable, adding a framework is
 * one case in TypeScript rather than an edit to a SQL `CASE`, and the stored result can be shown
 * to a reader as well as grouped on.
 */

/**
 * Version of the extraction rules, so a backfill can find rows produced by an older set.
 *
 * A third version column alongside `fingerprint_version` and `failure_signature_version` needs
 * justifying, and the justification is that these three change for unrelated reasons and have
 * unrelated costs. Test identity is the expensive one — bumping it detaches flake scores,
 * quarantine and ownership. A signature is a grouping key. This is a *derived display and
 * grouping* value: recomputable from columns still on the row, nothing durable hangs off it, and
 * the rules here will genuinely move as new reporters turn up. Sharing a version with either
 * neighbour would mean every rule tweak forced a migration priced like an identity change.
 *
 * 2 — banner detection needed three repeated punctuation characters rather than five. The stored
 * summary changed for rows whose banner ended in a short run, so the version moved and
 * `backfill-identity` rewrote them. This is the cheap bump the paragraph above describes: no
 * fingerprint, signature or triage is affected, only what a reader sees.
 */
export const FAILURE_IDENTITY_VERSION = 2;

/** `<spec>:<line>:<col> › <suite> › <scenario> › <step>` — the test's identity, not its error. */
const LOCATION_LINE = /^[^\n]*\.spec\.[jt]sx?:\d+:\d+[^\n]*$/gm;
/**
 * The numbered source excerpt a reporter renders under the error, and its caret line.
 *
 * Stripping this is load-bearing rather than tidying. The excerpt shows the *source of the
 * failing line*, so whatever that line calls appears next to every failure from that site — and
 * a substring search over the un-stripped text filed 91% of one real suite as assertions,
 * because `expect(` was visible in the excerpt of almost every one.
 */
const CODE_FRAME_LINE = /^\s*>?\s*\d+\s*\|.*$/gm;
const CODE_FRAME_CARET = /^\s*\|\s*\^+\s*$/gm;

/** `AuthError:`, `java.lang.AssertionError:` — the class an error was thrown as. */
const ERROR_CLASS_AT_HEAD = /^\s*([A-Za-z_$][\w.$]*(?:Error|Exception|Failure|Failed))\s*:/;
const ERROR_CLASS_ANYWHERE = /\b([A-Za-z_$][\w.$]*(?:Error|Exception|Failure|Failed))\s*:/;

/**
 * Types that carry no information and must not be treated as the class.
 *
 * A reporter writing `type="FAILURE"` has told us a test failed, which we knew. Treating that as
 * the error class is what made `Error` and `FAILURE` the two largest "categories" in a real
 * project — 698 of 838 failures.
 */
const PLACEHOLDER_TYPES = new Set(["error", "failure", "failed", "exception", "assertionerror?"]);

/**
 * Category rules, in the order they are tried, matched against the error class.
 *
 * Ordered most specific first. `auth` precedes `network` because a 401 is a particular case of
 * "the environment said no", and reporting it as generic infrastructure sends someone to look at
 * the wrong thing.
 */
const CLASS_RULES: readonly [RegExp, FailureCategory][] = [
  [/timeout|timedout|deadline/i, "timeout"],
  [/unauthor|forbidden|auth|credential|permission/i, "auth"],
  [/connection|socket|unknownhost|dns|network|econn|interrupted/i, "network"],
  [/assert|comparisonfailure|expectation/i, "assertion"],
  [/nosuchelement|elementnot|element|selector|locator|staleelement/i, "element"],
  [/validation|schema|jsonpath|parse|json|serializ/i, "data"],
  // Anything that threw where nothing was meant to. Listed explicitly rather than as "ends in
  // Error", because most classes above also end in Error — the point is the KIND of fault, and
  // these mean a crash rather than a checked expectation.
  [
    /typeerror|referenceerror|syntaxerror|rangeerror|nullpointer|npe|attributeerror|keyerror|indexerror|valueerror|classcast|illegalstate|illegalargument|unsupportedoperation|runtimeexception|arithmetic|divisionbyzero|nomethod|undefinedmethod|nosuchmethod/i,
    "code-error",
  ],
];

/**
 * Fallback rules over the error text, used only when no class could be found.
 *
 * An actual-vs-expected pair leads, because it is the generic form of "something was compared and
 * disagreed" — JUnit, TestNG, pytest and hand-rolled helpers all emit some version of it. It
 * replaced a rule that matched one suite's own `==[ASSERT MISMATCH]==` banner: measured, the
 * number of rows that banner caught which this pair did not was zero, so the bespoke pattern was
 * pure coupling.
 */
const TEXT_RULES: readonly [RegExp, FailureCategory][] = [
  [/actual\s*:[\s\S]*expected\s*:|expected\s*:[\s\S]*actual\s*:/i, "assertion"],
  [
    /assert|expect\(|\.to(be|equal|contain|have|match|throw)|expected .* (to|but)|should (be|equal|contain)|mismatch/i,
    "assertion",
  ],
  [/timeout|timed out|deadline/i, "timeout"],
  /*
   * A wait budget stated in words rather than as the word "timeout".
   *
   * "Import job did not reach a terminal status within 600s" is a timeout, and no reporter is
   * going to spell it that way. Found by inspecting the rows the class rules left in "other":
   * the SQL version this replaces *did* call them timeouts, but only because the word appeared
   * in the stripped source excerpt — right answer, wrong reason, and it would have gone the
   * other way for a test whose source happened not to name a variable `timeout`.
   */
  [
    /(did not|did ?n[o']t|failed to|unable to) [^\n]{0,70}within \d+\s*(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes)\b/i,
    "timeout",
  ],
  [/(gave up|giving up|exhausted) (after|following) \d+/i, "timeout"],
  [
    /unauthor|forbidden|[^0-9]401[^0-9]|[^0-9]403[^0-9]|oauth|no [a-z ]{0,24}cookie|credential|permission denied|access denied/i,
    "auth",
  ],
  [
    /econnrefused|econnreset|enotfound|socket hang|unknownhost|[^0-9]50[234][^0-9]|bad gateway|service unavailable/i,
    "network",
  ],
  // A transport that went away mid-request. Playwright's phrasing for it is
  // "Target page, context or browser has been closed", which names no error class and matches
  // none of the keywords above, so it was landing in "other".
  [
    /(context|browser|connection|socket|channel|session)[^\n]{0,24}(has been )?(closed|disposed|destroyed)/i,
    "network",
  ],
  [
    /cannot read propert|is not a function|undefined is not|null is not an object|unhandled/i,
    "code-error",
  ],
  [/element|selector|locator|not visible|no such element/i, "element"],
  [/validation|schema|jsonpath|malformed|invalid (json|payload|response|data)/i, "data"],
];

export interface FailureIdentity {
  /** The class the error was thrown as, or `""` when the report named none. */
  errorClass: string;
  /** The first meaningful line of the error — what a reader should see first. */
  summary: string;
  category: FailureCategory;
  /**
   * Which field the error was recovered from.
   *
   * Kept because it diagnoses the *reporter* rather than the test: a project whose failures are
   * all `source: "stack"` has a reporter putting the error in the body, and one showing `"none"`
   * has a reporter that sent no error at all. That distinction is the difference between a rule
   * to improve here and a fix someone has to make upstream.
   */
  source: "type" | "message" | "stack" | "none";
}

/** Removes the parts of reporter output that describe the test rather than the failure. */
export function cleanFailureText(text: string | undefined): string {
  if (!text) return "";
  return text
    .replace(LOCATION_LINE, "")
    .replace(CODE_FRAME_LINE, "")
    .replace(CODE_FRAME_CARET, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** A stack frame, in the shapes Node, Python and the JVM emit. Never a summary. */
const STACK_FRAME_LINE = /^(at\s|File\s|\s*File\s|[\w$.]+\([^)]*\)\s*$)/;
/**
 * `Error:` or `AssertionError:` with nothing after it — a label, not a message.
 *
 * The prefix is `[\w.$]*`, zero or more, not `[A-Za-z_$][\w.$]*`. With a required leading
 * character the pattern matches `AuthError:` but *not* a bare `Error:` — it needs one character
 * plus the suffix, and `Error` is exactly the suffix with nothing before it. That off-by-one cost
 * 570 of 838 summaries in one project, every one of which came back as the single word "Error:"
 * because this test said the line was not a bare class and so nothing was joined to it.
 */
const BARE_CLASS_LINE = /^\s*[\w.$]*(?:Error|Exception|Failure|Failed)\s*:\s*$/;

/**
 * A banner or rule line: `==[ASSERT MISMATCH]=====`, `-------`, `*** FAILED ***`.
 *
 * Detected by a run of three or more repeated punctuation characters, which is what makes a line
 * decoration rather than prose regardless of what a given framework prints inside it.
 *
 * Three, not five. Five passed every unit test and then leaked on a real upload: banners are
 * written to a fixed total width, so a long title leaves only `====` on the end — four characters,
 * one short of the threshold — and the banner became the summary. Prose almost never contains
 * three identical punctuation marks in a row, so the looser bound costs nothing. It may
 * carry a word — and that word is often a useful *category* signal, which is why the rules above
 * still read it — but it is never the sentence a reader wants as a summary.
 */
const BANNER_LINE = /([=\-_*#~])\1{2,}/;

/** A leading bullet or status glyph on a description line: `❌`, `✗`, `-`, `*`, `>`. */
const LEADING_BULLET = /^[\s\u2022\u2023\u25E6\u2043\u2219>*\-\u274C\u2717\u2718\u2713\u2714]+/u;

/** Types that add nothing when prefixed to a description. */
const PLACEHOLDER_CLASS = /^(error|failure|failed|exception)$/i;

/**
 * The first line that actually says something.
 *
 * Three things are skipped, each found by running this over real reports rather than guessed at:
 *
 *   Stack frames — one project's every summary came back as `at tests/orders/test_create.py:31`,
 *   because its errors arrive in the `type` attribute and the body holds only frames.
 *
 *   A bare class on its own line — `Error:` with the message underneath accounted for 570 of 838
 *   summaries in another project, all reading as the single word "Error:".
 *
 *   Banner lines — with the bare class joined to whatever followed it, those same 570 then read
 *   `Error: ==[ASSERT MISMATCH]=====`, which is decoration rather than the description below it.
 */
function summaryFrom(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !STACK_FRAME_LINE.test(line));
  if (lines.length === 0) return "";

  const first = lines[0] as string;
  const bare_class = BARE_CLASS_LINE.exec(first);
  if (!bare_class) return first.replace(LEADING_BULLET, "").trim();

  // A label with the message beneath it. Take the first line that is neither decoration nor
  // another label, and keep the class only when it says something a placeholder does not.
  const description = lines
    .slice(1)
    .find((line) => !BANNER_LINE.test(line) && !BARE_CLASS_LINE.test(line))
    ?.replace(LEADING_BULLET, "")
    .trim();
  if (!description) return first;

  const class_name = first.replace(/[\s:]+$/, "");
  return PLACEHOLDER_CLASS.test(class_name) ? description : `${class_name}: ${description}`;
}

function categorise(errorClass: string, haystack: string): FailureCategory {
  for (const [pattern, category] of CLASS_RULES) {
    if (errorClass !== "" && pattern.test(errorClass)) return category;
  }
  for (const [pattern, category] of TEXT_RULES) {
    if (pattern.test(haystack)) return category;
  }
  return "other";
}

export function extractFailureIdentity(failure: {
  type?: string | undefined;
  message?: string | undefined;
  stackTrace?: string | undefined;
}): FailureIdentity {
  const reported_type = (failure.type ?? "").trim();
  const clean_message = cleanFailureText(failure.message);
  const clean_stack = cleanFailureText(failure.stackTrace);

  // The class, most authoritative source first.
  let error_class = "";
  let source: FailureIdentity["source"] = "none";
  if (reported_type !== "" && !PLACEHOLDER_TYPES.has(reported_type.toLowerCase())) {
    error_class = reported_type;
    source = "type";
  } else {
    const from_message = ERROR_CLASS_AT_HEAD.exec(clean_message)?.[1];
    const from_stack =
      ERROR_CLASS_AT_HEAD.exec(clean_stack)?.[1] ?? ERROR_CLASS_ANYWHERE.exec(clean_stack)?.[1];
    if (from_message) {
      error_class = from_message;
      source = "message";
    } else if (from_stack) {
      error_class = from_stack;
      source = "stack";
    }
  }

  /*
   * The summary comes from whichever field actually holds prose, which is not necessarily the one
   * that held the class. Playwright's message attribute is the scenario title, so a non-empty
   * message is no guarantee of an error — preferring the field with a recognisable error over the
   * one that merely has characters in it is the whole point.
   */
  const message_line = summaryFrom(clean_message);
  const stack_line = summaryFrom(clean_stack);

  /*
   * Which field holds the prose is not the same question as which held the class.
   *
   * When the class came from `type` the message is almost always the error itself — that is the
   * Surefire and pytest shape, and preferring the stack there returned a frame like
   * `at tests/orders/test_create.py:31` for every row. When the type was a placeholder the
   * message is often the test's identity instead, and the error is in the body. So: trust the
   * message when the class came from the type or the message, and otherwise take whichever of
   * the two actually reads like an error.
   */
  const prefer_message = source === "type" || source === "message";
  const summary = prefer_message && message_line !== "" ? message_line : stack_line || message_line;

  if (source === "none" && summary !== "") source = summary === stack_line ? "stack" : "message";

  const haystack = `${clean_message}\n${clean_stack}`;
  const category =
    summary === "" && error_class === ""
      ? // Nothing anywhere: not in the type, the message or the stack. Distinguished from "other"
        // because it is an upstream gap rather than a missing rule here.
        "no-detail"
      : categorise(error_class, haystack);

  return { errorClass: error_class, summary: summary.slice(0, 300), category, source };
}

/** Every category, for exhaustiveness checks in consumers. */
export { FAILURE_CATEGORIES };
