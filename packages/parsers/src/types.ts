import type { Readable } from "node:stream";
import type { CanonicalTestResult, RunMetadata } from "@testcenter/core";

/**
 * Parser contract.
 *
 * Framework knowledge lives *only* behind this interface. Nothing downstream —
 * persistence, UI, analytics, alerting — may branch on which framework produced a
 * result, which is what allows a new format to ship without touching anything
 * outside this package.
 */
export interface ParseContext {
  /** Resolved project id, needed for fingerprinting. */
  projectId: string;
  /** Filename as uploaded; several dialects are only distinguishable by name. */
  filename: string;
  /** Metadata the uploader declared. Parsed values fill gaps, never override. */
  declaredRun?: Partial<RunMetadata>;
  /** Emit batches no larger than this so memory stays bounded on huge reports. */
  batchSize?: number;
  /** Called as parsing advances, to drive the live upload progress indicator. */
  onProgress?: (progress: ParseProgress) => void;
}

export interface ParseProgress {
  bytesRead: number;
  resultsParsed: number;
}

/**
 * What a parser yields. Run-level metadata is emitted as a partial because most
 * formats only reveal totals and timing once the whole document has been read.
 */
export interface ParsedBatch {
  results: CanonicalTestResult[];
}

export interface ParseOutcome {
  /** Run fields the report itself supplied (framework, duration, timestamps). */
  run: Partial<RunMetadata>;
  resultsParsed: number;
  /**
   * Non-fatal problems: an unparseable testcase, an unknown element, a truncated
   * document. Surfaced on the run as a warning rather than discarded, because a
   * silent partial import is worse than a visible one.
   */
  warnings: ParseWarning[];
}

export interface ParseWarning {
  code: string;
  message: string;
  /** Approximate byte offset, for pointing a human at the right place. */
  offset?: number;
}

export interface Parser {
  /** Stable identifier persisted on the artifact, e.g. "junit-xml". */
  readonly id: string;
  /** Bumped when output changes, so stored artifacts can be re-parsed. */
  readonly version: string;
  readonly displayName: string;

  /**
   * Confidence in [0,1] that this parser handles the input, judged from the head
   * of the file plus its name. Confidence rather than a boolean because dialects
   * genuinely overlap — a TestNG-generated JUnit file is valid input for both the
   * generic JUnit parser and a TestNG-specific one, and the more specific parser
   * should win rather than the first one registered.
   */
  detect(head: Buffer, filename: string): number;

  /** Streams the artifact; must never buffer the whole document. */
  parse(
    stream: Readable,
    context: ParseContext,
    onBatch: (batch: ParsedBatch) => Promise<void>,
  ): Promise<ParseOutcome>;
}

export class ParseError extends Error {
  readonly code: string;
  readonly offset: number | undefined;

  constructor(message: string, options: { code: string; offset?: number; cause?: unknown }) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ParseError";
    this.code = options.code;
    this.offset = options.offset;
  }
}
