import type { Tags } from "@testcenter/core";
import type { Sql } from "./client.js";

/**
 * Read-path queries.
 *
 * Two rules hold throughout, and they are what keep the product responsive with
 * many teams on it at once:
 *
 *   Keyset pagination, never OFFSET. `OFFSET 10000` makes Postgres walk and discard
 *   ten thousand rows; a cursor on (started_at, id) reads only the page asked for,
 *   so page 500 costs the same as page 1.
 *
 *   Filtering and aggregation happen in SQL. The client never receives an unfiltered
 *   result set and then narrows it — a 50k-row run must not be shipped to a browser
 *   to be counted.
 */

export interface RunListFilter {
  orgId: string;
  projectId?: string | undefined;
  branch?: string | undefined;
  environment?: string | undefined;
  framework?: string | undefined;
  status?: readonly string[] | undefined;
  /** Every key/value must be present on the run (AND semantics). */
  tags?: Tags | undefined;
  /** Matches run name, branch or commit. */
  search?: string | undefined;
  since?: Date | undefined;
  until?: Date | undefined;
  onlyFailed?: boolean | undefined;
}

export interface RunCursor {
  startedAt: Date;
  id: string;
}

export interface RunListRow {
  id: string;
  projectId: string;
  projectKey: string;
  name: string | null;
  framework: string | null;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  branch: string | null;
  environment: string | null;
  commitSha: string | null;
  prNumber: number | null;
  ciJobUrl: string | null;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  errored: number;
  flaky: number;
  passRate: string;
  tags: Tags;
  warningCount: number;
}

export interface RunListPage {
  runs: RunListRow[];
  nextCursor: RunCursor | null;
}

/**
 * Encodes filters as SQL fragments once, so the list query and the facet query
 * cannot drift apart — a facet count that disagrees with the list it describes is
 * worse than no facet at all.
 */
function runFilterConditions(sql: Sql, filter: RunListFilter) {
  const conditions = [sql`r.org_id = ${filter.orgId}`];

  if (filter.projectId) conditions.push(sql`r.project_id = ${filter.projectId}`);
  if (filter.branch) conditions.push(sql`r.branch = ${filter.branch}`);
  if (filter.environment) conditions.push(sql`r.environment = ${filter.environment}`);
  if (filter.framework) conditions.push(sql`r.framework = ${filter.framework}`);
  if (filter.status && filter.status.length > 0) {
    conditions.push(sql`r.status IN ${sql(filter.status)}`);
  }
  if (filter.since) conditions.push(sql`r.started_at >= ${filter.since}`);
  if (filter.until) conditions.push(sql`r.started_at < ${filter.until}`);
  if (filter.onlyFailed) conditions.push(sql`(r.failed > 0 OR r.errored > 0)`);

  // @> containment is what the GIN jsonb_path_ops index on runs.tags serves.
  if (filter.tags && Object.keys(filter.tags).length > 0) {
    conditions.push(sql`r.tags @> ${sql.json(filter.tags)}`);
  }

  if (filter.search) {
    const pattern = `%${filter.search}%`;
    conditions.push(
      sql`(r.name ILIKE ${pattern} OR r.branch ILIKE ${pattern} OR r.commit_sha ILIKE ${pattern})`,
    );
  }

  return conditions.reduce((combined, condition) => sql`${combined} AND ${condition}`);
}

export async function listRuns(
  sql: Sql,
  filter: RunListFilter,
  options: { limit?: number; cursor?: RunCursor | null } = {},
): Promise<RunListPage> {
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
  const where = runFilterConditions(sql, filter);

  // Fetch one extra row to learn whether another page exists without a count(*).
  const cursor = options.cursor;
  const rows = await sql<(RunListRow & { started_at: Date })[]>`
    SELECT
      r.id,
      r.project_id     AS "projectId",
      p.key            AS "projectKey",
      r.name,
      r.framework,
      r.status,
      r.started_at     AS "startedAt",
      r.finished_at    AS "finishedAt",
      r.duration_ms    AS "durationMs",
      r.branch,
      r.environment,
      r.commit_sha     AS "commitSha",
      r.pr_number      AS "prNumber",
      r.ci_job_url     AS "ciJobUrl",
      r.total, r.passed, r.failed, r.skipped, r.errored, r.flaky,
      r.pass_rate      AS "passRate",
      r.tags,
      jsonb_array_length(r.warnings) AS "warningCount"
    FROM runs r
    JOIN projects p ON p.id = r.project_id
    WHERE ${where}
    ${
      cursor
        ? // Strict tuple comparison: ties on started_at are broken by id, so no
          // row is skipped or repeated across pages.
          sql`AND (r.started_at, r.id) < (${cursor.startedAt}, ${cursor.id})`
        : sql``
    }
    ORDER BY r.started_at DESC, r.id DESC
    LIMIT ${limit + 1}
  `;

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);

  return {
    runs: page,
    nextCursor: hasMore && last ? { startedAt: last.startedAt, id: last.id } : null,
  };
}

export interface TagFacet {
  key: string;
  value: string;
  count: number;
}

/**
 * Tag facet counts for the filter sidebar.
 *
 * Computed under the *current* filter minus the tag predicate, which is what makes
 * the counts mean "how many more runs would this narrow me to" rather than a
 * meaningless global tally.
 */
export async function tagFacets(
  sql: Sql,
  filter: RunListFilter,
  options: { limit?: number } = {},
): Promise<TagFacet[]> {
  const limit = options.limit ?? 100;
  const withoutTags: RunListFilter = { ...filter };
  delete withoutTags.tags;
  const where = runFilterConditions(sql, withoutTags);

  return sql<TagFacet[]>`
    SELECT tag.key, tag.value, count(*)::int AS count
    FROM runs r
    CROSS JOIN LATERAL jsonb_each_text(r.tags) AS tag(key, value)
    WHERE ${where}
    GROUP BY tag.key, tag.value
    ORDER BY count DESC, tag.key, tag.value
    LIMIT ${limit}
  `;
}

/** Distinct values for the non-tag filter dropdowns. */
export async function runFilterOptions(
  sql: Sql,
  filter: RunListFilter,
): Promise<{ branches: string[]; environments: string[]; frameworks: string[] }> {
  const where = runFilterConditions(sql, { ...filter, branch: undefined, environment: undefined });

  // Each UNION branch is parenthesized: Postgres rejects a bare ORDER BY/LIMIT
  // inside a set operation, and each branch needs its own ordering so the most
  // recently used values appear first.
  const rows = await sql<{ kind: string; value: string }[]>`
    WITH scoped AS (SELECT * FROM runs r WHERE ${where})
    SELECT kind, value FROM (
      (SELECT 'branch' AS kind, branch AS value, max(started_at) AS ord
         FROM scoped WHERE branch IS NOT NULL GROUP BY branch
         ORDER BY ord DESC LIMIT 50)
      UNION ALL
      (SELECT 'environment' AS kind, environment AS value, max(started_at) AS ord
         FROM scoped WHERE environment IS NOT NULL GROUP BY environment
         ORDER BY ord DESC LIMIT 50)
      UNION ALL
      (SELECT 'framework' AS kind, framework AS value, max(started_at) AS ord
         FROM scoped WHERE framework IS NOT NULL GROUP BY framework
         ORDER BY ord DESC LIMIT 50)
    ) options
    ORDER BY kind ASC, ord DESC
  `;

  return {
    branches: rows.filter((r) => r.kind === "branch").map((r) => r.value),
    environments: rows.filter((r) => r.kind === "environment").map((r) => r.value),
    frameworks: rows.filter((r) => r.kind === "framework").map((r) => r.value),
  };
}

export interface RunDetail extends RunListRow {
  warnings: { code: string; message: string }[];
  ciProvider: string | null;
  ciBuildId: string | null;
  shardIndex: number | null;
  shardTotal: number | null;
  attempt: number;
}

export async function getRun(
  sql: Sql,
  input: { orgId: string; runId: string },
): Promise<RunDetail | null> {
  const rows = await sql<RunDetail[]>`
    SELECT
      r.id,
      r.project_id  AS "projectId",
      p.key         AS "projectKey",
      r.name, r.framework, r.status,
      r.started_at  AS "startedAt",
      r.finished_at AS "finishedAt",
      r.duration_ms AS "durationMs",
      r.branch, r.environment,
      r.commit_sha  AS "commitSha",
      r.pr_number   AS "prNumber",
      r.ci_provider AS "ciProvider",
      r.ci_build_id AS "ciBuildId",
      r.ci_job_url  AS "ciJobUrl",
      r.shard_index AS "shardIndex",
      r.shard_total AS "shardTotal",
      r.attempt,
      r.total, r.passed, r.failed, r.skipped, r.errored, r.flaky,
      r.pass_rate   AS "passRate",
      r.tags,
      r.warnings,
      jsonb_array_length(r.warnings) AS "warningCount"
    FROM runs r
    JOIN projects p ON p.id = r.project_id
    WHERE r.id = ${input.runId} AND r.org_id = ${input.orgId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export interface ResultFilter {
  runId: string;
  status?: readonly string[] | undefined;
  suite?: string | undefined;
  /** Full-text-ish search over test name, classname and failure message. */
  search?: string | undefined;
  onlyFlaky?: boolean | undefined;
}

export interface ResultCursor {
  /** Sort is (status rank, duration desc, id) so failures surface first. */
  statusRank: number;
  durationMs: number;
  id: number;
}

export interface ResultRow {
  id: number;
  testCaseId: number;
  name: string;
  classname: string | null;
  suite: string | null;
  status: string;
  durationMs: number | null;
  retryCount: number;
  wasFlaky: boolean;
  failureType: string | null;
  failureMessage: string | null;
  statusRank: number;
  flakeScore: string;
  quarantined: boolean;
}

export interface ResultPage {
  results: ResultRow[];
  nextCursor: ResultCursor | null;
}

/**
 * Failures first, then errors, then flaky passes, then the rest.
 *
 * Opening a red run should show what broke without scrolling. Ordering in SQL keeps
 * that true across pages — a client-side sort could only order the page it holds.
 */
const STATUS_RANK_SQL = `CASE r.status
    WHEN 'failed'  THEN 0
    WHEN 'error'   THEN 1
    WHEN 'blocked' THEN 2
    WHEN 'skipped' THEN 4
    ELSE 3
  END`;

export async function listRunResults(
  sql: Sql,
  filter: ResultFilter,
  options: { limit?: number; cursor?: ResultCursor | null } = {},
): Promise<ResultPage> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);

  const conditions = [sql`r.run_id = ${filter.runId}`];
  if (filter.status && filter.status.length > 0) {
    conditions.push(sql`r.status IN ${sql(filter.status)}`);
  }
  if (filter.suite) conditions.push(sql`tc.suite = ${filter.suite}`);
  if (filter.onlyFlaky) conditions.push(sql`r.was_flaky = true`);
  if (filter.search) {
    const pattern = `%${filter.search}%`;
    conditions.push(
      sql`(tc.name ILIKE ${pattern} OR tc.classname ILIKE ${pattern} OR r.failure_message ILIKE ${pattern})`,
    );
  }
  const where = conditions.reduce((combined, condition) => sql`${combined} AND ${condition}`);
  const cursor = options.cursor;

  const rows = await sql<ResultRow[]>`
    SELECT
      r.id,
      r.test_case_id   AS "testCaseId",
      tc.name,
      tc.classname,
      tc.suite,
      r.status,
      r.duration_ms    AS "durationMs",
      r.retry_count    AS "retryCount",
      r.was_flaky      AS "wasFlaky",
      r.failure_type   AS "failureType",
      r.failure_message AS "failureMessage",
      ${sql.unsafe(STATUS_RANK_SQL)} AS "statusRank",
      tc.flake_score   AS "flakeScore",
      tc.quarantined
    FROM test_results r
    JOIN test_cases tc ON tc.id = r.test_case_id
    WHERE ${where}
    ${
      cursor
        ? sql`AND (${sql.unsafe(STATUS_RANK_SQL)}, COALESCE(r.duration_ms, 0), r.id)
               > (${cursor.statusRank}, ${cursor.durationMs}, ${cursor.id})`
        : sql``
    }
    ORDER BY ${sql.unsafe(STATUS_RANK_SQL)} ASC, COALESCE(r.duration_ms, 0) ASC, r.id ASC
    LIMIT ${limit + 1}
  `;

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);

  return {
    results: page,
    nextCursor:
      hasMore && last
        ? { statusRank: last.statusRank, durationMs: last.durationMs ?? 0, id: last.id }
        : null,
  };
}

export interface ResultDetail extends ResultRow {
  stackTrace: string | null;
  stdout: string | null;
  stderr: string | null;
  message: string | null;
  startedAt: Date;
  parameters: Record<string, unknown> | null;
  tags: Tags;
}

/**
 * Heavy fields (stack trace, captured output) are fetched only for the one result a
 * user opened. Including them in the list query would make every page of a 50k-row
 * table carry megabytes of text nobody is reading.
 */
export async function getRunResult(
  sql: Sql,
  input: { runId: string; resultId: number },
): Promise<ResultDetail | null> {
  const rows = await sql<ResultDetail[]>`
    SELECT
      r.id,
      r.test_case_id AS "testCaseId",
      tc.name, tc.classname, tc.suite, tc.parameters,
      r.status,
      r.duration_ms  AS "durationMs",
      r.retry_count  AS "retryCount",
      r.was_flaky    AS "wasFlaky",
      r.failure_type AS "failureType",
      r.failure_message AS "failureMessage",
      r.stack_trace  AS "stackTrace",
      r.stdout, r.stderr, r.message,
      r.started_at   AS "startedAt",
      r.tags,
      ${sql.unsafe(STATUS_RANK_SQL)} AS "statusRank",
      tc.flake_score AS "flakeScore",
      tc.quarantined
    FROM test_results r
    JOIN test_cases tc ON tc.id = r.test_case_id
    WHERE r.run_id = ${input.runId} AND r.id = ${input.resultId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export interface SuiteSummary {
  suite: string | null;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
}

/** Powers the run page's suite tree; one grouped query, not one per suite. */
export async function summarizeRunSuites(sql: Sql, runId: string): Promise<SuiteSummary[]> {
  return sql<SuiteSummary[]>`
    SELECT
      tc.suite,
      count(*)::int AS total,
      count(*) FILTER (WHERE r.status = 'passed')::int AS passed,
      count(*) FILTER (WHERE r.status IN ('failed', 'error'))::int AS failed,
      count(*) FILTER (WHERE r.status = 'skipped')::int AS skipped,
      COALESCE(sum(r.duration_ms), 0)::int AS "durationMs"
    FROM test_results r
    JOIN test_cases tc ON tc.id = r.test_case_id
    WHERE r.run_id = ${runId}
    GROUP BY tc.suite
    ORDER BY failed DESC, total DESC, tc.suite ASC NULLS LAST
  `;
}

export interface ProjectSummary {
  id: string;
  key: string;
  name: string;
  /** Non-null when the project is archived; only ever populated with includeArchived. */
  archivedAt: Date | null;
  lastRunAt: Date | null;
  lastRunStatus: string | null;
  runs7d: number;
  passRate7d: string | null;
}

export async function listProjects(
  sql: Sql,
  orgId: string,
  options: { includeArchived?: boolean } = {},
): Promise<ProjectSummary[]> {
  const includeArchived = options.includeArchived ?? false;
  return sql<ProjectSummary[]>`
    SELECT
      p.id, p.key, p.name, p.archived_at AS "archivedAt",
      recent.last_run_at   AS "lastRunAt",
      recent.last_status   AS "lastRunStatus",
      COALESCE(recent.runs_7d, 0)::int AS "runs7d",
      recent.pass_rate_7d  AS "passRate7d"
    FROM projects p
    LEFT JOIN LATERAL (
      SELECT
        max(started_at) AS last_run_at,
        (array_agg(status ORDER BY started_at DESC))[1] AS last_status,
        count(*) FILTER (WHERE started_at >= now() - INTERVAL '7 days') AS runs_7d,
        ROUND(AVG(pass_rate) FILTER (WHERE started_at >= now() - INTERVAL '7 days'), 2) AS pass_rate_7d
      FROM runs
      WHERE runs.project_id = p.id
    ) recent ON true
    WHERE p.org_id = ${orgId}
      ${includeArchived ? sql`` : sql`AND p.archived_at IS NULL`}
    ORDER BY recent.last_run_at DESC NULLS LAST, p.name ASC
  `;
}

export async function findProjectByKey(
  sql: Sql,
  input: { orgId: string; key: string },
): Promise<{ id: string; key: string; name: string } | null> {
  const rows = await sql<{ id: string; key: string; name: string }[]>`
    SELECT id, key, name FROM projects
    WHERE org_id = ${input.orgId} AND key = ${input.key} AND archived_at IS NULL
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/** Replaces a run's tags. Used by post-upload tag editing. */
export async function updateRunTags(
  sql: Sql,
  input: { orgId: string; runId: string; tags: Tags },
): Promise<boolean> {
  const updated = await sql`
    UPDATE runs SET tags = ${sql.json(input.tags)}
    WHERE id = ${input.runId} AND org_id = ${input.orgId}
  `;
  return (updated.count ?? 0) > 0;
}
