import {
  GATE_RULE_LABELS,
  type GateConfig,
  type GateOutcome,
  type GateRule,
  type GateRuleResult,
} from "@testcenter/core";

/**
 * The quality gate's verdict on a run.
 *
 * Sits beside `VerdictBadge`, and the pair is the point: that one is what a person concluded,
 * this is what the rules computed, and they are allowed to disagree. A failed gate with a `pass`
 * verdict is the normal shape of an accepted known failure, and collapsing the two would destroy
 * exactly the information that makes the disagreement worth reading.
 *
 * Prefixed "gate" for the same reason `VerdictBadge` prefixes "verdict": three badges sit in one
 * row on the run header, and an unlabelled green pill is ambiguous between "the runner passed",
 * "a human signed it off" and "the policy is satisfied".
 *
 * Colour never carries the outcome alone. Each state pairs a hue with a glyph *and* a word, so
 * the three are distinguishable without colour vision — which matters more here than for most
 * badges, since `passed` and `failed` are the two a reader scans for and they are the pair that
 * red-green deficiency collapses.
 */
const TONE: Record<GateOutcome, string> = {
  passed: "bg-[var(--color-status-passed)]/12 text-[var(--color-status-passed)]",
  failed: "bg-[var(--color-status-failed)]/12 text-[var(--color-status-failed)]",
  /*
   * Amber, the flaky tone, not red. `warned` means a rule was broken while the gate is advisory —
   * the build was not stopped and nobody needs to act right now. Painting it red would make an
   * advisory rollout indistinguishable from enforcement, which is the one thing the advisory
   * phase exists to keep separate.
   */
  warned: "bg-[var(--color-status-flaky)]/15 text-[var(--color-status-flaky)]",
  "not-evaluated": "bg-[var(--color-surface)] text-[var(--color-ink-muted)]",
};

const GLYPH: Record<GateOutcome, string> = {
  passed: "✓",
  failed: "✗",
  warned: "!",
  "not-evaluated": "·",
};

const WORD: Record<GateOutcome, string> = {
  passed: "passed",
  failed: "failed",
  warned: "would fail",
  "not-evaluated": "none",
};

const EXPLANATION: Record<GateOutcome, string> = {
  passed: "Every gate rule was satisfied",
  failed: "A gate rule was broken and this gate is enforcing",
  warned: "A gate rule was broken. This gate is advisory, so nothing was blocked",
  "not-evaluated": "No gate rules applied to this run",
};

export function GateBadge({
  outcome,
  results,
  size = "md",
}: {
  /**
   * Null for a run with no stored result — every run finished before the gate existed, and any
   * run whose project has switched the gate off.
   *
   * Renders nothing at all, deliberately, and this is where it differs from `VerdictBadge`'s
   * TODO. An unreviewed run is an open item somebody should act on, so a blank there hides work.
   * A run with no gate has nothing outstanding: no policy applied to it, and inventing a badge
   * would assert a judgement that was never made.
   */
  outcome: GateOutcome | null;
  /** Breached rules, summarised into the hover text so the badge explains itself in a list. */
  results?: GateRuleResult[];
  size?: "sm" | "md";
}) {
  if (outcome === null) return null;
  const sizing = size === "sm" ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-0.5 text-[11px]";

  const broken = (results ?? []).filter((result) => result.outcome === "failed");
  const title = broken.length
    ? `${EXPLANATION[outcome]}: ${broken.map((result) => result.message).join("; ")}`
    : EXPLANATION[outcome];

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded font-medium whitespace-nowrap ${sizing} ${TONE[outcome]}`}
      title={title}
    >
      <span className="opacity-60">gate</span>
      <span aria-hidden>{GLYPH[outcome]}</span>
      {WORD[outcome]}
    </span>
  );
}

/**
 * Every rule the gate applied, as a table of what it measured against what it allowed.
 *
 * A table rather than a list of sentences, because the question a reader arrives with is "how far
 * off were we" and a sentence buries the two numbers that answer it inside prose. `91.5%` beside
 * `≥ 98%` is a gap you can judge at a glance; "pass rate 91.5% (minimum 98%)" has to be read.
 *
 * Every rule appears, including the ones that passed and the ones that skipped. A gate that
 * printed only its breaches would give a reader no way to tell a satisfied rule from one that
 * never ran — and `no_new_failures` genuinely does skip itself on a branch with no history, which
 * would otherwise be indistinguishable from a pass.
 */
function ruleLabel(result: GateRuleResult): string {
  const base = GATE_RULE_LABELS[result.rule] ?? result.rule;
  // The selector is the interesting half of a tag rule; the generic label alone would render two
  // differently-scoped rules identically.
  if (result.rule === "max_failed_matching") {
    const tag = result.key.slice("max_failed_matching:".length);
    return `${base} — ${tag}`;
  }
  return base;
}

/** What the run scored, and the bar, in the rule's own units. */
function ruleValues(result: GateRuleResult): { measured: string; allowed: string } {
  if (result.rule === "require_complete_run") {
    // No numbers to show; the status is both the measurement and the requirement.
    const failed = result.outcome === "failed";
    return {
      measured: failed
        ? result.message.replace(/^run status is /, "").replace(/, not complete$/, "")
        : "complete",
      allowed: "complete",
    };
  }
  if (result.actual === null && result.limit === null) return { measured: "—", allowed: "—" };
  const unit = result.rule === "min_pass_rate" ? "%" : "";
  const measured = result.actual === null ? "—" : `${Math.round(result.actual * 10) / 10}${unit}`;
  const allowed =
    result.limit === null
      ? "—"
      : result.rule === "min_pass_rate"
        ? `\u2265 ${result.limit}${unit}`
        : `\u2264 ${result.limit}`;
  return { measured, allowed };
}

const MARK: Record<GateRuleResult["outcome"], { glyph: string; className: string; word: string }> =
  {
    passed: { glyph: "\u2713", className: "text-[var(--color-status-passed)]", word: "met" },
    failed: { glyph: "\u2717", className: "text-[var(--color-status-failed)]", word: "broken" },
    // Grey and a dash: a skipped rule reached no conclusion, and either status colour claims one.
    skipped: { glyph: "\u2013", className: "text-[var(--color-ink-muted)]", word: "not checked" },
  };

export function GateRuleList({ results }: { results: GateRuleResult[] }) {
  if (results.length === 0) return null;

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[26rem] text-left text-[12px]">
        <thead>
          <tr className="border-b border-[var(--color-border-subtle)] text-[10px] tracking-widest text-[var(--color-ink-muted)] uppercase">
            {/* "This run" and "Allowed" rather than "Measured" and "Limit": the reader is
                comparing their run against a bar, and naming the columns after that comparison
                saves them working out which number is theirs. */}
            <th className="py-1.5 pr-3 font-medium">Check</th>
            <th className="px-3 py-1.5 text-right font-medium">This run</th>
            <th className="px-3 py-1.5 text-right font-medium">Allowed</th>
            <th className="py-1.5 pl-3 font-medium">Result</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border-subtle)]">
          {results.map((result, index) => {
            const values = ruleValues(result);
            const mark = MARK[result.outcome];
            return (
              // Keyed by position: the order is the config's order, which is what the reader is
              // following down the table.
              <tr key={index}>
                <td className="py-1.5 pr-3">{ruleLabel(result)}</td>
                <td
                  className={`px-3 py-1.5 text-right font-mono tabular-nums ${
                    result.outcome === "failed" ? "font-semibold" : ""
                  }`}
                >
                  {values.measured}
                </td>
                <td className="px-3 py-1.5 text-right font-mono text-[var(--color-ink-muted)] tabular-nums">
                  {values.allowed}
                </td>
                <td className={`py-1.5 pl-3 whitespace-nowrap ${mark.className}`}>
                  <span aria-hidden>{mark.glyph}</span> {mark.word}
                  {result.outcome === "skipped" ? (
                    /* Why it was not checked, or the row reads as an unexplained gap. */
                    <span className="ml-1 text-[var(--color-ink-muted)]">({result.message})</span>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The verdict in a sentence, under the table.
 *
 * The badge says which way it went; this says what it means and whether anything happened as a
 * result. Under advisory that second half is the whole message — a reader who sees "would fail"
 * and no explanation reasonably assumes their build was stopped.
 */
export function GateVerdictLine({
  outcome,
  enforcement,
  results,
}: {
  outcome: GateOutcome;
  enforcement: string;
  results: GateRuleResult[];
}) {
  const broken = results.filter((r) => r.outcome === "failed").length;
  const checked = results.filter((r) => r.outcome !== "skipped").length;

  const verdict =
    outcome === "failed"
      ? `Failed — ${broken} of ${checked} rules broken. CI was told to stop.`
      : outcome === "warned"
        ? `Would fail — ${broken} of ${checked} rules broken. This gate is advisory, so nothing was blocked.`
        : outcome === "passed"
          ? `Passed — all ${checked} checked rule${checked === 1 ? "" : "s"} met.`
          : "No gate rules applied to this run.";

  return (
    <p className="mt-3 border-t border-[var(--color-border-subtle)] pt-2.5 text-[12px] text-[var(--color-ink-muted)]">
      <span className="font-medium text-[var(--color-ink)]">Verdict:</span> {verdict}
      {enforcement === "advisory" && outcome === "passed" ? (
        <span> Enforcement is off, so a breach would report rather than block.</span>
      ) : null}
    </p>
  );
}

/**
 * One rule as a plain clause — what it demands, not what it is called.
 *
 * "No new failures" names a setting; "no test that was passing has started failing" says what the
 * run has to do. The label is right on a settings row where the reader is choosing between rules;
 * the clause is right in a sentence, and the difference matters because most people meet this
 * feature when a build was blocked rather than when they were configuring it.
 */
export function gateRuleClause(rule: GateRule): string {
  switch (rule.rule) {
    case "require_complete_run":
      return "finish";
    case "no_new_failures":
      return rule.count === 0
        ? "not break a test that was passing"
        : `break no more than ${rule.count} previously passing test${rule.count === 1 ? "" : "s"}`;
    case "min_pass_rate":
      return `pass at least ${rule.percent}% of its tests`;
    case "max_failed":
      return `have no more than ${rule.count} failing test${rule.count === 1 ? "" : "s"}`;
    case "max_flaky":
      return `have no more than ${rule.count} flaky test${rule.count === 1 ? "" : "s"}`;
    case "max_failed_matching":
      return `have no more than ${rule.count} failure${rule.count === 1 ? "" : "s"} tagged ${rule.tag}`;
  }
}

/**
 * The whole policy in a sentence, for the top of a settings page or a run panel.
 *
 * A settings screen that lists controls without ever stating what they add up to leaves the
 * reader to assemble the policy themselves, and they will get it wrong — particularly here, where
 * the rules arrive from up to three places and none of the individual rows says whether anything
 * is actually enforced.
 */
export function describeGate(config: GateConfig): string {
  const active = config.rules.filter((rule) => rule.enabled !== false);
  if (!config.enabled || active.length === 0) {
    return "Runs are not being checked.";
  }

  const clauses = active.map(gateRuleClause);
  const list =
    clauses.length === 1
      ? clauses[0]
      : `${clauses.slice(0, -1).join(", ")} and ${clauses[clauses.length - 1]}`;

  const consequence =
    config.enforcement === "blocking"
      ? "If it does not, the build is stopped."
      : "If it does not, that is reported but nothing is stopped.";

  return `To pass, a run must ${list}. ${consequence}`;
}

/** The same three-state mark used in the rule table, exported so summaries can reuse it. */
export { GATE_RULE_LABELS };
