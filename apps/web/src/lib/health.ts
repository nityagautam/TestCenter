/**
 * Thresholds that turn a measurement into a tone.
 *
 * These live in one place because the alternative is what this replaced: each tile
 * deciding for itself, and deciding badly. The org and project dashboards both painted
 * the headline pass rate with the critical colour whenever `failing > 0` — so a 97.7%
 * pass rate rendered in the same red as an outage, and since every real project has at
 * least one failing test somewhere, the loudest colour on the page was permanently lit.
 * A signal that is always on carries no information and trains people to ignore the one
 * time it matters.
 *
 * The bands are a judgement call, stated openly so they can be argued with and, later,
 * configured per project alongside the quality gates:
 *
 *   ≥ 98%   healthy      the tail of individually broken tests, not a systemic problem
 *   ≥ 90%   warning      degraded and worth attention, but the suite still functions
 *   < 90%   critical     more than one test in ten is red; the suite is not trustworthy
 *
 * The count of failing tests keeps its own unconditional red tile. That is the right
 * place for it: a count of failures genuinely is a failure count at any value above
 * zero, whereas a rate has to be judged against a bar.
 */
export const PASS_RATE_HEALTHY = 98;
export const PASS_RATE_DEGRADED = 90;

export type Tone = "passed" | "flaky" | "failed" | "neutral";

/**
 * The mark colour for a tone, for charts that paint by health rather than by series.
 *
 * Lives here rather than in each chart so a bar and a stat tile reading the same rate can
 * never disagree about whether it is healthy. Status colour is legitimate here — these
 * bands genuinely mean good/warning/bad — and it is never the only encoding: every bar
 * that uses it is direct-labelled with its percentage.
 */
export const TONE_COLOR: Record<Tone, string> = {
  passed: "var(--color-status-passed)",
  flaky: "var(--color-status-flaky)",
  failed: "var(--color-status-failed)",
  neutral: "var(--color-status-skipped)",
};

/**
 * A null rate means no runs in the window, which is the absence of a measurement rather
 * than a bad one. Colouring it would assert something about a suite nobody has run.
 */
export function passRateTone(passRate: number | null): Tone {
  if (passRate === null) return "neutral";
  if (passRate >= PASS_RATE_HEALTHY) return "passed";
  if (passRate >= PASS_RATE_DEGRADED) return "flaky";
  return "failed";
}
