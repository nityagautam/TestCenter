import type { Readable } from "node:stream";
import { SaxesParser, type SaxesTag } from "saxes";
import type { CanonicalTestResult, RetryAttempt, RunMetadata, TestStatus } from "@testcenter/core";
import {
  ParseError,
  type ParseContext,
  type ParsedBatch,
  type ParseOutcome,
  type Parser,
  type ParseWarning,
} from "../types.js";
import { createXmlSanitizer, type SanitizeStats } from "./sanitize.js";

/**
 * JUnit/xUnit XML.
 *
 * One parser covers the large majority of real-world adoption: pytest
 * (`--junitxml`), Playwright's junit reporter, Maven Surefire, Gradle, jest-junit,
 * Cypress, Robot Framework and TestNG's JUnit output all emit this family. The
 * dialects differ in which attributes they populate and how they express retries,
 * so the work here is tolerating that variation without losing information.
 *
 * Streaming (SAX) rather than DOM: these files reach hundreds of megabytes and a
 * DOM parse would need many times that in memory.
 */

/** Caps: one test must not be able to write megabytes into a row. */
const MAX_MESSAGE_CHARS = 8_000;
const MAX_STACK_CHARS = 64_000;
const MAX_OUTPUT_CHARS = 64_000;
const DEFAULT_BATCH_SIZE = 1_000;

/**
 * Above this many distinct tests in a single suite we stop tracking identities for
 * retry-collapsing and flush instead. Bounds memory on pathological reports at the
 * cost of retry detection in a suite no human is reading test-by-test anyway.
 */
const MAX_DEDUP_TRACKING_PER_SUITE = 20_000;

const TRUNCATION_NOTE = "\n… [truncated by Test Center]";

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return value.slice(0, limit) + TRUNCATION_NOTE;
}

/** JUnit `time` is fractional seconds. Tolerates empty and malformed values. */
function parseDurationMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number.parseFloat(value.replace(",", "."));
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1000);
}

/**
 * Suite timestamps usually omit a timezone. Interpreting a naive timestamp as
 * local time would make the same report import differently depending on the
 * server's TZ — and the partition a result lands in is derived from this value.
 * Treating it as UTC is arbitrary but deterministic, which is what matters.
 */
function parseTimestamp(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value.trim());
  const candidate = hasZone ? value.trim() : `${value.trim()}Z`;
  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

interface SuiteFrame {
  name: string;
  file: string | undefined;
  timestamp: Date | undefined;
  /** Identity → index in `pending`, for collapsing retries within this suite. */
  identities: Map<string, number> | null;
  /** Results accumulated for this suite, awaiting retry collapsing. */
  pending: CanonicalTestResult[];
}

interface FailureDraft {
  kind:
    "failure" | "error" | "skipped" | "rerunFailure" | "flakyFailure" | "rerunError" | "flakyError";
  type: string | undefined;
  message: string | undefined;
  text: string;
}

interface TestCaseDraft {
  name: string;
  classname: string | undefined;
  file: string | undefined;
  durationMs: number | undefined;
  failures: FailureDraft[];
  stdout: string;
  stderr: string;
  /** True when the framework marked the case skipped via a <skipped/> element. */
  skipped: boolean;
  skippedMessage: string | undefined;
}

export class JUnitXmlParser implements Parser {
  readonly id = "junit-xml";
  readonly version = "1.0.0";
  readonly displayName = "JUnit / xUnit XML";

  detect(head: Buffer, filename: string): number {
    const text = head.toString("utf8", 0, Math.min(head.length, 4096));

    // Formats that also end in .xml but are handled by dedicated parsers later.
    // Claiming them here would silently produce a worse import than waiting.
    if (/<testng-results/i.test(text)) return 0;
    if (/<assemblies/i.test(text)) return 0; // xUnit.net
    if (/<test-run/i.test(text)) return 0; // NUnit 3
    if (/<robot\b/i.test(text)) return 0; // Robot native output.xml

    let confidence = 0;
    if (/<testsuites[\s>]/i.test(text)) confidence = 0.9;
    else if (/<testsuite[\s>]/i.test(text)) confidence = 0.85;

    if (confidence === 0) return 0;

    const lower = filename.toLowerCase();
    if (lower.includes("junit") || lower.includes("surefire") || lower.includes("test-results")) {
      confidence = Math.min(1, confidence + 0.05);
    }
    return confidence;
  }

  async parse(
    stream: Readable,
    context: ParseContext,
    onBatch: (batch: ParsedBatch) => Promise<void>,
  ): Promise<ParseOutcome> {
    const batchSize = context.batchSize ?? DEFAULT_BATCH_SIZE;
    const warnings: ParseWarning[] = [];
    const sanitizeStats: SanitizeStats = { bytesRead: 0, illegalCharsRemoved: 0 };

    const run: Partial<RunMetadata> = {};
    let resultsParsed = 0;
    let batch: CanonicalTestResult[] = [];

    const suiteStack: SuiteFrame[] = [];
    let currentCase: TestCaseDraft | null = null;
    let currentFailure: FailureDraft | null = null;
    /** Element name we are collecting character data for. */
    let textTarget: "failure" | "stdout" | "stderr" | "stackTrace" | null = null;
    let textBuffer = "";
    let rootSeen = false;
    let suiteNameFromRoot: string | undefined;

    const parser = new SaxesParser({ fileName: context.filename });

    const flushBatch = async (): Promise<void> => {
      if (batch.length === 0) return;
      const toEmit = batch;
      batch = [];
      await onBatch({ results: toEmit });
      context.onProgress?.({
        bytesRead: sanitizeStats.bytesRead,
        resultsParsed,
      });
    };

    const emit = (result: CanonicalTestResult): void => {
      batch.push(result);
      resultsParsed += 1;
    };

    /**
     * Collapses repeated entries for one identity into a single result with a
     * retry chain. Two tests sharing suite+classname+name are indistinguishable to
     * our identity model anyway — they would map to one fingerprint — so merging
     * here is consistent with how they will be stored rather than a lossy choice.
     */
    const closeSuite = (): CanonicalTestResult[] => {
      const frame = suiteStack.pop();
      if (!frame) return [];
      return frame.pending;
    };

    /**
     * Truncation is recoverable; malformation is not.
     *
     * A report cut off mid-write (CI killed, disk full, pod evicted) raises
     * "unclosed tag" only at EOF, and by then every result we did read is already
     * captured — discarding them would throw away a whole nightly run over the last
     * few bytes. Errors raised while still streaming mean the document is genuinely
     * broken and its contents cannot be trusted, so those stay fatal.
     */
    let atEndOfDocument = false;
    parser.on("error", (error) => {
      if (atEndOfDocument) {
        warnings.push({
          code: "truncated_document",
          message: `report ended unexpectedly (${error.message}); parsed results were kept`,
          offset: sanitizeStats.bytesRead,
        });
        return;
      }
      throw new ParseError(`malformed JUnit XML: ${error.message}`, {
        code: "xml_malformed",
        offset: sanitizeStats.bytesRead,
        cause: error,
      });
    });

    parser.on("opentag", (tag: SaxesTag) => {
      const name = tag.name.toLowerCase();
      // No xmlns processing is enabled, so attribute values are plain strings.
      const attrs = tag.attributes as Record<string, string>;

      switch (name) {
        case "testsuites": {
          rootSeen = true;
          suiteNameFromRoot = attrs.name || undefined;
          if (attrs.time) run.durationMs = parseDurationMs(attrs.time);
          const timestamp = parseTimestamp(attrs.timestamp);
          if (timestamp) run.startedAt = timestamp;
          return;
        }

        case "testsuite": {
          rootSeen = true;
          const timestamp = parseTimestamp(attrs.timestamp);
          // Only the outermost suite contributes run-level timing; nested suites
          // describe a subset.
          if (suiteStack.length === 0) {
            if (!run.startedAt && timestamp) run.startedAt = timestamp;
            if (run.durationMs === undefined) run.durationMs = parseDurationMs(attrs.time);
          }
          suiteStack.push({
            name: attrs.name || "",
            file: attrs.file || undefined,
            timestamp,
            identities: new Map(),
            pending: [],
          });
          return;
        }

        case "testcase": {
          currentCase = {
            name: attrs.name || "(unnamed test)",
            classname: attrs.classname || undefined,
            file: attrs.file || undefined,
            durationMs: parseDurationMs(attrs.time),
            failures: [],
            stdout: "",
            stderr: "",
            skipped: false,
            skippedMessage: undefined,
          };
          return;
        }

        case "failure":
        case "error":
        case "rerunfailure":
        case "flakyfailure":
        case "rerunerror":
        case "flakyerror": {
          if (!currentCase) return;
          const kindMap: Record<string, FailureDraft["kind"]> = {
            failure: "failure",
            error: "error",
            rerunfailure: "rerunFailure",
            flakyfailure: "flakyFailure",
            rerunerror: "rerunError",
            flakyerror: "flakyError",
          };
          currentFailure = {
            kind: kindMap[name] as FailureDraft["kind"],
            type: attrs.type || undefined,
            message: attrs.message || undefined,
            text: "",
          };
          textTarget = "failure";
          textBuffer = "";
          return;
        }

        case "skipped": {
          if (!currentCase) return;
          currentCase.skipped = true;
          currentCase.skippedMessage = attrs.message || undefined;
          return;
        }

        case "system-out": {
          textTarget = "stdout";
          textBuffer = "";
          return;
        }

        case "system-err": {
          textTarget = "stderr";
          textBuffer = "";
          return;
        }

        case "stacktrace": {
          // Surefire nests <stackTrace> inside rerunFailure/flakyFailure.
          textTarget = "stackTrace";
          textBuffer = "";
          return;
        }

        default:
          return;
      }
    });

    const appendText = (text: string): void => {
      if (textTarget === null) return;
      // Guard against a single element growing without bound before we cap it.
      if (textBuffer.length < MAX_STACK_CHARS * 2) textBuffer += text;
    };

    parser.on("text", appendText);
    parser.on("cdata", appendText);

    parser.on("closetag", (tag: SaxesTag) => {
      const name = tag.name.toLowerCase();

      switch (name) {
        case "failure":
        case "error":
        case "rerunfailure":
        case "flakyfailure":
        case "rerunerror":
        case "flakyerror": {
          if (currentFailure && currentCase) {
            if (!currentFailure.text) currentFailure.text = textBuffer;
            currentCase.failures.push(currentFailure);
          }
          currentFailure = null;
          textTarget = null;
          textBuffer = "";
          return;
        }

        case "stacktrace": {
          if (currentFailure) currentFailure.text = textBuffer;
          textTarget = null;
          textBuffer = "";
          return;
        }

        case "system-out": {
          // Suite-level <system-out> is deliberately dropped: it is not
          // attributable to any one test, and copying it onto every result in the
          // suite would multiply a single log by the test count.
          if (currentCase) currentCase.stdout = textBuffer;
          textTarget = null;
          textBuffer = "";
          return;
        }

        case "system-err": {
          if (currentCase) currentCase.stderr = textBuffer;
          textTarget = null;
          textBuffer = "";
          return;
        }

        case "testcase": {
          if (!currentCase) return;
          const frame = suiteStack[suiteStack.length - 1];
          const result = buildResult(currentCase, frame, suiteNameFromRoot);
          currentCase = null;

          if (!frame) {
            // A <testcase> outside any <testsuite>: malformed but recoverable.
            emit(result);
            return;
          }
          mergeIntoSuite(frame, result, warnings);
          return;
        }

        case "testsuite": {
          const results = closeSuite();
          for (const result of results) emit(result);
          return;
        }

        default:
          return;
      }
    });

    const sanitizer = createXmlSanitizer(sanitizeStats);
    stream.pipe(sanitizer);

    try {
      for await (const chunk of sanitizer) {
        parser.write(chunk as string);
        // Flush on batch boundaries so a huge report never accumulates in memory.
        while (batch.length >= batchSize) {
          const slice = batch.splice(0, batchSize);
          await onBatch({ results: slice });
          context.onProgress?.({ bytesRead: sanitizeStats.bytesRead, resultsParsed });
        }
      }
      atEndOfDocument = true;
      parser.close();
    } catch (error) {
      if (error instanceof ParseError) throw error;
      throw new ParseError(
        `failed to read JUnit XML: ${error instanceof Error ? error.message : String(error)}`,
        { code: "read_failed", offset: sanitizeStats.bytesRead, cause: error },
      );
    }

    // Any suite left open (truncated document) still yields its results.
    while (suiteStack.length > 0) {
      warnings.push({
        code: "unclosed_suite",
        message: "report ended with an unclosed <testsuite>; results were kept",
        offset: sanitizeStats.bytesRead,
      });
      for (const result of closeSuite()) emit(result);
    }

    await flushBatch();

    if (!rootSeen) {
      throw new ParseError("no <testsuite> or <testsuites> element found", {
        code: "not_junit_xml",
      });
    }

    if (sanitizeStats.illegalCharsRemoved > 0) {
      warnings.push({
        code: "illegal_xml_chars",
        message:
          `removed ${sanitizeStats.illegalCharsRemoved} character(s) that are illegal in XML ` +
          `(usually ANSI colour codes captured in test output)`,
      });
    }

    if (resultsParsed === 0) {
      warnings.push({
        code: "no_results",
        message: "the report contained no <testcase> elements",
      });
    }

    if (!run.framework) run.framework = "junit";
    return { run, resultsParsed, warnings };
  }
}

/**
 * Picks the most path-like suite identifier available.
 *
 * Fingerprint stability depends on this: pytest puts the file on the testcase,
 * Playwright puts it in the suite name, Surefire uses a fully-qualified class and
 * no file at all. Preferring the most specific available source keeps one test's
 * identity stable across framework upgrades that change the others.
 */
function resolveSuite(
  draft: TestCaseDraft,
  frame: SuiteFrame | undefined,
  rootName: string | undefined,
): string | undefined {
  return draft.file ?? frame?.file ?? frame?.name ?? rootName;
}

function buildResult(
  draft: TestCaseDraft,
  frame: SuiteFrame | undefined,
  rootName: string | undefined,
): CanonicalTestResult {
  // Surefire expresses retries as extra elements inside one <testcase>:
  //   flakyFailure → an attempt failed but the test ultimately passed
  //   rerunFailure → an attempt failed and the test ultimately failed
  const hardFailures = draft.failures.filter((f) => f.kind === "failure" || f.kind === "error");
  const flakyAttempts = draft.failures.filter(
    (f) => f.kind === "flakyFailure" || f.kind === "flakyError",
  );
  const rerunAttempts = draft.failures.filter(
    (f) => f.kind === "rerunFailure" || f.kind === "rerunError",
  );

  let status: TestStatus;
  if (draft.skipped) status = "skipped";
  else if (hardFailures.some((f) => f.kind === "error")) status = "error";
  else if (hardFailures.length > 0) status = "failed";
  else status = "passed";

  const result: CanonicalTestResult = {
    name: draft.name,
    status,
  };

  const suite = resolveSuite(draft, frame, rootName);
  if (suite) result.suite = suite;
  if (draft.classname) result.classname = draft.classname;
  if (draft.durationMs !== undefined) result.durationMs = draft.durationMs;
  if (frame?.timestamp) result.startedAt = frame.timestamp;

  const primary = hardFailures[0] ?? rerunAttempts[0];
  if (primary) {
    result.failure = toFailure(primary);
  }

  if (draft.skipped && draft.skippedMessage) result.message = draft.skippedMessage;

  // Build the attempt chain oldest-first. Earlier attempts came from
  // flaky*/rerun* elements; the final attempt reflects the case's own status.
  const priorAttempts = [...flakyAttempts, ...rerunAttempts];
  if (priorAttempts.length > 0) {
    const retries: RetryAttempt[] = priorAttempts.map((attempt, index) => ({
      attempt: index + 1,
      status: (attempt.kind === "flakyError" || attempt.kind === "rerunError"
        ? "error"
        : "failed") as TestStatus,
      failure: toFailure(attempt),
    }));
    retries.push({
      attempt: priorAttempts.length + 1,
      status,
      ...(result.failure ? { failure: result.failure } : {}),
    });
    result.retries = retries;
  }

  if (draft.stdout.trim()) result.stdout = truncate(draft.stdout, MAX_OUTPUT_CHARS);
  if (draft.stderr.trim()) result.stderr = truncate(draft.stderr, MAX_OUTPUT_CHARS);

  return result;
}

function toFailure(draft: FailureDraft): NonNullable<CanonicalTestResult["failure"]> {
  const failure: NonNullable<CanonicalTestResult["failure"]> = {};
  if (draft.type) failure.type = truncate(draft.type, 512);
  if (draft.message) failure.message = truncate(draft.message, MAX_MESSAGE_CHARS);
  const text = draft.text.trim();
  if (text) {
    failure.stackTrace = truncate(text, MAX_STACK_CHARS);
    // Many writers put the assertion text only in the element body.
    if (!failure.message)
      failure.message = truncate(text.split(/\r?\n/)[0] ?? "", MAX_MESSAGE_CHARS);
  }
  return failure;
}

function identityOf(result: CanonicalTestResult): string {
  return `${result.suite ?? ""} ${result.classname ?? ""} ${result.name}`;
}

/**
 * Adds a result to its suite, folding repeat entries for the same identity into a
 * retry chain. Some frameworks (notably Cypress and certain Playwright configs)
 * emit one <testcase> per attempt instead of nesting them, and counting those as
 * separate tests would report a retried test as both a pass and a failure —
 * inflating totals and destroying the pass rate.
 */
function mergeIntoSuite(
  frame: SuiteFrame,
  result: CanonicalTestResult,
  warnings: ParseWarning[],
): void {
  if (frame.identities === null) {
    frame.pending.push(result);
    return;
  }

  if (frame.identities.size >= MAX_DEDUP_TRACKING_PER_SUITE) {
    warnings.push({
      code: "dedup_limit_reached",
      message:
        `suite "${frame.name}" exceeded ${MAX_DEDUP_TRACKING_PER_SUITE} distinct tests; ` +
        `retry collapsing was disabled for the remainder to bound memory`,
    });
    frame.identities = null;
    frame.pending.push(result);
    return;
  }

  const identity = identityOf(result);
  const existingIndex = frame.identities.get(identity);
  if (existingIndex === undefined) {
    frame.identities.set(identity, frame.pending.length);
    frame.pending.push(result);
    return;
  }

  const existing = frame.pending[existingIndex];
  if (!existing) {
    frame.pending.push(result);
    return;
  }
  frame.pending[existingIndex] = foldAttempt(existing, result);
}

/** `next` is a later attempt of the same test, so its status is authoritative. */
function foldAttempt(
  existing: CanonicalTestResult,
  next: CanonicalTestResult,
): CanonicalTestResult {
  const priorAttempts: RetryAttempt[] = existing.retries ?? [
    {
      attempt: 1,
      status: existing.status,
      ...(existing.durationMs !== undefined ? { durationMs: existing.durationMs } : {}),
      ...(existing.failure ? { failure: existing.failure } : {}),
    },
  ];

  const merged: CanonicalTestResult = {
    ...next,
    retries: [
      ...priorAttempts,
      {
        attempt: priorAttempts.length + 1,
        status: next.status,
        ...(next.durationMs !== undefined ? { durationMs: next.durationMs } : {}),
        ...(next.failure ? { failure: next.failure } : {}),
      },
    ],
  };

  // Total time spent is the sum across attempts, which is what a duration budget
  // or a "slowest tests" view should reflect.
  const totalDuration = (existing.durationMs ?? 0) + (next.durationMs ?? 0);
  if (totalDuration > 0) merged.durationMs = totalDuration;

  return merged;
}

export const junitXmlParser = new JUnitXmlParser();
