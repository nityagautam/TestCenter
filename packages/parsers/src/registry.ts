import type { Readable } from "node:stream";
import { junitXmlParser } from "./junit/junit-xml.js";
import { ParseError, type Parser } from "./types.js";

/**
 * Parser registry.
 *
 * Detection is confidence-based rather than first-match: dialects genuinely
 * overlap (TestNG and Gradle both emit valid JUnit XML), so a future dedicated
 * parser must be able to outrank the generic one without depending on registration
 * order. Phase 2 adds Playwright JSON, TestNG native, Allure and the rest here and
 * nowhere else.
 */
const PARSERS: readonly Parser[] = [junitXmlParser];

/** Enough bytes to see the root element and a first suite. */
export const DETECTION_HEAD_BYTES = 8192;

export interface DetectionResult {
  parser: Parser;
  confidence: number;
}

export function listParsers(): readonly Parser[] {
  return PARSERS;
}

export function findParserById(id: string): Parser | undefined {
  return PARSERS.find((parser) => parser.id === id);
}

/** Highest-confidence parser, or null when nothing recognises the input. */
export function detectParser(head: Buffer, filename: string): DetectionResult | null {
  let best: DetectionResult | null = null;
  for (const parser of PARSERS) {
    const confidence = parser.detect(head, filename);
    if (confidence <= 0) continue;
    if (!best || confidence > best.confidence) best = { parser, confidence };
  }
  return best;
}

/**
 * Reads just the head of a stream for detection and returns it alongside a stream
 * that still yields the full content.
 *
 * Needed because detection has to inspect the first bytes while the parser must
 * then see the whole document — and we refuse to buffer the entire artifact, which
 * can be hundreds of megabytes.
 */
export async function peekHead(
  stream: Readable,
  bytes = DETECTION_HEAD_BYTES,
): Promise<{ head: Buffer; rest: Readable }> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    chunks.push(buffer);
    size += buffer.length;
    if (size >= bytes) break;
  }

  const head = Buffer.concat(chunks).subarray(0, bytes);

  // Replay the consumed head, then continue with whatever is left of the source.
  const { Readable: NodeReadable } = await import("node:stream");
  const consumed = Buffer.concat(chunks);
  const rest = NodeReadable.from(
    (async function* replay() {
      yield consumed;
      // `stream` may already be exhausted for small files; iterating a finished
      // stream simply yields nothing.
      for await (const chunk of stream) yield chunk;
    })(),
  );

  return { head, rest };
}

export class NoParserError extends ParseError {
  constructor(filename: string) {
    super(
      `no parser recognised "${filename}". Supported: ${PARSERS.map((p) => p.displayName).join(", ")}`,
      { code: "no_parser" },
    );
    this.name = "NoParserError";
  }
}
