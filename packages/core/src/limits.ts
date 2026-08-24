import { z } from "zod";

/**
 * Size caps on the free-text a test can write into a row, as configuration.
 *
 * These were four literals in two packages, and raising one of them meant editing the parser,
 * editing the read query that has to agree with it, rebuilding and redeploying. They are
 * capacity knobs — the right value depends on how chatty a customer's suites are and how much
 * retention they are paying for — so they belong in the environment.
 *
 * Deliberately a separate reader from `loadEnv`, and not a convenience.
 *
 * `loadEnv` requires `DATABASE_URL` and throws without it, which is correct for a service and
 * wrong for a library: `@testcenter/parsers` is a streaming XML parser with no database, and
 * its unit tests run with no environment at all. Routing the parser through `loadEnv` would
 * make importing the parser depend on being configured as a full application. This reader
 * validates only these four values, requires none of them, and falls back to the defaults
 * below — so the parser stays usable standalone while the service still validates them at
 * boot, because `envSchema` spreads this same shape.
 */
export const outputLimitsSchema = z.object({
  /**
   * The ceiling on one row's captured stdout or stderr.
   *
   * `test_results.stdout` is an unbounded `text` column and `test_results` is partitioned
   * monthly for retention, so this is the knob that decides how much a single chatty test
   * costs across every run it appears in. Postgres TOASTs values this large out of line and
   * compresses them, so the cost lands in the TOAST table rather than the main heap.
   */
  MAX_OUTPUT_CHARS: z.coerce.number().int().min(1_000).max(20_000_000).default(200_000),
  /** The ceiling on one failure's stack trace. */
  MAX_STACK_CHARS: z.coerce.number().int().min(1_000).max(20_000_000).default(64_000),
  /** The ceiling on one failure message — the short line, not the trace. */
  MAX_MESSAGE_CHARS: z.coerce.number().int().min(200).max(1_000_000).default(8_000),
  /**
   * How much captured output a *multi-row* read returns unless the caller asks for more.
   *
   * Separate from `MAX_OUTPUT_CHARS` because the two protect different things, and raising the
   * storage cap is exactly where conflating them hurts: a timeline query returns up to 100
   * executions, so defaulting to the storage ceiling would put 20 MB of text in one response.
   * The ceiling protects the row; this protects the payload. A view rendering one execution can
   * ask for the ceiling and get everything.
   */
  OUTPUT_READ_CHARS: z.coerce.number().int().min(200).max(20_000_000).default(64_000),
});

export interface OutputLimits {
  maxOutputChars: number;
  maxStackChars: number;
  maxMessageChars: number;
  outputReadChars: number;
}

let cached: OutputLimits | null = null;

/**
 * The limits, memoized.
 *
 * Memoized because the parser consults them once per test case and a zod parse per case would
 * be real overhead on a report with a million of them. Environment is fixed for a process
 * lifetime, so caching costs nothing in correctness.
 *
 * Invalid values throw rather than falling back silently: `MAX_OUTPUT_CHARS=banana` meaning
 * "quietly keep 200000" is how a deployment ends up not doing what its config says.
 */
export function outputLimits(source: NodeJS.ProcessEnv = process.env): OutputLimits {
  if (cached) return cached;
  const parsed = outputLimitsSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid output limit configuration:\n${issues}`);
  }
  cached = {
    maxOutputChars: parsed.data.MAX_OUTPUT_CHARS,
    maxStackChars: parsed.data.MAX_STACK_CHARS,
    maxMessageChars: parsed.data.MAX_MESSAGE_CHARS,
    outputReadChars: parsed.data.OUTPUT_READ_CHARS,
  };
  return cached;
}

/** Test-only: clears the memoized limits between cases. */
export function resetOutputLimitsCache(): void {
  cached = null;
}
