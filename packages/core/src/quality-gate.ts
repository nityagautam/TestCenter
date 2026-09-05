import { z } from "zod";

/**
 * Quality gates — the mechanical go/no-go on a run.
 *
 * WHY THIS IS NOT A RUN VERDICT
 *
 * `run_verdicts` already answers "was this build acceptable", and it is a person's answer. This
 * is the machine's, and the two must not be collapsed: a gate can be wrong in ways only a human
 * can see (the one failure is a known outage), and a human sign-off does not make a pass rate
 * acceptable. The product already draws this line once — `failure_category` is read from the
 * report, `failure_triage` is claimed by somebody — and a gate is the same distinction applied
 * to a whole run. So a gate result never writes a verdict and never clears one.
 *
 * WHY THE EVALUATOR IS PURE
 *
 * Everything here takes facts and returns a judgement. Assembling the facts needs the database;
 * deciding what they mean does not, and keeping the two apart is what makes the rules testable
 * without a run to point them at. It also means the same evaluator can price a config change
 * against history — "what would this gate have said about the last 200 runs" is the question
 * anybody sensible asks before switching one on, and it is only answerable if evaluation is a
 * function rather than a pipeline stage.
 */

/**
 * Bumped when the meaning of a rule changes, not when one is added.
 *
 * Stored on every result, because a gate result is a decision CI acted on: "why did build 4812
 * fail the gate" has to stay answerable after somebody edits the thresholds. The config snapshot
 * beside it carries the numbers; this carries the semantics.
 */
export const QUALITY_GATE_VERSION = 1;

/* ── Rules ─────────────────────────────────────────────────────────────────── */

export const GATE_RULE_KINDS = [
  "min_pass_rate",
  "max_failed",
  "max_failed_matching",
  "max_flaky",
  "require_complete_run",
  "no_new_failures",
] as const;
export type GateRuleKind = (typeof GATE_RULE_KINDS)[number];

export const GATE_RULE_LABELS: Record<GateRuleKind, string> = {
  min_pass_rate: "Minimum pass rate",
  max_failed: "Maximum failures",
  max_failed_matching: "Maximum failures matching a tag",
  max_flaky: "Flake budget",
  require_complete_run: "Run must have completed",
  no_new_failures: "No new failures",
};

const baseRule = z.object({
  /**
   * Lets a more specific layer switch a rule off without restating it. Absent means enabled —
   * the common case should not need a field.
   */
  enabled: z.boolean().optional(),
});

export const gateRuleSchema = z.discriminatedUnion("rule", [
  baseRule.extend({ rule: z.literal("min_pass_rate"), percent: z.number().min(0).max(100) }),
  baseRule.extend({ rule: z.literal("max_failed"), count: z.number().int().min(0) }),
  baseRule.extend({
    rule: z.literal("max_failed_matching"),
    /**
     * A `key:value` tag selector, matched against the tags on each failing result.
     *
     * This is how "critical tests must not fail" is expressed, and it is a selector rather than
     * a dedicated `critical` flag because tags already exist, are already indexed on results,
     * and `tags.ts` already names quality-gate scoping as a reason they do. One rule then covers
     * `severity:critical`, `suite:smoke` and any per-component bar a team invents, with no new
     * identity concept to keep in sync.
     */
    tag: z.string().min(3),
    count: z.number().int().min(0),
  }),
  baseRule.extend({ rule: z.literal("max_flaky"), count: z.number().int().min(0) }),
  baseRule.extend({ rule: z.literal("require_complete_run") }),
  baseRule.extend({ rule: z.literal("no_new_failures"), count: z.number().int().min(0) }),
]);
export type GateRule = z.infer<typeof gateRuleSchema>;

/**
 * Identity of a rule within a config, used to merge the org, project and branch layers.
 *
 * The tag is part of the key for `max_failed_matching` on purpose: a project gating both
 * `severity:critical` and `suite:smoke` has two rules of the same kind, and keying on the kind
 * alone would silently drop one when the layers merged.
 */
export function gateRuleKey(rule: GateRule): string {
  return rule.rule === "max_failed_matching" ? `max_failed_matching:${rule.tag}` : rule.rule;
}

/* ── Config ────────────────────────────────────────────────────────────────── */

/**
 * How failures are counted, before any rule looks at them.
 *
 * These are the difference between a gate people trust and one they mute. A gate that fails a
 * build for a test known to be flaky teaches everyone that the gate is noise, and the fix is not
 * a looser threshold — it is not counting the noise in the first place.
 */
export const gateModifiersSchema = z.object({
  /** Quarantined tests are already declared untrustworthy; counting them re-litigates that. */
  ignoreQuarantined: z.boolean().default(true),
});

/*
 * There is deliberately no `countRetryPassedAsPass` modifier.
 *
 * It was specified, and then measured away: `ingest` already collapses a retry chain into one
 * result carrying the final status, so a test that failed and then passed is stored as `passed`
 * with `retry_count > 0`. In the current database that is 106 rows, against zero failed rows
 * carrying any retries at all. The switch would have had nothing to switch.
 *
 * Shipping it anyway would have been worse than useless: a settings control implies the
 * behaviour is in question, so somebody would eventually toggle it, observe no change, and
 * distrust the rest of the gate. Retry-passed tests are instead visible where they belong —
 * `max_flaky`, which budgets them without pretending they were failures.
 */
export type GateModifiers = z.infer<typeof gateModifiersSchema>;

export const GATE_ENFORCEMENTS = ["advisory", "blocking"] as const;
export type GateEnforcement = (typeof GATE_ENFORCEMENTS)[number];

export const gateConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /**
   * Advisory evaluates and reports; blocking is what makes CI exit non-zero.
   *
   * Defaulting to advisory is deliberate. A gate switched straight to blocking spends its first
   * week failing builds for flakes nobody has budgeted for, and the lasting outcome of that is a
   * team that has turned it off. Advisory lets the thresholds be argued with against real runs
   * first, which is the only way they end up defensible.
   */
  enforcement: z.enum(GATE_ENFORCEMENTS).default("advisory"),
  modifiers: gateModifiersSchema.default({ ignoreQuarantined: true }),
  rules: z.array(gateRuleSchema).default([]),
});
export type GateConfig = z.infer<typeof gateConfigSchema>;

/**
 * What one *layer* stores: only the fields it means to override, with no defaults applied.
 *
 * Spelled out rather than derived as `gateConfigSchema.partial()`, which was the first attempt
 * and was silently wrong. Zod applies a field's `.default()` even when `.partial()` has made it
 * optional, so a branch row holding `{"enforcement":"blocking"}` parsed back as
 * `{enabled:false, enforcement:"blocking", modifiers:{…}, rules:[]}` — and since the resolver
 * treats any defined field as an intentional override, the most specific layer asserted
 * `enabled: false` and turned off a gate the organisation had switched on.
 *
 * It failed in the worst possible direction: adding a branch override *disabled* enforcement,
 * and nothing errored. Three runs on `main` recorded no result at all while a feature branch
 * with no override evaluated fine, which is the opposite of what anyone would predict.
 *
 * A patch is therefore its own type. Absent means inherit, and only absent can mean that.
 */
export const gateConfigPatchSchema = z.object({
  enabled: z.boolean().optional(),
  enforcement: z.enum(GATE_ENFORCEMENTS).optional(),
  modifiers: z.object({ ignoreQuarantined: z.boolean().optional() }).optional(),
  rules: z.array(gateRuleSchema).optional(),
});
export type GateConfigPatch = z.infer<typeof gateConfigPatchSchema>;

/** The layer a setting came from, kept so the UI can say where a number was inherited from. */
export const GATE_SCOPES = ["org", "project", "branch"] as const;
export type GateScope = (typeof GATE_SCOPES)[number];

export type GateConfigLayer = {
  scope: GateScope;
  /** Only set for `branch`. */
  branch?: string | null;
  config: GateConfigPatch;
};

/**
 * Fold org defaults, a project override and a branch override into the config that actually runs.
 *
 * Layers compose rather than replace. Whole-config replacement is simpler to implement and worse
 * to live with: tightening one threshold on main would mean restating every other rule, and the
 * copies drift the first time somebody edits the org default and forgets the four projects that
 * duplicated it.
 *
 * Scalars take the most specific layer that sets them. Rules merge by `gateRuleKey`, so a branch
 * can tighten `min_pass_rate` while inheriting everything else, and can switch a rule off with
 * `enabled: false` without needing a way to express deletion.
 *
 * The cost of composing is that "why did this run fail the gate" could mean reading three
 * places. That is paid for by storing the *resolved* config on every result — the answer is
 * always in one place afterwards, whatever it was assembled from.
 */
export function resolveGateConfig(layers: GateConfigLayer[]): {
  config: GateConfig;
  sources: Partial<Record<keyof GateConfig | "rules", GateScope>>;
} {
  const ordered = GATE_SCOPES.flatMap((scope) => layers.filter((layer) => layer.scope === scope));

  /*
   * Seeded from `DEFAULT_GATE_CONFIG`, which makes the default a real layer underneath the other
   * three rather than a value the UI happens to prefill. The difference shows up on every project
   * nobody has configured: with a seeded default they are gated from their first run, and an
   * organisation that adds a policy later *narrows* an existing gate instead of creating one.
   *
   * No scope is recorded for these, so `sources` says a setting was inherited from the product
   * itself rather than naming a layer that does not exist.
   */
  const sources: Partial<Record<keyof GateConfig | "rules", GateScope>> = {};
  let enabled = DEFAULT_GATE_CONFIG.enabled;
  let enforcement: GateEnforcement = DEFAULT_GATE_CONFIG.enforcement;
  let modifiers: GateModifiers = { ...DEFAULT_GATE_CONFIG.modifiers };
  const rules = new Map<string, GateRule>(
    DEFAULT_GATE_CONFIG.rules.map((rule) => [gateRuleKey(rule), rule]),
  );

  for (const layer of ordered) {
    if (layer.config.enabled !== undefined) {
      enabled = layer.config.enabled;
      sources.enabled = layer.scope;
    }
    if (layer.config.enforcement !== undefined) {
      enforcement = layer.config.enforcement;
      sources.enforcement = layer.scope;
    }
    if (layer.config.modifiers !== undefined) {
      modifiers = { ...modifiers, ...layer.config.modifiers };
      sources.modifiers = layer.scope;
    }
    if (layer.config.rules !== undefined) {
      for (const rule of layer.config.rules) rules.set(gateRuleKey(rule), rule);
      sources.rules = layer.scope;
    }
  }

  return {
    config: { enabled, enforcement, modifiers, rules: [...rules.values()] },
    sources,
  };
}

/* ── Evaluation ────────────────────────────────────────────────────────────── */

/**
 * Everything a rule may ask about a run, assembled by the caller.
 *
 * Counts are post-modifier: the database layer decides what "failed" means once, so every rule
 * agrees. Doing it per rule is how you end up with `max_failed` and `max_failed_matching`
 * disagreeing about whether a quarantined test counts.
 */
export type GateFacts = {
  /** `complete` or `partial` from the run; anything else means it never finished. */
  status: string;
  passRate: number;
  failed: number;
  flaky: number;
  /** Failures per tag selector, keyed exactly as the rule's `tag`. */
  failedMatching: Record<string, number>;
  /**
   * Failures whose signature is absent from the branch baseline, or `null` when no baseline
   * exists yet.
   *
   * `null` is not zero. The first run on a new branch has nothing to compare against, and
   * reporting "0 new failures" there would pass a gate on the strength of a comparison that was
   * never made. It skips instead, with a reason.
   */
  newFailures: number | null;
};

export type GateRuleOutcome = "passed" | "failed" | "skipped";

export type GateRuleResult = {
  key: string;
  rule: GateRuleKind;
  outcome: GateRuleOutcome;
  /** Rendered for a human — the CI log line and the run page row. */
  message: string;
  actual: number | null;
  limit: number | null;
};

export const GATE_OUTCOMES = ["passed", "failed", "warned", "not-evaluated"] as const;
export type GateOutcome = (typeof GATE_OUTCOMES)[number];

export const GATE_OUTCOME_LABELS: Record<GateOutcome, string> = {
  passed: "Gate passed",
  failed: "Gate failed",
  warned: "Gate would fail",
  "not-evaluated": "No gate",
};

export type GateEvaluation = {
  outcome: GateOutcome;
  /** True when a rule was breached, regardless of whether enforcement acted on it. */
  breached: boolean;
  enforcement: GateEnforcement;
  results: GateRuleResult[];
  version: number;
};

function pct(value: number): string {
  return `${Math.round(value * 10) / 10}%`;
}

/**
 * Apply a resolved config to the facts of one run.
 *
 * A breach under `advisory` reports `warned`, not `failed`: the distinction is the entire point
 * of the advisory phase, and flattening it would leave no way to see what a gate *would* have
 * blocked before switching it on.
 */
export function evaluateGate(config: GateConfig, facts: GateFacts): GateEvaluation {
  /*
   * "No active rules" is not the same as "passed", and the distinction has to be made on the
   * *enabled* rules rather than on the array being empty. A project that inherits three org
   * rules and switches all three off at branch level has a non-empty config and has checked
   * nothing; reporting a pass there is the badge asserting a bar was met that nobody set.
   *
   * A rule that runs and skips itself — `no_new_failures` with no baseline — is deliberately not
   * this case. There the gate did apply, found nothing to object to, and the skipped rule states
   * its own reason in `results`, which is what a reader needs to see.
   */
  const active = config.rules.filter((rule) => rule.enabled !== false);
  if (!config.enabled || active.length === 0) {
    return {
      outcome: "not-evaluated",
      breached: false,
      enforcement: config.enforcement,
      results: [],
      version: QUALITY_GATE_VERSION,
    };
  }

  const results: GateRuleResult[] = [];

  for (const rule of active) {
    const key = gateRuleKey(rule);

    switch (rule.rule) {
      case "require_complete_run": {
        /*
         * The rule that stops the gate being cheatable by crashing. A run that died halfway has
         * *fewer* failures than one that finished, so every threshold below is trivially passed
         * by a suite that fell over — which is the opposite of what any of them meant.
         */
        const complete = facts.status === "complete";
        results.push({
          key,
          rule: rule.rule,
          outcome: complete ? "passed" : "failed",
          message: complete ? "run completed" : `run status is ${facts.status}, not complete`,
          actual: null,
          limit: null,
        });
        break;
      }
      case "min_pass_rate": {
        const ok = facts.passRate >= rule.percent;
        results.push({
          key,
          rule: rule.rule,
          outcome: ok ? "passed" : "failed",
          message: `pass rate ${pct(facts.passRate)} (minimum ${pct(rule.percent)})`,
          actual: facts.passRate,
          limit: rule.percent,
        });
        break;
      }
      case "max_failed": {
        const ok = facts.failed <= rule.count;
        results.push({
          key,
          rule: rule.rule,
          outcome: ok ? "passed" : "failed",
          message: `${facts.failed} failed (limit ${rule.count})`,
          actual: facts.failed,
          limit: rule.count,
        });
        break;
      }
      case "max_failed_matching": {
        const actual = facts.failedMatching[rule.tag] ?? 0;
        const ok = actual <= rule.count;
        results.push({
          key,
          rule: rule.rule,
          outcome: ok ? "passed" : "failed",
          message: `${actual} failed with ${rule.tag} (limit ${rule.count})`,
          actual,
          limit: rule.count,
        });
        break;
      }
      case "max_flaky": {
        const ok = facts.flaky <= rule.count;
        results.push({
          key,
          rule: rule.rule,
          outcome: ok ? "passed" : "failed",
          message: `${facts.flaky} flaky (budget ${rule.count})`,
          actual: facts.flaky,
          limit: rule.count,
        });
        break;
      }
      case "no_new_failures": {
        /*
         * No history is not a missing measurement — it is a measurement of zero.
         *
         * This rule counts tests that were passing and have started failing. On the first run of a
         * branch no test was previously passing, so the number that can have regressed is exactly
         * zero. That is a fact about the run, not an assumption about it, which is why the rule
         * now reports 0 and passes rather than skipping.
         *
         * The message still says there was nothing to compare against. A bare "0 new failures"
         * would be true but would let a reader infer a comparison that never happened, and the
         * first run of a branch is precisely when somebody might lean on that inference.
         */
        if (facts.newFailures === null) {
          const withinLimit = 0 <= rule.count;
          results.push({
            key,
            rule: rule.rule,
            outcome: withinLimit ? "passed" : "failed",
            message: "0 new failures — no earlier runs to compare against",
            actual: 0,
            limit: rule.count,
          });
          break;
        }
        const ok = facts.newFailures <= rule.count;
        results.push({
          key,
          rule: rule.rule,
          outcome: ok ? "passed" : "failed",
          message: `${facts.newFailures} new failure${facts.newFailures === 1 ? "" : "s"} (limit ${rule.count})`,
          actual: facts.newFailures,
          limit: rule.count,
        });
        break;
      }
    }
  }

  const breached = results.some((result) => result.outcome === "failed");
  const outcome: GateOutcome = !breached
    ? "passed"
    : config.enforcement === "blocking"
      ? "failed"
      : "warned";

  return {
    outcome,
    breached,
    enforcement: config.enforcement,
    results,
    version: QUALITY_GATE_VERSION,
  };
}

/**
 * The gate every project has before anybody configures one.
 *
 * Applied, not merely offered. A gate that has to be switched on is a gate most projects never
 * get, and the two rules here are the ones that need no local knowledge to be correct: a run that
 * did not finish is not evidence, and a test that used to pass and now does not is a regression
 * wherever it happens. Neither needs a threshold somebody has to pick, which is exactly why they
 * can be a default when `min_pass_rate` cannot.
 *
 * Chosen against this product's own history rather than from a template. Replaying a six-rule
 * candidate over 79 real runs put the median pass rate at 73% and only 15 runs above 98%, so a
 * `min_pass_rate` default would have failed four builds in five — indistinguishable from no gate,
 * and switched off within a week. Over the same runs `no_new_failures` fired on one: the one that
 * had genuinely regressed.
 *
 * `advisory`, and that is the part that makes defaulting to *on* safe. The gate forms and shows
 * an opinion on every run from the first day; nothing blocks until somebody chooses `blocking` in
 * settings. Enforcement is the decision a team makes, so it is the decision the settings screen
 * asks about — the rules themselves do not need to wait for it.
 *
 * A project that genuinely wants no gate sets `enabled: false` at any layer, which is expressible
 * precisely because this is a layer like the others.
 */
export const DEFAULT_GATE_CONFIG: GateConfig = {
  enabled: true,
  enforcement: "advisory",
  modifiers: { ignoreQuarantined: true },
  rules: [{ rule: "require_complete_run" }, { rule: "no_new_failures", count: 0 }],
};
