import { z } from "zod";
import { tagsSchema } from "./tags.js";

/**
 * The canonical result model.
 *
 * Every parser emits this shape and nothing downstream — UI, analytics, alerts,
 * gates — knows which framework produced a result. Adding a framework must never
 * require a change outside packages/parsers.
 *
 * Versioned because stored artifacts are re-parsed as parsers improve; a batch of
 * results always records the schema version it was produced under.
 */
export const CANONICAL_SCHEMA_VERSION = "1.0" as const;

/**
 * Raw per-execution outcome. Deliberately does NOT include "flaky": flakiness is
 * derived from history and retries, never reported by a framework, and conflating
 * the two makes the flake signal unauditable.
 */
export const testStatusSchema = z.enum(["passed", "failed", "skipped", "error", "blocked"]);
export type TestStatus = z.infer<typeof testStatusSchema>;

export const attachmentKindSchema = z.enum([
  "screenshot",
  "video",
  "trace",
  "log",
  "har",
  "report",
  "diff",
  "other",
]);
export type AttachmentKind = z.infer<typeof attachmentKindSchema>;

export const attachmentSchema = z.object({
  kind: attachmentKindSchema,
  name: z.string().min(1).max(512),
  /** Key in object storage. Set once the file has been uploaded. */
  storageKey: z.string().min(1).max(1024).optional(),
  /** Path inside the uploaded report bundle, before it is moved to storage. */
  sourcePath: z.string().max(1024).optional(),
  contentType: z.string().max(255).optional(),
  bytes: z.number().int().nonnegative().optional(),
});
export type Attachment = z.infer<typeof attachmentSchema>;

export const failureSchema = z.object({
  /** Exception class / assertion type, e.g. "AssertionError", "TimeoutError". */
  type: z.string().max(512).optional(),
  message: z.string().optional(),
  stackTrace: z.string().optional(),
  /** Source excerpt around the failure, when the framework provides it. */
  snippet: z.string().optional(),
  expected: z.string().optional(),
  actual: z.string().optional(),
});
export type Failure = z.infer<typeof failureSchema>;

export const retryAttemptSchema = z.object({
  attempt: z.number().int().min(1),
  status: testStatusSchema,
  durationMs: z.number().int().nonnegative().optional(),
  failure: failureSchema.optional(),
});
export type RetryAttempt = z.infer<typeof retryAttemptSchema>;

export const testResultSchema = z.object({
  /** File path or suite name, e.g. "specs/checkout/payment.spec.ts". */
  suite: z.string().max(1024).optional(),
  /** Class or describe-block path, e.g. "Checkout > Payment". */
  classname: z.string().max(1024).optional(),
  name: z.string().min(1).max(1024),
  /**
   * Data-driven parameters kept OUT of `name`. Parametrized frameworks embed
   * values in the test name; hoisting them here is what keeps a test's
   * fingerprint stable across parameter sets, which is what makes history work.
   */
  parameters: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional(),
  status: testStatusSchema,
  durationMs: z.number().int().nonnegative().optional(),
  startedAt: z.coerce.date().optional(),
  /** Final-attempt failure. Per-attempt failures live in `retries`. */
  failure: failureSchema.optional(),
  /**
   * Every attempt including the first, when the framework reports retries.
   * A pass here after a fail is the strongest available flake signal.
   */
  retries: z.array(retryAttemptSchema).max(50).optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  attachments: z.array(attachmentSchema).max(100).optional(),
  tags: tagsSchema.optional(),
  /** Free-form reason for skipped/blocked results. */
  message: z.string().optional(),
});
export type CanonicalTestResult = z.infer<typeof testResultSchema>;

export const ciProviderSchema = z.enum([
  "github",
  "gitlab",
  "jenkins",
  "circleci",
  "buildkite",
  "azure",
  "bitbucket",
  "teamcity",
  "local",
  "unknown",
]);
export type CiProvider = z.infer<typeof ciProviderSchema>;

export const ciContextSchema = z.object({
  provider: ciProviderSchema.default("unknown"),
  buildId: z.string().max(255).optional(),
  buildNumber: z.string().max(64).optional(),
  jobName: z.string().max(255).optional(),
  jobUrl: z.string().url().max(2048).optional(),
  actor: z.string().max(255).optional(),
});
export type CiContext = z.infer<typeof ciContextSchema>;

/**
 * Identifies one logical run split across parallel CI shards. All shards report
 * the same `groupId`; the worker merges them into a single run so users never see
 * eight partial results for one nightly.
 */
export const shardSchema = z.object({
  groupId: z.string().min(1).max(255),
  index: z.number().int().min(0),
  total: z.number().int().min(1),
});
export type Shard = z.infer<typeof shardSchema>;

/**
 * The verdicts an admin can record against a run.
 *
 * Declared once here and mirrored by a CHECK constraint in migration 0005. Two
 * definitions of the same set will drift, so the API validates against this list and
 * the database refuses anything that somehow gets past it — belt and braces on purpose,
 * because a bad value would be stored forever in an append-only table.
 *
 * The order is the order they are offered in the UI: the two that end review first, then
 * the two causes that route elsewhere, then the not-yet-decided state.
 */
export const RUN_VERDICTS = ["pass", "product-bug", "infra", "flaky", "investigating"] as const;

export type RunVerdict = (typeof RUN_VERDICTS)[number];

/** Long enough to explain a judgement, short enough to read in a list row. */
export const MAX_VERDICT_NOTE_LENGTH = 500;

export const runVerdictSchema = z.enum(RUN_VERDICTS);

/** Human labels, so the UI and any future export agree on wording. */
/**
 * How a failure is categorised from the report itself, without asking anyone.
 *
 * Distinct from `RUN_VERDICTS`, which is a human judgement about a whole *run*. This is a
 * mechanical reading of one *failure*: derived from the error type and message, so every failure
 * carries one from the moment it is ingested rather than only the reviewed ones. The two answer
 * different questions and are deliberately not merged — "somebody decided this run was infra" is
 * not the same claim as "this error says ECONNREFUSED".
 *
 * Ordered as the classifier tries them, first match winning. `auth` precedes `infra` because a
 * 401 is a specific, actionable case of "the environment said no", and calling it generic infra
 * sends someone to look at the wrong thing. The classifier itself is SQL — see
 * `failureCategories` — because it aggregates over more rows than are worth shipping to the app.
 */
export const FAILURE_CATEGORIES = [
  "assertion",
  "code-error",
  "timeout",
  "network",
  "auth",
  "element",
  "data",
  "no-detail",
  "other",
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

export const FAILURE_CATEGORY_LABELS: Record<FailureCategory, string> = {
  /** The test looked, and what it found differed from what it expected. A real signal. */
  assertion: "Assertion failed",
  /**
   * Something threw where nothing was meant to — TypeError, NullPointerException, KeyError.
   *
   * Kept apart from `assertion` because the two mean opposite things about the test. An
   * assertion failure is the test working: it checked something and the answer was wrong. A code
   * error is the test (or the product) falling over before it could check anything, so the
   * result is not "the feature is broken" but "we do not know". Folding them together — which a
   * generic "Error" bucket does — hides that distinction, and it is the one that decides whether
   * a developer reads the diff or the stack.
   */
  "code-error": "Code exception",
  timeout: "Timeout",
  network: "Network / infrastructure",
  auth: "Auth / permission",
  element: "Element / selector",
  data: "Data / schema",
  /**
   * Not a synonym for "other", and the difference is the point.
   *
   * The report named the test but not the failure — some reporters write only the spec path and
   * scenario title when they cannot extract an error. That is a gap in what CI sent, fixable
   * upstream, whereas "other" is a gap in these rules. Showing them as one bucket would hide
   * which of the two a reader can act on.
   */
  "no-detail": "No error reported",
  other: "Other",
};

/**
 * Label for the sentinel `failureCategories` returns for rows written before extraction existed.
 *
 * Not a member of `FAILURE_CATEGORIES`, because it is not a kind of failure — it is a kind of
 * *row*. Keeping it out of the union means no consumer can accidentally treat it as a category a
 * classifier could produce, while the dashboards still have something to render.
 */
export const UNCLASSIFIED_FAILURE_LABEL = "Unclassified (not yet extracted)";

export const FAILURE_TRIAGES = [
  "product-bug",
  "test-bug",
  "infra",
  "flaky",
  "known-issue",
  "investigating",
] as const;
export type FailureTriage = (typeof FAILURE_TRIAGES)[number];

export const FAILURE_TRIAGE_LABELS: Record<FailureTriage, string> = {
  "product-bug": "Product bug",
  "test-bug": "Test bug",
  infra: "Infrastructure",
  flaky: "Flaky",
  "known-issue": "Known issue",
  investigating: "Investigating",
};

export const failureTriageSchema = z.enum(FAILURE_TRIAGES);

export const RUN_VERDICT_LABELS: Record<RunVerdict, string> = {
  pass: "Pass",
  "product-bug": "Product bug",
  infra: "Infra",
  flaky: "Flaky",
  investigating: "Investigating",
};

/**
 * Cap on a run's display name, shared by every path that can set one.
 *
 * `runs.name` is an unbounded `text` column, so without this the single-shot ingest
 * endpoint — which takes the name from a query parameter — would store whatever it was
 * given. Exported so the presigned create, single-shot ingest and rename endpoints agree
 * rather than each picking a number.
 */
export const MAX_RUN_NAME_LENGTH = 255;

export const runMetadataSchema = z.object({
  /** Project key, e.g. "checkout-web". Resolved to a project id at ingest. */
  project: z.string().min(1).max(128),
  name: z.string().max(MAX_RUN_NAME_LENGTH).optional(),
  framework: z.string().max(64).optional(),
  frameworkVersion: z.string().max(64).optional(),
  startedAt: z.coerce.date().optional(),
  finishedAt: z.coerce.date().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  environment: z.string().max(128).optional(),
  branch: z.string().max(255).optional(),
  commitSha: z.string().max(64).optional(),
  pullRequest: z.number().int().positive().optional(),
  ci: ciContextSchema.optional(),
  shard: shardSchema.optional(),
  /** Re-run of the same logical run (e.g. "Re-run failed jobs" in CI). */
  attempt: z.number().int().min(1).default(1),
  tags: tagsSchema.default({}),
});
export type RunMetadata = z.infer<typeof runMetadataSchema>;

/** What a parser yields: a run's metadata plus a bounded batch of results. */
export const resultBatchSchema = z.object({
  schemaVersion: z.literal(CANONICAL_SCHEMA_VERSION),
  results: z.array(testResultSchema),
});
export type ResultBatch = z.infer<typeof resultBatchSchema>;

/** The full envelope — used by the API, fixtures, and the documented public format. */
export const canonicalReportSchema = z.object({
  schemaVersion: z.literal(CANONICAL_SCHEMA_VERSION),
  run: runMetadataSchema,
  results: z.array(testResultSchema),
});
export type CanonicalReport = z.infer<typeof canonicalReportSchema>;

/** Counters derived from results. Persisted on `runs` so dashboards never aggregate. */
export interface RunTotals {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  errored: number;
  blocked: number;
  /** Passed only after a retry within this run — the in-run flake signal. */
  flaky: number;
  passRate: number;
  durationMs: number;
}

export function emptyTotals(): RunTotals {
  return {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    errored: 0,
    blocked: 0,
    flaky: 0,
    passRate: 0,
    durationMs: 0,
  };
}

/**
 * A result is in-run flaky when an earlier attempt failed but the final outcome
 * passed. This is the only flake signal available without history, and it is the
 * highest-confidence one.
 */
export function isRetryFlaky(result: CanonicalTestResult): boolean {
  if (result.status !== "passed") return false;
  if (!result.retries || result.retries.length < 2) return false;
  return result.retries.some(
    (attempt) => attempt.status === "failed" || attempt.status === "error",
  );
}

export function accumulateTotals(
  totals: RunTotals,
  results: readonly CanonicalTestResult[],
): RunTotals {
  for (const result of results) {
    totals.total += 1;
    totals.durationMs += result.durationMs ?? 0;
    switch (result.status) {
      case "passed":
        totals.passed += 1;
        break;
      case "failed":
        totals.failed += 1;
        break;
      case "skipped":
        totals.skipped += 1;
        break;
      case "error":
        totals.errored += 1;
        break;
      case "blocked":
        totals.blocked += 1;
        break;
    }
    if (isRetryFlaky(result)) totals.flaky += 1;
  }
  // Skipped tests are excluded from the denominator: a suite that skips half its
  // tests should not report a 50% pass rate.
  const executed = totals.passed + totals.failed + totals.errored;
  totals.passRate = executed === 0 ? 0 : Number(((totals.passed / executed) * 100).toFixed(2));
  return totals;
}

/** JSON Schema for the public API docs and third-party report generators. */
export function canonicalJsonSchema(): unknown {
  return z.toJSONSchema(canonicalReportSchema, { io: "input", unrepresentable: "any" });
}
