import {
  resolveGateConfig,
  type GateConfigLayer,
  type GateConfigPatch,
  type GateRule,
  type GateScope,
} from "@testcenter/core";
import { describeGate, GATE_RULE_LABELS as RULE_LABELS } from "@/components/gate-badge";
import { Card } from "@/components/ui";

/**
 * The quality gate policy for one layer, and what it resolves to.
 *
 * A form that edits *this* layer while showing the whole resolved policy beside it. Those are
 * different things and conflating them is how layered configuration rots: if saving copied the
 * inherited values down into this layer, every project would end up with a frozen snapshot of
 * whatever the organisation's policy happened to be on the day someone opened the page, and
 * changing the org default would then quietly stop reaching them.
 *
 * So every control has an explicit "inherit" state, and blank means inherit rather than zero.
 * The panel above the form says what is actually in force and where each part came from, because
 * "why is this run being gated on 98%" is the question this screen exists to answer.
 *
 * A server component with a server action: there is no client state here worth the bundle — the
 * form is submitted, the page re-renders, and the resolved panel recomputes from the database
 * rather than from anything the browser was holding.
 */

/*
 * Phrased as questions rather than as setting names. "Minimum pass rate" is what the field is
 * called; "What is the lowest acceptable pass rate?" is what the person filling it in is deciding,
 * which removes the need to already understand the gate before configuring it.
 */
const NUMERIC_RULES = [
  {
    kind: "min_pass_rate" as const,
    unit: "%",
    question: "What is the lowest acceptable pass rate?",
    hint: "Leave empty unless your suite is stable enough for a percentage to mean something.",
  },
  {
    kind: "max_failed" as const,
    unit: "",
    question: "How many failing tests are allowed?",
    hint: "A flat cap, whether or not the failures are new.",
  },
  {
    kind: "max_flaky" as const,
    unit: "",
    question: "How many flaky tests are allowed?",
    hint: "Tests that failed and then passed on a retry.",
  },
];

function ruleValue(rules: GateRule[] | undefined, kind: string): number | null {
  const rule = rules?.find((candidate) => candidate.rule === kind);
  if (!rule) return null;
  if ("percent" in rule) return rule.percent;
  if ("count" in rule) return rule.count;
  return null;
}

/** Where a setting came from, in words a reader has not had to learn. */
function sourceWord(scope: GateScope | undefined): string {
  // Undefined means nobody set it, so it came from the product default rather than from a policy
  // anybody wrote. Saying so is honest; naming a level that does not exist would not be.
  if (scope === "org") return "set for the organisation";
  if (scope === "project") return "set for this project";
  if (scope === "branch") return "set for this branch";
  return "Test Center default";
}

export function QualityGateSettings({
  layer,
  scope,
  branch,
  layers,
  action,
  canEdit,
  description,
  readOnlyNote = "Read-only \u2014 changing gate policy requires the admin role.",
  wide = false,
  showHeading = true,
}: {
  /** What this level currently sets. Blank fields defer to the level above. */
  layer: GateConfigPatch;
  scope: GateScope;
  branch?: string | null;
  /** Everything that applies here, so the summary matches what ingest will compute. */
  layers: GateConfigLayer[];
  action: (formData: FormData) => Promise<void>;
  canEdit: boolean;
  description: string;
  /** Says who *can* change it, when the viewer cannot. Differs by scope, so it is passed in. */
  readOnlyNote?: string;
  /**
   * Lay the summary beside the controls instead of above them.
   *
   * Only the organisation page has the width for it. Stretching a single column to 80% of a wide
   * screen makes every label-to-input span the full width and turns a short form into a hard one
   * to read; two columns spend the space on putting the policy next to the thing that changes it.
   */
  wide?: boolean;
  /**
   * Draw the card's own title and description.
   *
   * Off where the page is already called "Quality gate" and says the same sentence underneath —
   * a heading repeated ten pixels below itself reads as a rendering fault, and the second copy
   * pushes the first control further down for no information.
   */
  showHeading?: boolean;
}) {
  const { config: resolved, sources } = resolveGateConfig(layers);
  /*
   * At the organisation level there is nothing above to inherit from — only the product default —
   * so offering "Inherit" is an option that appears to defer to a policy that does not exist. The
   * owner is deciding, so the control says what it does: on or off.
   */
  const isGlobal = scope === "org";

  return (
    <Card className="mb-5 p-5">
      {showHeading ? (
        <>
          <h2 className="text-sm font-medium">Quality gate</h2>
          <p className="mt-1 mb-3 text-xs leading-relaxed text-[var(--color-ink-muted)]">
            {description}
          </p>
        </>
      ) : null}

      <form action={action} className="space-y-4">
        <input type="hidden" name="scope" value={scope} />
        {branch ? <input type="hidden" name="branch" value={branch} /> : null}

        <div className="grid max-w-3xl gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium">Check runs?</span>
            <select
              name="enabled"
              defaultValue={
                layer.enabled === undefined
                  ? isGlobal
                    ? resolved.enabled
                      ? "on"
                      : "off"
                    : ""
                  : layer.enabled
                    ? "on"
                    : "off"
              }
              disabled={!canEdit}
              className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1.5 text-xs"
            >
              {isGlobal ? null : (
                <option value="">Same as organisation ({resolved.enabled ? "yes" : "no"})</option>
              )}
              <option value="on">Yes — check every run</option>
              <option value="off">No — stop checking runs</option>
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium">When a check fails</span>
            <select
              name="enforcement"
              defaultValue={layer.enforcement ?? ""}
              disabled={!canEdit}
              className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1.5 text-xs"
            >
              {isGlobal ? null : (
                <option value="">
                  Same as organisation (
                  {resolved.enforcement === "blocking" ? "stop the build" : "just report it"})
                </option>
              )}
              {/* Named by consequence, not by mode. "Advisory" is a word this product made up;
                  "just report it" is what a reader is actually choosing between. */}
              <option value="advisory">Just report it</option>
              <option value="blocking">Stop the build</option>
            </select>
          </label>
        </div>

        {/*
         * Section 2: what those two switches currently add up to.
         *
         * Between the switches and the individual checks on purpose — it answers the question
         * the switches raise ("so what happens to my runs now?") before the reader is asked to
         * tune anything, and it is what somebody arriving from a blocked build came to read.
         */}
        <div
          className={`rounded-lg border p-3.5 ${
            resolved.enabled
              ? "border-[var(--color-border-subtle)] bg-[var(--color-surface)]"
              : "border-[var(--color-status-flaky)]/40 bg-[var(--color-status-flaky)]/10"
          }`}
        >
          <p className="mb-2 text-[10px] font-medium tracking-widest text-[var(--color-ink-muted)] uppercase">
            In force now
          </p>
          <p className="text-[12px] leading-relaxed">
            {resolved.enabled ? (
              describeGate(resolved)
            ) : (
              <>
                <span className="font-medium text-[var(--color-status-flaky)]">
                  The quality gate is off.
                </span>{" "}
                No run is being checked, and the rules below are not applied.
                {isGlobal ? " A project can still turn it on for itself." : null}
              </>
            )}
          </p>

          {/*
           * One grid of label-over-value cells rather than two lists of `justify-between` rows.
           *
           * Full width, a row with the label at the far left and the value at the far right is a
           * pair the eye has to travel between; stacked cells keep each fact together and let four
           * of them share a line. Gaps rather than `divide-*`, because divide borders children by
           * DOM order and draws stray lines the moment a grid wraps.
           */}
          <dl
            className={`mt-3 grid gap-x-8 gap-y-2.5 border-t border-[var(--color-border-subtle)] pt-2.5 text-[11px] sm:grid-cols-2 ${
              wide ? "lg:grid-cols-4" : ""
            }`}
          >
            <div>
              <dt className="text-[10px] text-[var(--color-ink-muted)]">Checking</dt>
              <dd className="font-medium">
                {resolved.enabled ? "on" : "off"}
                <span className="ml-1.5 text-[10px] font-normal text-[var(--color-ink-muted)]">
                  {sourceWord(sources.enabled)}
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-[10px] text-[var(--color-ink-muted)]">A failure</dt>
              <dd className="font-medium">
                {resolved.enforcement === "blocking" ? "stops the build" : "is only reported"}
                <span className="ml-1.5 text-[10px] font-normal text-[var(--color-ink-muted)]">
                  {sourceWord(sources.enforcement)}
                </span>
              </dd>
            </div>
            {resolved.enabled
              ? resolved.rules
                  .filter((rule) => rule.enabled !== false)
                  .map((rule) => (
                    <div key={rule.rule + ("tag" in rule ? rule.tag : "")}>
                      <dt className="truncate text-[10px] text-[var(--color-ink-muted)]">
                        {RULE_LABELS[rule.rule]}
                      </dt>
                      <dd className="font-mono tabular-nums">
                        {"percent" in rule
                          ? `${rule.percent}% or better`
                          : "count" in rule
                            ? `${rule.count} or fewer`
                            : "required"}
                      </dd>
                    </div>
                  ))
              : null}
          </dl>
        </div>

        <fieldset className="rounded-lg border border-[var(--color-border-subtle)] p-3">
          <legend className="px-1 text-[11px] font-medium">Checks</legend>
          <p className="mb-3 text-[11px] leading-relaxed text-[var(--color-ink-muted)]">
            Empty keeps what you already have. A value changes only that check.
          </p>

          {/*
           * Capped, even though the card is wide. Stacking the sections made every row the full
           * width of the page, leaving roughly 1500px between a question and the box that answers
           * it — a distance the eye crosses on every row to check what it typed against what it
           * was asked. The fieldset border still spans the card; only the reading line is bounded.
           */}
          <div className="max-w-3xl space-y-3">
            {/* Kept a single column even when the card is wide. These rows are a question, a
                hint and a number; side by side the eye has to re-find the input column on every
                row, and the hints are the part people actually need to read. */}
            {NUMERIC_RULES.map((rule) => {
              const inherited = ruleValue(resolved.rules, rule.kind);
              return (
                <label key={rule.kind} className="flex items-center gap-3">
                  <span className="min-w-0 flex-1 text-[12px]">
                    {rule.question}
                    <span className="block text-[10px] text-[var(--color-ink-muted)]">
                      {rule.hint}
                    </span>
                  </span>
                  <input
                    type="number"
                    name={rule.kind}
                    min={0}
                    max={rule.kind === "min_pass_rate" ? 100 : undefined}
                    step={rule.kind === "min_pass_rate" ? "0.1" : "1"}
                    defaultValue={ruleValue(layer.rules, rule.kind) ?? ""}
                    /* The inherited number, shown where a value would go — far more use than the
                       word "inherit", which tells you a mechanism instead of an amount. */
                    placeholder={inherited === null ? "not set" : String(inherited)}
                    disabled={!canEdit}
                    className="w-24 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1 text-right font-mono text-xs tabular-nums"
                  />
                  <span className="w-4 text-[11px] text-[var(--color-ink-muted)]">{rule.unit}</span>
                </label>
              );
            })}

            <label className="flex items-center gap-3 border-t border-[var(--color-border-subtle)] pt-3">
              <span className="min-w-0 flex-1 text-[12px]">
                How many newly broken tests are allowed?
                <span className="block text-[10px] text-[var(--color-ink-muted)]">
                  A test that passed the last time it ran and is failing now. Usually zero — this is
                  the check that catches a regression.
                </span>
              </span>
              <input
                type="number"
                name="no_new_failures"
                min={0}
                step="1"
                defaultValue={ruleValue(layer.rules, "no_new_failures") ?? ""}
                placeholder={String(ruleValue(resolved.rules, "no_new_failures") ?? "not set")}
                disabled={!canEdit}
                className="w-24 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1 text-right font-mono text-xs tabular-nums"
              />
              <span className="w-4" />
            </label>

            <label className="flex items-center gap-3">
              <span className="min-w-0 flex-1 text-[12px]">
                Must the run have finished?
                <span className="block text-[10px] text-[var(--color-ink-muted)]">
                  A run that crashes halfway reports fewer failures, so every other check passes.
                </span>
              </span>
              <select
                name="require_complete_run"
                defaultValue={
                  layer.rules?.some((rule) => rule.rule === "require_complete_run")
                    ? layer.rules.find((rule) => rule.rule === "require_complete_run")?.enabled ===
                      false
                      ? "off"
                      : "on"
                    : ""
                }
                disabled={!canEdit}
                className="w-28 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1 text-xs"
              >
                <option value="">Keep as is</option>
                <option value="on">Yes</option>
                <option value="off">No</option>
              </select>
              <span className="w-4" />
            </label>
          </div>
        </fieldset>

        {canEdit ? (
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              className="rounded-md bg-[var(--color-ink)] px-3 py-1.5 text-xs font-medium text-[var(--color-surface)] hover:opacity-90"
            >
              Save
            </button>
            <button
              type="submit"
              name="reset"
              value="1"
              className="text-xs text-[var(--color-ink-muted)] underline hover:text-[var(--color-ink)]"
            >
              {isGlobal ? "Reset to the built-in checks" : "Use the organisation settings"}
            </button>
            <span className="text-[11px] text-[var(--color-ink-muted)]">
              Applies to new uploads and re-checks the runs already here.
            </span>
          </div>
        ) : (
          <p className="text-[11px] text-[var(--color-ink-muted)]">{readOnlyNote}</p>
        )}
      </form>
    </Card>
  );
}

/**
 * Turn a submitted form into a patch containing only what this layer means to set.
 *
 * Blank inputs are dropped rather than coerced. `Number("")` is 0, so a blank "maximum failures"
 * treated as a number would silently install the strictest possible rule — a gate nobody asked
 * for, failing every run with a single failure.
 */
export function gatePatchFromForm(formData: FormData): GateConfigPatch {
  const patch: GateConfigPatch = {};

  const enabled = String(formData.get("enabled") ?? "");
  if (enabled === "on") patch.enabled = true;
  else if (enabled === "off") patch.enabled = false;

  const enforcement = String(formData.get("enforcement") ?? "");
  if (enforcement === "advisory" || enforcement === "blocking") patch.enforcement = enforcement;

  const rules: GateRule[] = [];
  const numeric = (name: string): number | null => {
    const raw = String(formData.get(name) ?? "").trim();
    if (raw === "") return null;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : null;
  };

  const passRate = numeric("min_pass_rate");
  if (passRate !== null) rules.push({ rule: "min_pass_rate", percent: Math.min(passRate, 100) });
  const maxFailed = numeric("max_failed");
  if (maxFailed !== null) rules.push({ rule: "max_failed", count: Math.round(maxFailed) });
  const maxFlaky = numeric("max_flaky");
  if (maxFlaky !== null) rules.push({ rule: "max_flaky", count: Math.round(maxFlaky) });
  const noNew = numeric("no_new_failures");
  if (noNew !== null) rules.push({ rule: "no_new_failures", count: Math.round(noNew) });

  const complete = String(formData.get("require_complete_run") ?? "");
  if (complete === "on") rules.push({ rule: "require_complete_run" });
  else if (complete === "off") rules.push({ rule: "require_complete_run", enabled: false });

  if (rules.length > 0) patch.rules = rules;
  return patch;
}
