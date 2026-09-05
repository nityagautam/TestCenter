import {
  evaluateGate,
  gateConfigPatchSchema,
  resolveGateConfig,
  type GateConfig,
  type GateConfigLayer,
  type GateConfigPatch,
  type GateEvaluation,
  type GateFacts,
  type GateRuleResult,
} from "@testcenter/core";
import type { Sql } from "./client.js";

/**
 * Assembling the facts a quality gate judges.
 *
 * The judgement itself is `evaluateGate` in `packages/core`, which is a pure function. This is
 * the half that needs the database, and the split is deliberate: the rules can then be tested
 * without a run to point them at, and the same evaluator can be replayed over history to ask
 * what a proposed gate *would* have said before anybody switches it on.
 *
 * Counts are computed here rather than read from the `runs` counters, for one reason: the
 * modifiers. `runs.failed` cannot know that a quarantined test should not count, and once one
 * rule respects the modifiers and another reads the cached counter, `max_failed` and
 * `max_failed_matching` start disagreeing about the same run. One definition, applied once.
 */

/**
 * How many of a test's own previous results decide whether it "used to pass".
 *
 * Five rather than one: a single prior result makes the answer hostage to whichever run happened
 * to be last, so one flaky green would relabel a long-standing failure as a fresh regression.
 */
const TEST_HISTORY_LOOKBACK = 5;

export interface GateFactsResult {
  facts: GateFacts;
  /** Context for explaining the verdict, not for judging it. */
  context: {
    branch: string | null;
    /** Prior runs on this branch. Zero means there is no baseline and the rule must skip. */
    priorRuns: number;
    /** Failing tests that have never run before — new coverage, not regressions. */
    firstSeen: number;
    quarantinedExcluded: number;
  };
}

/**
 * Everything the rules need, for one run.
 *
 * `tagSelectors` are the `key:value` strings from `max_failed_matching` rules. They are passed
 * in rather than discovered, because a selector nobody gated on is a count nobody asked for.
 */
export async function gateFactsForRun(
  sql: Sql,
  input: {
    orgId: string;
    runId: string;
    tagSelectors: string[];
    ignoreQuarantined: boolean;
  },
): Promise<GateFactsResult | null> {
  const [run] = await sql<
    {
      projectId: string;
      status: string;
      branch: string | null;
      startedAt: Date;
      passRate: string;
      flaky: number;
    }[]
  >`
    SELECT project_id AS "projectId", status, branch, started_at AS "startedAt",
           pass_rate AS "passRate", flaky
    FROM runs
    WHERE org_id = ${input.orgId} AND id = ${input.runId}
  `;
  if (!run) return null;

  /*
   * Failures counted as failed OR errored, matching every other query in the product: an errored
   * test did not pass, and a gate that ignored errors would wave through a suite that crashed on
   * import. `runs` keeps the two in separate columns, which is why this is recomputed rather
   * than read.
   */
  const [failures] = await sql<{ failed: number; quarantined: number }[]>`
    SELECT
      count(*) FILTER (WHERE NOT ${input.ignoreQuarantined} OR NOT tc.quarantined)::int AS failed,
      count(*) FILTER (WHERE tc.quarantined)::int                                       AS quarantined
    FROM test_results r
    JOIN test_cases tc ON tc.id = r.test_case_id
    WHERE r.org_id = ${input.orgId}
      AND r.run_id = ${input.runId}
      AND r.status IN ('failed', 'error')
  `;

  /*
   * One query for every selector rather than one per selector, and a LEFT JOIN so a selector
   * that matches nothing comes back as 0 instead of missing. That distinction matters: a gate on
   * `severity:critical` must pass a run that tagged nothing critical, and an absent key would
   * have to be guessed at by the evaluator.
   *
   * `sql.json` on the payload, not `JSON.stringify`. postgres.js JSON-encodes anything bound to
   * jsonb, so a pre-stringified value is stored as a JSON *string* and `tags @> …` silently
   * stops matching — no error, just a rule that never fires.
   */
  const selectorPayload = input.tagSelectors.map((selector) => {
    const separator = selector.indexOf(":");
    const key = separator === -1 ? selector : selector.slice(0, separator);
    const value = separator === -1 ? "" : selector.slice(separator + 1);
    return { selector, match: { [key]: value } };
  });

  const matched = input.tagSelectors.length
    ? await sql<{ selector: string; failures: number }[]>`
        WITH selectors AS (
          SELECT element->>'selector' AS selector, element->'match' AS match
          FROM jsonb_array_elements(${sql.json(selectorPayload)}::jsonb) AS element
        )
        SELECT s.selector, count(r.test_case_id)::int AS failures
        FROM selectors s
        LEFT JOIN test_results r
          ON r.org_id = ${input.orgId}
         AND r.run_id = ${input.runId}
         AND r.status IN ('failed', 'error')
         AND r.tags @> s.match
        LEFT JOIN test_cases tc ON tc.id = r.test_case_id
        WHERE r.test_case_id IS NULL
           OR NOT ${input.ignoreQuarantined}
           OR NOT tc.quarantined
        GROUP BY s.selector
      `
    : [];

  /*
   * "New" is measured against each *test's own* history, not against the previous runs.
   *
   * The run-to-run version was written first and was wrong on real data, in a way worth
   * recording. This project receives several unrelated suites — consecutive runs hold 126, 8,
   * 955, 51, 4 and 215 tests — so "the last 10 runs on this branch" compares a nightly
   * regression against a redirection smoke test. Measured on one real run: 288 tests failing,
   * only 24 of which appeared in the baseline runs at all, and all 24 were already failing. The
   * rule reported 264 new failures. The true number of regressions was zero.
   *
   * Asking each failing test what it did last time it ran removes the comparison between runs
   * entirely, which is the only thing that made the answer depend on which suites happened to
   * run recently. It is also the question `fingerprint.ts` exists to answer — "when did this
   * start failing" — so the history is already indexed for it.
   *
   * A test failing on its first ever appearance is counted separately and does NOT count as a
   * regression. It is new coverage that has not passed yet, which is a different conversation
   * from something that used to work; on the run above it is 264 of the 288. `firstSeen` is
   * returned so a future rule can gate it deliberately rather than by accident.
   */
  const [baseline] = await sql<
    {
      priorRuns: number;
      regressions: number | null;
      firstSeen: number | null;
    }[]
  >`
    WITH prior_runs AS (
      SELECT count(*)::int AS n
      FROM runs
      WHERE org_id = ${input.orgId}
        AND project_id = ${run.projectId}
        AND id <> ${input.runId}
        AND status IN ('complete', 'partial')
        AND branch IS NOT DISTINCT FROM ${run.branch}
        AND started_at < ${run.startedAt}
    ),
    current_failures AS (
      SELECT DISTINCT r.test_case_id
      FROM test_results r
      JOIN test_cases tc ON tc.id = r.test_case_id
      WHERE r.org_id = ${input.orgId}
        AND r.run_id = ${input.runId}
        AND r.status IN ('failed', 'error')
        AND (NOT ${input.ignoreQuarantined} OR NOT tc.quarantined)
    ),
    history AS (
      SELECT c.test_case_id, COALESCE(h.seen, 0) AS seen, COALESCE(h.failed_before, 0) AS failed_before
      FROM current_failures c
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS seen,
               count(*) FILTER (WHERE recent.status IN ('failed', 'error'))::int AS failed_before
        FROM (
          SELECT pr.status
          FROM test_results pr
          JOIN runs pru ON pru.id = pr.run_id
          WHERE pr.org_id = ${input.orgId}
            AND pr.test_case_id = c.test_case_id
            AND pru.project_id = ${run.projectId}
            AND pru.status IN ('complete', 'partial')
            AND pru.branch IS NOT DISTINCT FROM ${run.branch}
            AND pr.started_at < ${run.startedAt}
          ORDER BY pr.started_at DESC
          LIMIT ${TEST_HISTORY_LOOKBACK}
        ) recent
      ) h ON TRUE
    )
    SELECT
      (SELECT n FROM prior_runs) AS "priorRuns",
      CASE WHEN (SELECT n FROM prior_runs) = 0 THEN NULL
           ELSE (SELECT count(*)::int FROM history WHERE seen > 0 AND failed_before = 0) END
        AS regressions,
      CASE WHEN (SELECT n FROM prior_runs) = 0 THEN NULL
           ELSE (SELECT count(*)::int FROM history WHERE seen = 0) END
        AS "firstSeen"
  `;

  const failedMatching: Record<string, number> = {};
  for (const selector of input.tagSelectors) failedMatching[selector] = 0;
  for (const row of matched) failedMatching[row.selector] = row.failures;

  return {
    facts: {
      status: run.status,
      // numeric comes back as a string from postgres.js and will not silently narrow.
      passRate: Number(run.passRate),
      failed: failures?.failed ?? 0,
      flaky: run.flaky,
      failedMatching,
      newFailures: baseline?.regressions ?? null,
    },
    context: {
      branch: run.branch,
      priorRuns: baseline?.priorRuns ?? 0,
      firstSeen: baseline?.firstSeen ?? 0,
      quarantinedExcluded: input.ignoreQuarantined ? (failures?.quarantined ?? 0) : 0,
    },
  };
}

/* ── Policy ────────────────────────────────────────────────────────────────── */

/**
 * The org, project and branch rows that apply to one run, newest layer last.
 *
 * All three in one query. Fetching them separately would be three round trips on the hot path of
 * every ingest, and the branch row is usually absent, so most of that would be spent proving
 * nothing is there.
 */
export async function gateLayersFor(
  sql: Sql,
  input: { orgId: string; projectId: string; branch: string | null },
): Promise<GateConfigLayer[]> {
  const rows = await sql<{ projectId: string | null; branch: string | null; config: unknown }[]>`
    SELECT project_id AS "projectId", branch, config
    FROM quality_gates
    WHERE org_id = ${input.orgId}
      AND (
        (project_id IS NULL AND branch IS NULL)
        OR (project_id = ${input.projectId} AND branch IS NULL)
        OR (project_id = ${input.projectId} AND branch IS NOT DISTINCT FROM ${input.branch})
      )
  `;

  return rows.map((row) => ({
    scope: row.projectId === null ? "org" : row.branch === null ? "project" : "branch",
    branch: row.branch,
    /*
     * Parsed rather than cast. The column is jsonb written by an older build of this app, and a
     * rule shape that has since changed would otherwise reach the evaluator as a well-typed lie.
     * `partial()` because a layer is meant to be incomplete — that is what inheriting means.
     */
    config: gateConfigPatchSchema.parse(row.config ?? {}),
  }));
}

/** Upsert one layer. `config` is a partial: only what this layer means to override. */
export async function saveGateLayer(
  sql: Sql,
  input: {
    orgId: string;
    projectId?: string | null;
    branch?: string | null;
    config: GateConfigPatch;
    userId?: string | null;
  },
): Promise<void> {
  const projectId = input.projectId ?? null;
  const branch = projectId === null ? null : (input.branch ?? null);

  /*
   * `sql.json`, not a stringified value. postgres.js JSON-encodes anything bound to a jsonb
   * column, so pre-stringifying stores a JSON *string* — the config would round-trip as text and
   * every rule would silently vanish.
   *
   * ON CONFLICT names the partial unique indexes by their predicate, because there are three and
   * Postgres has to be told which one this insert is competing for.
   */
  const config = sql.json(input.config as never);
  if (projectId === null) {
    await sql`
      INSERT INTO quality_gates (org_id, project_id, branch, config, updated_by)
      VALUES (${input.orgId}, NULL, NULL, ${config}, ${input.userId ?? null})
      ON CONFLICT (org_id) WHERE project_id IS NULL AND branch IS NULL
      DO UPDATE SET config = EXCLUDED.config, updated_by = EXCLUDED.updated_by, updated_at = now()
    `;
  } else if (branch === null) {
    await sql`
      INSERT INTO quality_gates (org_id, project_id, branch, config, updated_by)
      VALUES (${input.orgId}, ${projectId}, NULL, ${config}, ${input.userId ?? null})
      ON CONFLICT (org_id, project_id) WHERE project_id IS NOT NULL AND branch IS NULL
      DO UPDATE SET config = EXCLUDED.config, updated_by = EXCLUDED.updated_by, updated_at = now()
    `;
  } else {
    await sql`
      INSERT INTO quality_gates (org_id, project_id, branch, config, updated_by)
      VALUES (${input.orgId}, ${projectId}, ${branch}, ${config}, ${input.userId ?? null})
      ON CONFLICT (org_id, project_id, branch) WHERE branch IS NOT NULL
      DO UPDATE SET config = EXCLUDED.config, updated_by = EXCLUDED.updated_by, updated_at = now()
    `;
  }
}

/**
 * The patch stored at exactly one layer, for the settings form to prefill from.
 *
 * Distinct from `gateLayersFor`, which returns everything that applies. A form has to edit what
 * *this* layer sets and show the rest as inherited — otherwise saving would silently copy the
 * inherited values down into this layer and freeze them, which is the failure mode that makes
 * layered config drift.
 */
export async function getGateLayer(
  sql: Sql,
  input: { orgId: string; projectId?: string | null; branch?: string | null },
): Promise<GateConfigPatch> {
  const projectId = input.projectId ?? null;
  const branch = projectId === null ? null : (input.branch ?? null);
  const [row] = await sql<{ config: unknown }[]>`
    SELECT config FROM quality_gates
    WHERE org_id = ${input.orgId}
      AND project_id IS NOT DISTINCT FROM ${projectId}
      AND branch IS NOT DISTINCT FROM ${branch}
  `;
  return gateConfigPatchSchema.parse(row?.config ?? {});
}

/** Branch overrides configured under one project, for listing them in settings. */
export async function listGateBranchLayers(
  sql: Sql,
  input: { orgId: string; projectId: string },
): Promise<{ branch: string; config: GateConfigPatch }[]> {
  const rows = await sql<{ branch: string; config: unknown }[]>`
    SELECT branch, config FROM quality_gates
    WHERE org_id = ${input.orgId} AND project_id = ${input.projectId} AND branch IS NOT NULL
    ORDER BY branch
  `;
  return rows.map((row) => ({
    branch: row.branch,
    config: gateConfigPatchSchema.parse(row.config ?? {}),
  }));
}

/** Remove a layer entirely, so it inherits again. Distinct from setting `enabled: false`. */
export async function deleteGateLayer(
  sql: Sql,
  input: { orgId: string; projectId?: string | null; branch?: string | null },
): Promise<void> {
  const projectId = input.projectId ?? null;
  const branch = projectId === null ? null : (input.branch ?? null);
  await sql`
    DELETE FROM quality_gates
    WHERE org_id = ${input.orgId}
      AND project_id IS NOT DISTINCT FROM ${projectId}
      AND branch IS NOT DISTINCT FROM ${branch}
  `;
}

/* ── Evaluation and recording ──────────────────────────────────────────────── */

export interface StoredGateResult extends GateEvaluation {
  runId: string;
  evaluatedAt: Date;
  facts: GateFacts;
  /**
   * The policy as it stood when this run was judged, not as it stands now.
   *
   * Read back from the row rather than re-resolved, which is the entire reason it was snapshotted:
   * describing an old verdict with today's thresholds would produce a sentence that contradicts
   * the numbers beside it the first time somebody edits the policy.
   */
  config: GateConfig;
}

/**
 * Resolve the policy, assemble the facts, judge the run, store the result.
 *
 * Called from the worker once a run's rollups are in place, because the rules read counters the
 * rollups maintain. It never throws into the ingest path: a gate is an opinion about a run, and
 * failing to form one must not stop the run being stored — the data is the product, the verdict
 * is a convenience on top of it.
 */
export async function evaluateAndRecordGate(
  sql: Sql,
  input: { orgId: string; projectId: string; runId: string; branch: string | null },
): Promise<StoredGateResult | null> {
  const layers = await gateLayersFor(sql, input);
  const { config } = resolveGateConfig(layers);

  const selectors = config.rules
    .filter((rule) => rule.rule === "max_failed_matching")
    .map((rule) => (rule as { tag: string }).tag);

  const assembled = await gateFactsForRun(sql, {
    orgId: input.orgId,
    runId: input.runId,
    tagSelectors: selectors,
    ignoreQuarantined: config.modifiers.ignoreQuarantined,
  });
  if (!assembled) return null;

  const evaluation = evaluateGate(config, assembled.facts);

  /*
   * A run with no gate stores nothing. Absence then means "no policy applied", which is what the
   * badge needs to know; a row saying `not-evaluated` on every run of every ungated project would
   * be a table growing at ingest rate to record that nothing happened.
   */
  if (evaluation.outcome === "not-evaluated") return null;

  await sql`
    INSERT INTO run_gate_results (
      org_id, project_id, run_id, outcome, breached, enforcement,
      gate_version, resolved_config, rule_results, facts
    ) VALUES (
      ${input.orgId}, ${input.projectId}, ${input.runId},
      ${evaluation.outcome}, ${evaluation.breached}, ${evaluation.enforcement},
      ${evaluation.version}, ${sql.json(config as never)},
      ${sql.json(evaluation.results as never)},
      ${sql.json({ ...assembled.facts, ...assembled.context } as never)}
    )
    ON CONFLICT (run_id) DO UPDATE SET
      outcome = EXCLUDED.outcome, breached = EXCLUDED.breached,
      enforcement = EXCLUDED.enforcement, gate_version = EXCLUDED.gate_version,
      resolved_config = EXCLUDED.resolved_config, rule_results = EXCLUDED.rule_results,
      facts = EXCLUDED.facts, evaluated_at = now()
  `;

  return {
    ...evaluation,
    runId: input.runId,
    evaluatedAt: new Date(),
    facts: assembled.facts,
    config,
  };
}

/** The stored verdict for one run, or null when no gate applied. */
export async function gateResultForRun(
  sql: Sql,
  input: { orgId: string; runId: string },
): Promise<StoredGateResult | null> {
  const [row] = await sql<
    {
      runId: string;
      outcome: GateEvaluation["outcome"];
      breached: boolean;
      enforcement: GateEvaluation["enforcement"];
      gateVersion: number;
      resolvedConfig: GateConfig;
      ruleResults: GateEvaluation["results"];
      facts: GateFacts;
      evaluatedAt: Date;
    }[]
  >`
    SELECT run_id AS "runId", outcome, breached, enforcement,
           gate_version AS "gateVersion", resolved_config AS "resolvedConfig",
           rule_results AS "ruleResults", facts, evaluated_at AS "evaluatedAt"
    FROM run_gate_results
    WHERE org_id = ${input.orgId} AND run_id = ${input.runId}
  `;
  if (!row) return null;
  return {
    runId: row.runId,
    outcome: row.outcome,
    breached: row.breached,
    enforcement: row.enforcement,
    version: row.gateVersion,
    results: row.ruleResults,
    facts: row.facts,
    evaluatedAt: row.evaluatedAt,
    config: row.resolvedConfig,
  };
}

/**
 * Gate outcomes for a page of runs, keyed by run id.
 *
 * Batched because the runs list renders up to a hundred rows and a per-row query is the classic
 * way a list view becomes slow without anyone noticing — the same reason `recentOutcomes` and
 * `latestFailureTriage` take arrays. Runs with no stored result are simply absent from the map,
 * which is what the badge needs to distinguish "no gate" from any real outcome.
 */
export async function gateResultsForRuns(
  sql: Sql,
  input: { orgId: string; runIds: string[] },
): Promise<
  Map<string, { outcome: GateEvaluation["outcome"]; breached: boolean; results: GateRuleResult[] }>
> {
  if (input.runIds.length === 0) return new Map();
  const rows = await sql<
    {
      runId: string;
      outcome: GateEvaluation["outcome"];
      breached: boolean;
      ruleResults: GateRuleResult[];
    }[]
  >`
    SELECT run_id AS "runId", outcome, breached, rule_results AS "ruleResults"
    FROM run_gate_results
    WHERE org_id = ${input.orgId} AND run_id = ANY(${input.runIds}::uuid[])
  `;
  return new Map(
    rows.map((row) => [
      row.runId,
      { outcome: row.outcome, breached: row.breached, results: row.ruleResults },
    ]),
  );
}

/**
 * Re-judge the runs a policy change affects.
 *
 * Without this, saving a policy changes nothing a reader can see. Verdicts are computed at ingest
 * and snapshotted, so every existing run keeps the rules that applied when it arrived — which is
 * right for an audit trail and wrong as the only behaviour, because the obvious reading of "save"
 * is that the rules now apply. Measured on a real database: a policy saved at 11:33 left 414 runs
 * still showing the two-rule default they were judged against an hour earlier.
 *
 * Scope narrows to what the edited layer can reach: an organisation policy touches every run in
 * it, a project policy only that project's, a branch policy only that branch's. Re-judging runs a
 * layer cannot affect would rewrite `evaluated_at` on rows whose verdict did not change.
 *
 * Synchronous, and that is a deliberate limit rather than an oversight. 414 runs take about two
 * seconds, so the person who pressed Save waits and then sees the result — worth far more than
 * the alternative of a background job whose completion they cannot observe. When an installation
 * is large enough for this to be slow, it becomes a worker job; the function is already shaped
 * for that, and `--force` on `backfill-gate` does the same work from the command line.
 */
export async function reevaluateGateForScope(
  sql: Sql,
  input: { orgId: string; projectId?: string | null; branch?: string | null },
): Promise<number> {
  const projectId = input.projectId ?? null;
  const branch = projectId === null ? null : (input.branch ?? null);

  const runs = await sql<{ id: string; projectId: string; branch: string | null }[]>`
    SELECT id, project_id AS "projectId", branch
    FROM runs
    WHERE org_id = ${input.orgId}
      AND status IN ('complete', 'partial')
      ${projectId === null ? sql`` : sql`AND project_id = ${projectId}`}
      ${branch === null ? sql`` : sql`AND branch = ${branch}`}
    ORDER BY started_at ASC
  `;

  let judged = 0;
  for (const run of runs) {
    const result = await evaluateAndRecordGate(sql, {
      orgId: input.orgId,
      projectId: run.projectId,
      runId: run.id,
      branch: run.branch,
    });
    if (result) judged += 1;
  }
  return judged;
}
