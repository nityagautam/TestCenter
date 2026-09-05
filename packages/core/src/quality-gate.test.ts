import { describe, expect, it } from "vitest";
import {
  evaluateGate,
  gateConfigPatchSchema,
  gateConfigSchema,
  gateRuleKey,
  resolveGateConfig,
  type GateConfig,
  type GateFacts,
} from "./quality-gate.js";

const GREEN: GateFacts = {
  status: "complete",
  passRate: 100,
  failed: 0,
  flaky: 0,
  failedMatching: {},
  newFailures: 0,
};

function config(overrides: Partial<GateConfig>): GateConfig {
  return gateConfigSchema.parse({ enabled: true, ...overrides });
}

describe("evaluateGate", () => {
  it("says nothing when there is no gate to apply", () => {
    // Distinct from passing. A project with no gate has not met a bar, and a badge claiming it
    // did would be the dashboard inventing a fact.
    expect(evaluateGate(config({ rules: [] }), GREEN).outcome).toBe("not-evaluated");
    expect(
      evaluateGate(
        gateConfigSchema.parse({ enabled: false, rules: [{ rule: "max_failed", count: 0 }] }),
        GREEN,
      ).outcome,
    ).toBe("not-evaluated");
  });

  describe("advisory is not a weaker failure, it is a different answer", () => {
    const rules = [{ rule: "max_failed" as const, count: 0 }];
    const facts = { ...GREEN, failed: 3 };

    it("reports a breach as warned while advisory", () => {
      const evaluation = evaluateGate(config({ rules, enforcement: "advisory" }), facts);
      expect(evaluation.outcome).toBe("warned");
      // The breach is still recorded — that is the whole point of the advisory phase, since
      // "what would this have blocked" is unanswerable if a warning does not know it breached.
      expect(evaluation.breached).toBe(true);
    });

    it("reports the same breach as failed once blocking", () => {
      const evaluation = evaluateGate(config({ rules, enforcement: "blocking" }), facts);
      expect(evaluation.outcome).toBe("failed");
      expect(evaluation.breached).toBe(true);
    });
  });

  it("fails a run that never completed, whatever its counts say", () => {
    /*
     * The rule that stops the gate being cheatable. A suite that fell over halfway has fewer
     * failures than one that finished, so it passes every threshold — this is the only rule that
     * notices the run is not evidence of anything.
     */
    const evaluation = evaluateGate(
      config({
        rules: [{ rule: "require_complete_run" }, { rule: "max_failed", count: 5 }],
        enforcement: "blocking",
      }),
      { ...GREEN, status: "partial", failed: 1 },
    );
    expect(evaluation.outcome).toBe("failed");
    expect(evaluation.results.find((r) => r.rule === "max_failed")?.outcome).toBe("passed");
    expect(evaluation.results.find((r) => r.rule === "require_complete_run")?.message).toContain(
      "partial",
    );
  });

  it("counts no history as zero regressions, and says why", () => {
    /*
     * The first run of a branch has no test that was previously passing, so the number that can
     * have regressed is exactly zero — a fact, not a guess. The rule therefore reports 0 and
     * passes rather than skipping.
     *
     * It still says what happened. "0 new failures" alone is true but invites the reader to infer
     * a comparison that never took place, and a first run is exactly when someone might lean on
     * that inference.
     */
    const evaluation = evaluateGate(
      config({ rules: [{ rule: "no_new_failures", count: 0 }], enforcement: "blocking" }),
      { ...GREEN, failed: 9, newFailures: null },
    );
    expect(evaluation.outcome).toBe("passed");
    expect(evaluation.breached).toBe(false);
    const result = evaluation.results[0];
    expect(result?.outcome).toBe("passed");
    expect(result?.actual).toBe(0);
    expect(result?.message).toContain("no earlier runs to compare");
  });

  it("separates new failures from the total, which is the point of the rule", () => {
    const evaluation = evaluateGate(
      config({ rules: [{ rule: "no_new_failures", count: 0 }], enforcement: "blocking" }),
      { ...GREEN, failed: 40, newFailures: 0 },
    );
    // Forty long-standing failures and no regression is a passing build under this rule. That is
    // the intent: the rule gates the delta, and a threshold rule gates the absolute.
    expect(evaluation.outcome).toBe("passed");
  });

  it("counts each tag selector separately", () => {
    const evaluation = evaluateGate(
      config({
        rules: [
          { rule: "max_failed_matching", tag: "severity:critical", count: 0 },
          { rule: "max_failed_matching", tag: "suite:smoke", count: 2 },
        ],
        enforcement: "blocking",
      }),
      { ...GREEN, failed: 4, failedMatching: { "severity:critical": 1, "suite:smoke": 2 } },
    );
    expect(evaluation.outcome).toBe("failed");
    expect(evaluation.results).toHaveLength(2);
    expect(
      evaluation.results.find((r) => r.key === "max_failed_matching:severity:critical")?.outcome,
    ).toBe("failed");
    expect(
      evaluation.results.find((r) => r.key === "max_failed_matching:suite:smoke")?.outcome,
    ).toBe("passed");
  });

  it("treats an unmatched selector as zero, not as a missing measurement", () => {
    // A gate on `severity:critical` should pass a run that tagged nothing critical. Skipping
    // would leave the most important rule silent on most runs.
    const evaluation = evaluateGate(
      config({ rules: [{ rule: "max_failed_matching", tag: "severity:critical", count: 0 }] }),
      { ...GREEN, failed: 3 },
    );
    expect(evaluation.outcome).toBe("passed");
  });

  it("honours a rule switched off by a more specific layer", () => {
    const evaluation = evaluateGate(
      config({ rules: [{ rule: "max_failed", count: 0, enabled: false }] }),
      { ...GREEN, failed: 12 },
    );
    expect(evaluation.outcome).toBe("not-evaluated");
    expect(evaluation.results).toHaveLength(0);
  });

  it("reports every rule, not just the one that failed", () => {
    // A CI log saying only "gate failed" sends someone to the UI to find out why. Each rule
    // renders its own line with the actual and the limit.
    const evaluation = evaluateGate(
      config({
        rules: [
          { rule: "min_pass_rate", percent: 98 },
          { rule: "max_flaky", count: 1 },
        ],
        enforcement: "blocking",
      }),
      { ...GREEN, passRate: 91.5, flaky: 4 },
    );
    expect(evaluation.results.map((r) => r.message)).toEqual([
      "pass rate 91.5% (minimum 98%)",
      "4 flaky (budget 1)",
    ]);
  });
});

describe("resolveGateConfig", () => {
  it("lets a branch tighten one number while inheriting the rest", () => {
    const { config: resolved, sources } = resolveGateConfig([
      {
        scope: "org",
        config: {
          enabled: true,
          rules: [
            { rule: "min_pass_rate", percent: 90 },
            { rule: "max_failed_matching", tag: "severity:critical", count: 0 },
          ],
        },
      },
      {
        scope: "branch",
        branch: "main",
        config: { rules: [{ rule: "min_pass_rate", percent: 99 }] },
      },
    ]);
    // The two org rules survive, and so do the product defaults a layer below them.
    expect(resolved.rules.map((r) => r.rule)).toEqual(
      expect.arrayContaining([
        "min_pass_rate",
        "max_failed_matching",
        "require_complete_run",
        "no_new_failures",
      ]),
    );
    expect(resolved.rules.find((r) => r.rule === "min_pass_rate")).toMatchObject({ percent: 99 });
    // Inherited, not restated — the whole reason layers compose rather than replace.
    expect(resolved.rules.find((r) => r.rule === "max_failed_matching")).toMatchObject({
      count: 0,
    });
    expect(sources.rules).toBe("branch");
    expect(sources.enabled).toBe("org");
  });

  it("does not let two tag rules collide when layers merge", () => {
    // Keying on the rule kind alone would drop one of these silently, which is the kind of bug
    // that only shows up as a gate quietly not enforcing something.
    const { config: resolved } = resolveGateConfig([
      {
        scope: "project",
        config: {
          enabled: true,
          rules: [
            { rule: "max_failed_matching", tag: "severity:critical", count: 0 },
            { rule: "max_failed_matching", tag: "suite:smoke", count: 3 },
          ],
        },
      },
    ]);
    const tagRules = resolved.rules.filter((r) => r.rule === "max_failed_matching");
    expect(tagRules).toHaveLength(2);
    expect(new Set(tagRules.map(gateRuleKey)).size).toBe(2);
  });

  it("applies layers most-specific-last regardless of the order given", () => {
    const { config: resolved } = resolveGateConfig([
      { scope: "branch", branch: "main", config: { enforcement: "blocking" } },
      { scope: "org", config: { enabled: true, enforcement: "advisory" } },
    ]);
    expect(resolved.enforcement).toBe("blocking");
  });

  it("does not let a layer override with defaults it never stated", () => {
    /*
     * Regression test for a silent disable. `gateConfigSchema.partial()` still applies each
     * field's default, so a branch row setting only `enforcement` parsed back claiming
     * `enabled: false` — and the resolver, correctly treating any defined field as intentional,
     * switched off a gate the organisation had enabled. Adding a branch override turned
     * enforcement off, with no error anywhere.
     */
    const branchLayer = gateConfigPatchSchema.parse({ enforcement: "blocking" });
    expect(Object.hasOwn(branchLayer, "enabled")).toBe(false);
    expect(Object.hasOwn(branchLayer, "rules")).toBe(false);

    const { config: resolved } = resolveGateConfig([
      {
        scope: "org",
        config: gateConfigPatchSchema.parse({
          enabled: true,
          rules: [{ rule: "require_complete_run" }],
        }),
      },
      { scope: "branch", branch: "main", config: branchLayer },
    ]);
    expect(resolved.enabled).toBe(true);
    expect(resolved.enforcement).toBe("blocking");
    expect(resolved.rules.map((r) => r.rule)).toEqual(
      expect.arrayContaining(["require_complete_run"]),
    );
  });

  it("gates a project nobody has configured", () => {
    /*
     * The default is a layer, not a suggestion the settings screen prefills. A project with no
     * policy row anywhere is still gated on the two rules that need no local knowledge — and in
     * advisory mode, so forming an opinion on every run from day one blocks nothing.
     */
    const { config: resolved } = resolveGateConfig([]);
    expect(resolved.enabled).toBe(true);
    expect(resolved.enforcement).toBe("advisory");
    expect(resolved.rules.map((rule) => rule.rule)).toEqual([
      "require_complete_run",
      "no_new_failures",
    ]);
    expect(evaluateGate(resolved, GREEN).outcome).toBe("passed");
  });

  it("lets a layer narrow the default rather than only widen it", () => {
    // Turning the gate off has to stay expressible, or "on by default" becomes "on always".
    const { config: off } = resolveGateConfig([{ scope: "project", config: { enabled: false } }]);
    expect(evaluateGate(off, GREEN).outcome).toBe("not-evaluated");

    // And a layer tightens the inherited rule without restating the other one.
    const { config: strict } = resolveGateConfig([
      { scope: "branch", branch: "main", config: { enforcement: "blocking" } },
    ]);
    expect(strict.enforcement).toBe("blocking");
    expect(strict.rules).toHaveLength(2);
    expect(evaluateGate(strict, { ...GREEN, status: "partial" }).outcome).toBe("failed");
  });
});
