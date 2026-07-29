import {
  accumulateTotals,
  computeFailureSignature,
  computeFingerprint,
  emptyTotals,
  isRetryFlaky,
  type CanonicalTestResult,
  type RunTotals,
} from "@testcenter/core";
import type { Database, Sql } from "./client.js";

/**
 * Ingest persistence.
 *
 * Two properties matter here and shape every query below:
 *
 *   Idempotency — CI retries uploads, and at-least-once queue delivery means a
 *   batch can legitimately be replayed. Every write is an upsert keyed on natural
 *   identity, so replaying a batch converges instead of duplicating.
 *
 *   Bounded memory — a batch is written with one multi-row statement rather than a
 *   row-at-a-time loop, and callers stream batches, so a 200k-test report never
 *   materializes in full.
 */

/** Postgres caps parameters per statement; stay well clear of the limit. */
const MAX_ROWS_PER_STATEMENT = 500;

export interface PersistBatchInput {
  orgId: string;
  projectId: string;
  runId: string;
  results: readonly CanonicalTestResult[];
  /** Fallback when a result carries no timestamp of its own. */
  runStartedAt: Date;
}

export interface PersistBatchOutput {
  written: number;
  totals: RunTotals;
}

interface ResolvedTestCase {
  id: number;
  fingerprintHex: string;
}

/**
 * Upserts test identities and returns their ids.
 *
 * `ON CONFLICT DO UPDATE` rather than `DO NOTHING` because concurrent shard ingest
 * for the same run races on the same fingerprints; the update also refreshes
 * `last_seen_at`, which the run list and staleness views read.
 */
export async function upsertTestCases(
  sql: Sql,
  input: {
    orgId: string;
    projectId: string;
    results: readonly CanonicalTestResult[];
    seenAt: Date;
  },
): Promise<Map<string, ResolvedTestCase>> {
  const byFingerprint = new Map<
    string,
    {
      digest: Buffer;
      suite: string | null;
      classname: string | null;
      name: string;
      /** Passed through sql.json so postgres.js encodes it exactly once. */
      parameters: Record<string, unknown> | null;
      status: string;
    }
  >();

  for (const result of input.results) {
    const fingerprint = computeFingerprint({
      projectId: input.projectId,
      suite: result.suite,
      classname: result.classname,
      name: result.name,
      parameters: result.parameters,
    });
    // Later occurrences of one identity in a batch overwrite earlier ones, which
    // matches "last attempt wins" for a retried test.
    byFingerprint.set(fingerprint.hex, {
      digest: fingerprint.digest,
      suite: result.suite ?? null,
      classname: result.classname ?? null,
      name: result.name,
      parameters: result.parameters ?? null,
      status: result.status,
    });
  }

  const resolved = new Map<string, ResolvedTestCase>();
  const entries = [...byFingerprint.entries()];

  for (let offset = 0; offset < entries.length; offset += MAX_ROWS_PER_STATEMENT) {
    const slice = entries.slice(offset, offset + MAX_ROWS_PER_STATEMENT);
    const rows = slice.map(([, value]) => ({
      org_id: input.orgId,
      project_id: input.projectId,
      fingerprint: value.digest,
      fingerprint_version: 1,
      suite: value.suite,
      classname: value.classname,
      name: value.name,
      parameters:
        value.parameters === null ? null : sql.json(value.parameters as Record<string, never>),
      first_seen_at: input.seenAt,
      last_seen_at: input.seenAt,
      last_status: value.status,
    }));

    // int8 arrives as a string from postgres.js (it will not silently narrow to a
    // JS number). Coerced here so callers get the type this function advertises.
    const inserted = await sql<{ id: string | number; fingerprint: Buffer }[]>`
      INSERT INTO test_cases ${sql(
        rows,
        "org_id",
        "project_id",
        "fingerprint",
        "fingerprint_version",
        "suite",
        "classname",
        "name",
        "parameters",
        "first_seen_at",
        "last_seen_at",
        "last_status",
      )}
      ON CONFLICT (project_id, fingerprint, fingerprint_version) DO UPDATE SET
        last_seen_at = GREATEST(test_cases.last_seen_at, EXCLUDED.last_seen_at),
        last_status  = EXCLUDED.last_status,
        -- Display fields are refreshed so a renamed-but-same-identity test shows
        -- its current text rather than whatever it was first called.
        suite        = COALESCE(EXCLUDED.suite, test_cases.suite),
        classname    = COALESCE(EXCLUDED.classname, test_cases.classname),
        name         = EXCLUDED.name
      RETURNING id, fingerprint
    `;

    for (const row of inserted) {
      const hex = Buffer.from(row.fingerprint).toString("hex");
      resolved.set(hex, { id: Number(row.id), fingerprintHex: hex });
    }
  }

  return resolved;
}

/**
 * Writes one batch of results.
 *
 * Deliberately not wrapped in a transaction spanning the whole run: a 200k-test
 * report would hold a single long transaction open, blocking vacuum and risking a
 * total loss on any error. Per-batch atomicity plus idempotent upserts gives
 * crash-safety without the long-transaction cost — a replay re-converges.
 */
export async function persistResultBatch(
  sql: Sql,
  input: PersistBatchInput,
): Promise<PersistBatchOutput> {
  if (input.results.length === 0) {
    return { written: 0, totals: emptyTotals() };
  }

  const seenAt = input.runStartedAt;
  const testCases = await upsertTestCases(sql, {
    orgId: input.orgId,
    projectId: input.projectId,
    results: input.results,
    seenAt,
  });

  const rows = input.results.map((result) => {
    const fingerprint = computeFingerprint({
      projectId: input.projectId,
      suite: result.suite,
      classname: result.classname,
      name: result.name,
      parameters: result.parameters,
    });
    const testCase = testCases.get(fingerprint.hex);
    if (!testCase) {
      throw new Error(`test case was not resolved for fingerprint ${fingerprint.hex.slice(0, 12)}`);
    }

    // Computed at ingest even though the clustering UI is Phase 3, so that feature
    // opens against real history rather than an empty table.
    const signature = result.failure
      ? computeFailureSignature(input.projectId, {
          type: result.failure.type,
          message: result.failure.message,
          stackTrace: result.failure.stackTrace,
        })
      : null;

    return {
      org_id: input.orgId,
      project_id: input.projectId,
      run_id: input.runId,
      test_case_id: testCase.id,
      status: result.status,
      duration_ms: result.durationMs ?? null,
      retry_count: Math.max(0, (result.retries?.length ?? 1) - 1),
      was_flaky: isRetryFlaky(result),
      failure_type: result.failure?.type ?? null,
      failure_message: result.failure?.message ?? null,
      failure_signature: signature?.digest ?? null,
      stack_trace: result.failure?.stackTrace ?? null,
      stdout: result.stdout ?? null,
      stderr: result.stderr ?? null,
      message: result.message ?? null,
      tags: sql.json((result.tags ?? {}) as Record<string, never>),
      started_at: result.startedAt ?? seenAt,
    };
  });

  let written = 0;
  for (let offset = 0; offset < rows.length; offset += MAX_ROWS_PER_STATEMENT) {
    const slice = rows.slice(offset, offset + MAX_ROWS_PER_STATEMENT);
    await sql`
      INSERT INTO test_results ${sql(
        slice,
        "org_id",
        "project_id",
        "run_id",
        "test_case_id",
        "status",
        "duration_ms",
        "retry_count",
        "was_flaky",
        "failure_type",
        "failure_message",
        "failure_signature",
        "stack_trace",
        "stdout",
        "stderr",
        "message",
        "tags",
        "started_at",
      )}
    `;
    written += slice.length;
  }

  return { written, totals: accumulateTotals(emptyTotals(), input.results) };
}

/**
 * Adds a batch's counters to the run.
 *
 * Incremental rather than recomputed: recounting from test_results after every
 * batch would make ingest cost grow quadratically with report size. `pass_rate` is
 * derived from the accumulated columns so it stays consistent with them, and
 * skipped tests stay out of the denominator.
 */
export async function addRunTotals(sql: Sql, runId: string, totals: RunTotals): Promise<void> {
  await sql`
    UPDATE runs SET
      total   = total   + ${totals.total},
      passed  = passed  + ${totals.passed},
      failed  = failed  + ${totals.failed},
      skipped = skipped + ${totals.skipped},
      errored = errored + ${totals.errored},
      blocked = blocked + ${totals.blocked},
      flaky   = flaky   + ${totals.flaky},
      pass_rate = CASE
        WHEN (passed + ${totals.passed}) + (failed + ${totals.failed}) + (errored + ${totals.errored}) = 0
          THEN 0
        ELSE ROUND(
          (passed + ${totals.passed})::numeric * 100 /
          ((passed + ${totals.passed}) + (failed + ${totals.failed}) + (errored + ${totals.errored})),
          2)
      END
    WHERE id = ${runId}
  `;
}

/** Resets counters so a re-parse of the same run does not double-count. */
export async function resetRunTotals(sql: Sql, runId: string): Promise<void> {
  await sql`
    UPDATE runs SET
      total = 0, passed = 0, failed = 0, skipped = 0,
      errored = 0, blocked = 0, flaky = 0, pass_rate = 0
    WHERE id = ${runId}
  `;
}

/** Removes previously parsed results for a run. Used before a re-parse. */
export async function deleteRunResults(sql: Sql, runId: string): Promise<number> {
  const deleted = await sql`DELETE FROM test_results WHERE run_id = ${runId}`;
  return deleted.count ?? 0;
}

/**
 * Rolls a completed run into the per-day, per-branch aggregate the dashboards read.
 *
 * Recomputed from `runs` rather than accumulated, because a run can be re-parsed
 * and because this table is small enough that correctness beats cleverness. The
 * dashboards then read one row per day instead of aggregating millions of results.
 */
export async function rollupProjectDay(
  sql: Sql,
  input: { orgId: string; projectId: string; day: Date; branch: string | null },
): Promise<void> {
  const day = input.day.toISOString().slice(0, 10);
  const branch = input.branch ?? "";

  await sql`
    INSERT INTO project_daily_stats (
      org_id, project_id, day, branch,
      runs, tests, passed, failed, skipped, flaky,
      pass_rate, avg_duration_ms, total_duration_ms, updated_at
    )
    SELECT
      ${input.orgId}::uuid,
      ${input.projectId}::uuid,
      ${day}::date,
      ${branch},
      count(*),
      COALESCE(sum(total), 0),
      COALESCE(sum(passed), 0),
      COALESCE(sum(failed), 0),
      COALESCE(sum(skipped), 0),
      COALESCE(sum(flaky), 0),
      CASE
        WHEN COALESCE(sum(passed + failed + errored), 0) = 0 THEN 0
        ELSE ROUND(sum(passed)::numeric * 100 / sum(passed + failed + errored), 2)
      END,
      AVG(duration_ms)::int,
      COALESCE(sum(duration_ms), 0),
      now()
    FROM runs
    WHERE project_id = ${input.projectId}
      AND COALESCE(branch, '') = ${branch}
      AND started_at >= ${day}::date
      AND started_at < (${day}::date + INTERVAL '1 day')
      AND status IN ('complete', 'partial')
    ON CONFLICT (project_id, day, branch) DO UPDATE SET
      runs = EXCLUDED.runs,
      tests = EXCLUDED.tests,
      passed = EXCLUDED.passed,
      failed = EXCLUDED.failed,
      skipped = EXCLUDED.skipped,
      flaky = EXCLUDED.flaky,
      pass_rate = EXCLUDED.pass_rate,
      avg_duration_ms = EXCLUDED.avg_duration_ms,
      total_duration_ms = EXCLUDED.total_duration_ms,
      updated_at = now()
  `;
}

/**
 * Refreshes the per-test rollups that power history and flake views.
 *
 * Scoped to the tests touched by this run rather than the whole project, so cost
 * is proportional to the run rather than to accumulated history.
 *
 * The flake score combines two independent signals:
 *   - retry flakiness: the test failed then passed inside one run (highest
 *     confidence — no history needed)
 *   - status instability: the test changed outcome between consecutive runs
 * A test that is simply broken fails consistently and scores 0, which is what
 * keeps the flake list actionable instead of just listing every failing test.
 */
export async function refreshTestCaseStats(
  sql: Sql,
  input: { projectId: string; runId: string; windowDays?: number },
): Promise<number> {
  const windowDays = input.windowDays ?? 30;

  const updated = await sql`
    WITH touched AS (
      SELECT DISTINCT test_case_id FROM test_results WHERE run_id = ${input.runId}
    ),
    history AS (
      SELECT
        r.test_case_id,
        r.status,
        r.was_flaky,
        r.duration_ms,
        r.started_at,
        LAG(r.status) OVER (PARTITION BY r.test_case_id ORDER BY r.started_at) AS prev_status
      FROM test_results r
      JOIN touched t ON t.test_case_id = r.test_case_id
      WHERE r.project_id = ${input.projectId}
        AND r.started_at >= now() - (${windowDays} || ' days')::interval
    ),
    stats AS (
      SELECT
        test_case_id,
        count(*) AS runs_window,
        count(*) FILTER (WHERE status IN ('failed', 'error')) AS failures_window,
        count(*) FILTER (WHERE was_flaky) AS retry_flakes,
        -- Outcome changed between consecutive runs, ignoring skips.
        count(*) FILTER (
          WHERE prev_status IS NOT NULL
            AND status <> prev_status
            AND status <> 'skipped'
            AND prev_status <> 'skipped'
        ) AS status_flips,
        AVG(duration_ms)::int AS avg_duration,
        PERCENTILE_DISC(0.95) WITHIN GROUP (ORDER BY duration_ms)::int AS p95_duration
      FROM history
      GROUP BY test_case_id
    )
    UPDATE test_cases tc SET
      runs_30d = s.runs_window,
      failures_30d = s.failures_window,
      fail_rate_30d = CASE
        WHEN s.runs_window = 0 THEN 0
        ELSE ROUND(s.failures_window::numeric * 100 / s.runs_window, 2)
      END,
      flake_score = LEAST(100, CASE
        WHEN s.runs_window < 2 THEN
          -- With one data point only an in-run retry flake is defensible.
          CASE WHEN s.retry_flakes > 0 THEN 100 ELSE 0 END
        ELSE ROUND(
          (s.retry_flakes::numeric * 100 / s.runs_window) * 0.6 +
          (s.status_flips::numeric * 100 / (s.runs_window - 1)) * 0.4,
          2)
      END),
      avg_duration_ms = s.avg_duration,
      p95_duration_ms = s.p95_duration
    FROM stats s
    WHERE tc.id = s.test_case_id
  `;

  return updated.count ?? 0;
}

/** Marks a run finished and stamps its wall-clock duration. */
export async function finalizeRun(
  sql: Sql,
  input: {
    runId: string;
    status: "complete" | "partial" | "failed";
    finishedAt?: Date;
    /** Report-declared duration; falls back to wall-clock from started_at. */
    durationMs?: number | undefined;
    framework?: string | undefined;
    warnings?: readonly { code: string; message: string }[];
  },
): Promise<void> {
  const finishedAt = input.finishedAt ?? new Date();
  await sql`
    UPDATE runs SET
      status = ${input.status},
      finished_at = ${finishedAt},
      duration_ms = COALESCE(
        ${input.durationMs ?? null}::int,
        GREATEST(0, (EXTRACT(EPOCH FROM (${finishedAt} - started_at)) * 1000)::int)
      ),
      framework = COALESCE(framework, ${input.framework ?? null}),
      warnings = ${sql.json([...(input.warnings ?? [])])}
    WHERE id = ${input.runId}
  `;
}

/**
 * Fails runs that have been parsing for too long.
 *
 * A worker killed mid-ingest (deploy, OOM, evicted pod) leaves its run in "parsing"
 * with no job to finish it. The UI then shows a spinner forever, which is the worst
 * available outcome: it looks like the product is broken rather than telling anyone
 * what happened. This marks such runs failed with an explanation so they are
 * actionable, and it is safe to run repeatedly.
 *
 * The threshold must exceed the longest legitimate parse; a 500 MB report on a busy
 * worker can take minutes.
 */
export async function failStalledRuns(
  sql: Sql,
  options: { olderThanMinutes?: number } = {},
): Promise<{ runId: string }[]> {
  const olderThanMinutes = options.olderThanMinutes ?? 30;

  return sql<{ runId: string }[]>`
    WITH stalled AS (
      SELECT r.id
      FROM runs r
      WHERE r.status IN ('pending', 'parsing')
        AND r.updated_at < now() - (${olderThanMinutes} || ' minutes')::interval
        -- Leave runs alone while a job is still actively working on them.
        AND NOT EXISTS (
          SELECT 1 FROM ingest_jobs j
          WHERE j.run_id = r.id
            AND j.state = 'running'
            AND j.updated_at >= now() - (${olderThanMinutes} || ' minutes')::interval
        )
    )
    UPDATE runs SET
      status = 'failed',
      finished_at = COALESCE(finished_at, now()),
      warnings = warnings || jsonb_build_array(jsonb_build_object(
        'code', 'ingest_stalled',
        'message', 'ingest did not complete within ' || ${olderThanMinutes} ||
                   ' minutes; the worker likely stopped before finishing'
      ))
    WHERE id IN (SELECT id FROM stalled)
    RETURNING id AS "runId"
  `;
}

export interface DatabaseWithSql {
  db: Database;
  sql: Sql;
}
