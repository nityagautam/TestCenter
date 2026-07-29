import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createClient, type Database, type Sql } from "./client.js";
import { bootstrap } from "./bootstrap.js";
import { persistResultBatch, addRunTotals, finalizeRun, failStalledRuns } from "./ingest.js";
import {
  getRun,
  getRunResult,
  listProjects,
  listRunResults,
  listRuns,
  runFilterOptions,
  summarizeRunSuites,
  tagFacets,
  updateRunTags,
} from "./queries.js";
import * as schema from "./schema.js";

/**
 * Read-path tests against a real Postgres.
 *
 * Every function here builds SQL by string composition, so the failure mode is a
 * syntax or semantics error that only appears at runtime — exactly what unit tests
 * with a fake database cannot catch. `runFilterOptions` shipped broken (a bare
 * ORDER BY inside a UNION branch) and took the whole run list down with a 500;
 * these tests exist so that cannot recur silently.
 */
const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

function uniqueName(prefix: string): string {
  const letters = Array.from(
    { length: 10 },
    () => "abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 26)],
  ).join("");
  return `${prefix} ${letters}`;
}

describeIfDb("read-path queries", () => {
  let sql: Sql;
  let db: Database;
  let orgId: string;
  let projectId: string;
  const runIds: string[] = [];

  beforeAll(async () => {
    const client = createClient({ databaseUrl: databaseUrl as string, maxConnections: 4 });
    sql = client.sql;
    db = client.db;
    const boot = await bootstrap(db, { projectKey: "query-test", projectName: "Query Test" });
    orgId = boot.orgId;
    projectId = boot.projectId;

    // Two runs with distinguishable shapes: one green on main, one red on a branch.
    const green = await seedRun({
      branch: "main",
      environment: "production",
      framework: "pytest",
      tags: { suite: "smoke", env: "production" },
      results: [
        { name: uniqueName("green a"), status: "passed", suite: "tests/a.py", durationMs: 10 },
        { name: uniqueName("green b"), status: "passed", suite: "tests/a.py", durationMs: 20 },
      ],
    });
    const red = await seedRun({
      branch: "feature/checkout",
      environment: "staging",
      framework: "playwright",
      tags: { suite: "regression", env: "staging" },
      results: [
        {
          name: uniqueName("red fail"),
          status: "failed",
          suite: "specs/checkout.spec.ts",
          durationMs: 900,
          failure: {
            type: "AssertionError",
            message: "expected Approved",
            stackTrace: "at x.ts:1",
          },
        },
        { name: uniqueName("red skip"), status: "skipped", suite: "specs/checkout.spec.ts" },
        {
          name: uniqueName("red flake"),
          status: "passed",
          suite: "specs/checkout.spec.ts",
          durationMs: 300,
          retries: [
            { attempt: 1, status: "failed" },
            { attempt: 2, status: "passed" },
          ],
        },
      ],
    });
    runIds.push(green, red);
  });

  afterAll(async () => {
    if (!sql) return;
    for (const runId of runIds) {
      await db.delete(schema.runs).where(eq(schema.runs.id, runId));
    }
    await sql.end({ timeout: 5 });
  });

  async function seedRun(input: {
    branch: string;
    environment: string;
    framework: string;
    tags: Record<string, string>;
    results: Parameters<typeof persistResultBatch>[1]["results"];
  }): Promise<string> {
    const inserted = await db
      .insert(schema.runs)
      .values({
        orgId,
        projectId,
        branch: input.branch,
        environment: input.environment,
        framework: input.framework,
        tags: input.tags,
        status: "parsing",
      })
      .returning({ id: schema.runs.id });
    const runId = inserted[0]?.id as string;

    const { totals } = await persistResultBatch(sql, {
      orgId,
      projectId,
      runId,
      runStartedAt: new Date(),
      results: input.results,
    });
    await addRunTotals(sql, runId, totals);
    await finalizeRun(sql, { runId, status: "complete", durationMs: 1234 });
    return runId;
  }

  it("lists runs newest first with derived counters", async () => {
    const page = await listRuns(sql, { orgId, projectId }, { limit: 10 });
    expect(page.runs.length).toBeGreaterThanOrEqual(2);

    const red = page.runs.find((run) => run.branch === "feature/checkout");
    expect(red?.total).toBe(3);
    expect(red?.failed).toBe(1);
    expect(red?.skipped).toBe(1);
    expect(red?.flaky).toBe(1);
    // 1 passed, 1 failed, 1 skipped. Skipped stays out of the denominator, so the
    // rate is 1/2 rather than 1/3 — a suite that skips tests must not look broken.
    expect(Number(red?.passRate)).toBe(50);
    expect(red?.warningCount).toBe(0);
  });

  it("paginates by keyset without repeating or skipping rows", async () => {
    const first = await listRuns(sql, { orgId, projectId }, { limit: 1 });
    expect(first.runs).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();

    const second = await listRuns(
      sql,
      { orgId, projectId },
      { limit: 1, cursor: first.nextCursor },
    );
    expect(second.runs).toHaveLength(1);
    expect(second.runs[0]?.id).not.toBe(first.runs[0]?.id);
  });

  it("filters by branch, framework and failure presence", async () => {
    const byBranch = await listRuns(sql, { orgId, projectId, branch: "main" });
    expect(byBranch.runs.every((run) => run.branch === "main")).toBe(true);

    const byFramework = await listRuns(sql, { orgId, projectId, framework: "playwright" });
    expect(byFramework.runs.every((run) => run.framework === "playwright")).toBe(true);

    const failing = await listRuns(sql, { orgId, projectId, onlyFailed: true });
    expect(failing.runs.length).toBeGreaterThan(0);
    expect(failing.runs.every((run) => run.failed + run.errored > 0)).toBe(true);
  });

  it("filters by tag containment", async () => {
    const page = await listRuns(sql, { orgId, projectId, tags: { suite: "regression" } });
    expect(page.runs.length).toBeGreaterThan(0);
    expect(page.runs.every((run) => run.tags.suite === "regression")).toBe(true);

    const none = await listRuns(sql, { orgId, projectId, tags: { suite: "does-not-exist" } });
    expect(none.runs).toHaveLength(0);
  });

  it("computes tag facets ignoring the tag filter itself", async () => {
    // Counts must describe what a tag *would* narrow to, so the tag predicate is
    // excluded from its own facet computation.
    const facets = await tagFacets(sql, { orgId, projectId, tags: { suite: "regression" } });
    const suites = facets.filter((facet) => facet.key === "suite").map((facet) => facet.value);
    expect(suites).toContain("regression");
    expect(suites).toContain("smoke");
  });

  it("returns filter options without a SQL error", async () => {
    // Regression guard: this query composes three UNION branches, each with its own
    // ORDER BY and LIMIT. Postgres rejects those unparenthesized, which took the run
    // list down with a 500 rather than degrading.
    const options = await runFilterOptions(sql, { orgId, projectId });
    expect(options.branches).toContain("main");
    expect(options.branches).toContain("feature/checkout");
    expect(options.frameworks).toContain("playwright");
    expect(options.environments).toContain("staging");
  });

  it("orders results with failures first", async () => {
    const redRunId = runIds[1] as string;
    const page = await listRunResults(sql, { runId: redRunId });
    expect(page.results).toHaveLength(3);
    // Opening a red run must show what broke without scrolling.
    expect(page.results[0]?.status).toBe("failed");
    expect(page.results.at(-1)?.status).toBe("skipped");
  });

  it("filters results by status and flakiness", async () => {
    const redRunId = runIds[1] as string;
    const failed = await listRunResults(sql, { runId: redRunId, status: ["failed", "error"] });
    expect(failed.results).toHaveLength(1);

    const flaky = await listRunResults(sql, { runId: redRunId, onlyFlaky: true });
    expect(flaky.results).toHaveLength(1);
    expect(flaky.results[0]?.wasFlaky).toBe(true);
  });

  it("searches results by name and failure message", async () => {
    const redRunId = runIds[1] as string;
    const found = await listRunResults(sql, { runId: redRunId, search: "expected Approved" });
    expect(found.results).toHaveLength(1);
  });

  it("excludes heavy fields from the list and includes them in the detail", async () => {
    const redRunId = runIds[1] as string;
    const page = await listRunResults(sql, { runId: redRunId, status: ["failed"] });
    const row = page.results[0];
    expect(row).toBeDefined();
    // A 50k-row table must not carry stack traces; they load per-result.
    expect("stackTrace" in (row as object)).toBe(false);

    const detail = await getRunResult(sql, { runId: redRunId, resultId: row?.id as number });
    expect(detail?.stackTrace).toContain("at x.ts:1");
    expect(detail?.failureType).toBe("AssertionError");
  });

  it("summarizes suites with failure counts", async () => {
    const redRunId = runIds[1] as string;
    const suites = await summarizeRunSuites(sql, redRunId);
    const suite = suites.find((entry) => entry.suite === "specs/checkout.spec.ts");
    expect(suite?.total).toBe(3);
    expect(suite?.failed).toBe(1);
  });

  it("reads a single run scoped to its org", async () => {
    const runId = runIds[0] as string;
    expect((await getRun(sql, { orgId, runId }))?.id).toBe(runId);
    // Cross-tenant reads must return nothing rather than leak.
    const otherOrg = "00000000-0000-4000-8000-000000000000";
    expect(await getRun(sql, { orgId: otherOrg, runId })).toBeNull();
  });

  it("replaces run tags", async () => {
    const runId = runIds[0] as string;
    const updated = await updateRunTags(sql, { orgId, runId, tags: { release: "24.9" } });
    expect(updated).toBe(true);

    const run = await getRun(sql, { orgId, runId });
    expect(run?.tags).toEqual({ release: "24.9" });

    const matched = await listRuns(sql, { orgId, projectId, tags: { release: "24.9" } });
    expect(matched.runs.some((entry) => entry.id === runId)).toBe(true);
  });

  describe("stalled run reaper", () => {
    it("fails a run whose ingest never completed and records why", async () => {
      // A worker killed mid-ingest (deploy, OOM, evicted pod) leaves its run in
      // "parsing" with no job to finish it, and the UI shows a spinner forever —
      // which reads as a broken product rather than a failed import.
      const inserted = await db
        .insert(schema.runs)
        .values({ orgId, projectId, framework: "junit", status: "parsing" })
        .returning({ id: schema.runs.id });
      const stalledId = inserted[0]?.id as string;
      runIds.push(stalledId);

      // Backdate so the age threshold applies without waiting. The
      // runs_updated_at BEFORE UPDATE trigger would otherwise stamp updated_at
      // back to now() — which is exactly the behaviour the reaper relies on in
      // production, so it is suspended only for this statement.
      await sql`ALTER TABLE runs DISABLE TRIGGER runs_updated_at`;
      await sql`UPDATE runs SET updated_at = now() - INTERVAL '2 hours' WHERE id = ${stalledId}`;
      await sql`ALTER TABLE runs ENABLE TRIGGER runs_updated_at`;

      const reaped = await failStalledRuns(sql, { olderThanMinutes: 30 });
      expect(reaped.map((entry) => entry.runId)).toContain(stalledId);

      const run = await getRun(sql, { orgId, runId: stalledId });
      expect(run?.status).toBe("failed");
      expect(run?.warnings.map((warning) => warning.code)).toContain("ingest_stalled");

      // Idempotent: a second pass must not touch it again.
      const second = await failStalledRuns(sql, { olderThanMinutes: 30 });
      expect(second.map((entry) => entry.runId)).not.toContain(stalledId);
    });

    it("leaves a recent run alone", async () => {
      const inserted = await db
        .insert(schema.runs)
        .values({ orgId, projectId, framework: "junit", status: "parsing" })
        .returning({ id: schema.runs.id });
      const freshId = inserted[0]?.id as string;
      runIds.push(freshId);

      const reaped = await failStalledRuns(sql, { olderThanMinutes: 30 });
      expect(reaped.map((entry) => entry.runId)).not.toContain(freshId);
      expect((await getRun(sql, { orgId, runId: freshId }))?.status).toBe("parsing");
    });
  });

  it("lists projects with recent activity", async () => {
    const projects = await listProjects(sql, orgId);
    const project = projects.find((entry) => entry.key === "query-test");
    expect(project).toBeDefined();
    expect(project?.lastRunAt).not.toBeNull();
    expect(project?.runs7d).toBeGreaterThanOrEqual(2);
  });
});
