import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { fillTemplate } from "@testcenter/core";
import { createClient, type Database, type Sql } from "./client.js";
import { bootstrap } from "./bootstrap.js";
import {
  addRunTotals,
  finalizeRun,
  persistResultBatch,
  refreshTestCaseStats,
  rollupProjectDay,
} from "./ingest.js";
import { addRunVerdict, setQuarantine } from "./insights.js";
import { findQuestion, REPORT_QUESTIONS, resolveBlanks, runReport } from "./reports.js";
import * as schema from "./schema.js";

/**
 * Reports, against a real Postgres.
 *
 * The catalogue is twelve questions and each one carries its own SQL inside `runReport`.
 * That is the shape that makes this module risky: a malformed query in one question is
 * invisible until somebody picks that question, and nothing else in the app touches it. The
 * same exposure produced the `runFilterOptions` 500 and motivated `insights.test.ts`; this
 * is the larger version of it, at 1,434 lines.
 *
 * So the spine of this file is a loop that runs *every* question and asserts the result is
 * well formed. Adding a thirteenth question without a query that parses will fail here.
 *
 * Beyond that it checks the things a report has to get right to be worth printing: the
 * title has no unfilled blanks left in it, panel ids are unique so print CSS and callers can
 * target them, an empty project says so instead of drawing empty axes, and one tenant's
 * report never contains another's rows.
 */
const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

const testOrgSlug = `test-reports-${Math.random().toString(36).slice(2, 10)}`;

const BROKEN = "reports_broken";
const STEADY = "reports_steady";
const FLIPPER = "reports_flipper";
const QUARANTINED = "reports_quarantined";

/** Sensible values for every blank kind, so each question can actually be answered. */
function paramsFor(question: (typeof REPORT_QUESTIONS)[number]): Record<string, string> {
  const params: Record<string, string> = {};
  for (const blank of question.blanks) {
    switch (blank.kind) {
      case "days":
        params[blank.key] = "30";
        break;
      case "topN":
        params[blank.key] = "10";
        break;
      case "branch":
        params[blank.key] = "main";
        break;
      case "environment":
        params[blank.key] = "staging";
        break;
      case "suite":
        params[blank.key] = "specs/a.spec.ts";
        break;
      case "verdict":
        params[blank.key] = "infra";
        break;
      case "project":
        // Left unset on purpose: `project` is the scope, not a filter, at org level.
        break;
    }
  }
  return params;
}

describeIfDb("reports", () => {
  let sql: Sql;
  let db: Database;
  let orgId: string;
  let projectId: string;
  let emptyProjectId: string;
  const runIds: string[] = [];

  beforeAll(async () => {
    const client = createClient({ databaseUrl: databaseUrl as string, maxConnections: 4 });
    sql = client.sql;
    db = client.db;
    const boot = await bootstrap(db, {
      orgSlug: testOrgSlug,
      orgName: "Reports Test Org",
      projectKey: "reports-test",
      projectName: "Reports Test",
    });
    orgId = boot.orgId;
    projectId = boot.projectId;

    /*
     * Six runs over six days on two branches and two environments.
     *
     * The shape is chosen so the questions have something to distinguish: `broken` fails
     * throughout, `flipper` alternates so "flipping tests" and "newly failing" have a
     * subject, `steady` never fails, and one test is quarantined so the audit question is
     * not empty. Two runs carry verdicts and the rest do not, which is what makes
     * "unreviewed runs" and the verdict split meaningful.
     */
    for (let index = 0; index < 6; index += 1) {
      const branch = index % 3 === 2 ? "release/2.0" : "main";
      const environment = index % 2 === 0 ? "staging" : "production";
      const startedAt = new Date(Date.now() - (6 - index) * 24 * 60 * 60 * 1000);
      const flipperFails = index % 2 === 0;

      const results = [
        { name: STEADY, status: "passed" as const, suite: "specs/a.spec.ts", durationMs: 100 },
        {
          name: BROKEN,
          status: "failed" as const,
          suite: "specs/a.spec.ts",
          durationMs: 250,
          failure: {
            type: "AssertionError",
            message: "expected 1 to equal 2",
            stackTrace: "    at check (specs/a.spec.ts:10:3)",
          },
        },
        {
          name: FLIPPER,
          status: flipperFails ? ("failed" as const) : ("passed" as const),
          suite: "specs/b.spec.ts",
          durationMs: 180,
          ...(flipperFails
            ? { failure: { type: "TimeoutError", message: "timed out after 30000ms" } }
            : {}),
        },
        {
          name: QUARANTINED,
          status: "failed" as const,
          suite: "specs/b.spec.ts",
          durationMs: 90,
          failure: { type: "AssertionError", message: "known bad" },
        },
      ];

      const inserted = await db
        .insert(schema.runs)
        .values({
          orgId,
          projectId,
          name: `reports run ${index}`,
          framework: "playwright",
          status: "parsing",
          branch,
          environment,
          startedAt,
        })
        .returning({ id: schema.runs.id });
      const runId = inserted[0]?.id as string;
      runIds.push(runId);

      const { totals } = await persistResultBatch(sql, {
        orgId,
        projectId,
        runId,
        results,
        runStartedAt: startedAt,
      });
      await addRunTotals(sql, runId, totals);
      await finalizeRun(sql, {
        runId,
        status: "complete",
        durationMs: 60_000 + index * 10_000,
        finishedAt: new Date(startedAt.getTime() + 60_000),
      });
      await rollupProjectDay(sql, { orgId, projectId, day: startedAt, branch });
      await refreshTestCaseStats(sql, { projectId, runId, windowDays: 90 });
    }

    // Two of six reviewed, so "unreviewed" and the verdict split are both non-trivial.
    await addRunVerdict(sql, {
      orgId,
      runId: runIds[0] as string,
      verdict: "infra",
      note: "cluster down",
      userId: null,
    });
    await addRunVerdict(sql, {
      orgId,
      runId: runIds[1] as string,
      verdict: "product-bug",
      userId: null,
    });

    const quarantined = await sql<{ id: number }[]>`
      SELECT id FROM test_cases WHERE project_id = ${projectId} AND name = ${QUARANTINED} LIMIT 1
    `;
    await setQuarantine(sql, {
      orgId,
      testCaseId: Number(quarantined[0]?.id),
      quarantined: true,
      reason: "known bad, tracked in TC-1",
    });

    const empty = await db
      .insert(schema.projects)
      .values({ orgId, key: "reports-empty", name: "Reports Empty" })
      .returning({ id: schema.projects.id });
    emptyProjectId = empty[0]?.id as string;
  });

  afterAll(async () => {
    if (!sql) return;
    await db.delete(schema.organizations).where(eq(schema.organizations.slug, testOrgSlug));
    await sql.end({ timeout: 5 });
  });

  const ctx = () => ({
    orgId,
    projectId,
    scopeLabel: "Reports Test",
    orgSlug: testOrgSlug,
  });

  // ── the catalogue itself ──────────────────────────────────────────────────

  describe("catalogue", () => {
    it("has unique ids and a blank for every placeholder in its template", () => {
      const ids = REPORT_QUESTIONS.map((question) => question.id);
      expect(new Set(ids).size).toBe(ids.length);

      for (const question of REPORT_QUESTIONS) {
        // A template referring to a blank that does not exist renders the raw key to the
        // reader — "in the last {days} days" with no `days` blank to fill it.
        const referenced = [...question.template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
        const declared = question.blanks.map((blank) => blank.key);
        for (const key of referenced) expect(declared).toContain(key);
        expect(question.purpose.length).toBeGreaterThan(0);
        expect(["org", "project", "both"]).toContain(question.scope);
      }
    });

    it("finds a question by id, and nothing for an unknown one", () => {
      expect(findQuestion("most-failing-tests")?.id).toBe("most-failing-tests");
      expect(findQuestion("no-such-question")).toBeUndefined();
      // The page passes `params.q` straight through, so undefined is a real input.
      expect(findQuestion(undefined)).toBeUndefined();
    });
  });

  describe("fillTemplate", () => {
    const question = REPORT_QUESTIONS.find((q) => q.id === "most-failing-tests")!;

    it("substitutes chosen values", () => {
      const filled = fillTemplate(question.template, question.blanks, {
        days: "14",
        branch: "main",
      });
      expect(filled).toContain("14");
      expect(filled).toContain("main");
      expect(filled).not.toMatch(/\{\w+\}/);
    });

    it("falls back to the placeholder so the sentence still reads", () => {
      // Before anything is chosen the question is still shown, so an unfilled blank has to
      // read as words — "on any branch" — rather than as "{branch}".
      const filled = fillTemplate(question.template, question.blanks, {});
      expect(filled).not.toMatch(/\{\w+\}/);
      for (const blank of question.blanks) {
        if (!blank.required) expect(filled).toContain(blank.placeholder);
      }
    });
  });

  // ── the spine: every question must run ────────────────────────────────────

  describe("every question runs", () => {
    it.each(REPORT_QUESTIONS.map((question) => [question.id, question] as const))(
      "%s produces a well-formed report",
      async (_id, question) => {
        const result = await runReport(sql, question, paramsFor(question), ctx());

        expect(result.questionId).toBe(question.id);
        // An unfilled blank in a printed title is the most visible way this breaks.
        expect(result.title).not.toMatch(/\{\w+\}/);
        expect(result.title.length).toBeGreaterThan(0);
        expect(result.subtitle).toContain("Reports Test");
        expect(typeof result.empty).toBe("boolean");
        expect(Array.isArray(result.panels)).toBe(true);

        const ids = result.panels.map((panel) => panel.id);
        // The interface promises panel ids are stable within a report so print CSS and
        // callers can target them; duplicates would silently break both.
        expect(new Set(ids).size).toBe(ids.length);

        for (const panel of result.panels) {
          expect(panel.id.length).toBeGreaterThan(0);
          expect(panel.title).not.toMatch(/\{\w+\}/);
          expect(panel.data).toBeTruthy();
          expect(["stat", "trend", "ranked", "volume", "table"]).toContain(panel.data.kind);

          if (panel.data.kind === "table") {
            const columnKeys = panel.data.columns.map((column) => column.key);
            expect(columnKeys.length).toBeGreaterThan(0);
            // A row key with no column is a value that never renders.
            for (const row of panel.data.rows) {
              for (const key of Object.keys(row)) expect(columnKeys).toContain(key);
            }
          }
        }
      },
    );

    it.each(REPORT_QUESTIONS.map((question) => [question.id, question] as const))(
      "%s answers for a project with no runs instead of throwing",
      async (_id, question) => {
        /*
         * Every question is reachable from a brand-new project's Reports tab before a single
         * report has been uploaded. `avg` over no rows is null and `max` over no rows is
         * null, which is the classic way this kind of query breaks.
         */
        const result = await runReport(sql, question, paramsFor(question), {
          orgId,
          projectId: emptyProjectId,
          scopeLabel: "Reports Empty",
          orgSlug: testOrgSlug,
        });
        expect(result.questionId).toBe(question.id);
        expect(result.title).not.toMatch(/\{\w+\}/);
        expect(Array.isArray(result.panels)).toBe(true);
      },
    );

    it.each(REPORT_QUESTIONS.map((question) => [question.id, question] as const))(
      "%s returns nothing for another organisation",
      async (_id, question) => {
        // The tenant boundary, asserted per question rather than once: each carries its own
        // SQL, so each is its own opportunity to forget the org predicate.
        const result = await runReport(sql, question, paramsFor(question), {
          orgId: "00000000-0000-7000-8000-0000000000ff",
          scopeLabel: "Somebody Else",
          orgSlug: "somebody-else",
        });

        for (const panel of result.panels) {
          if (panel.data.kind === "table") expect(panel.data.rows).toEqual([]);
          if (panel.data.kind === "ranked") expect(panel.data.bars).toEqual([]);
        }
      },
    );
  });

  // ── the answers themselves ────────────────────────────────────────────────

  describe("answers", () => {
    async function report(id: string, overrides: Record<string, string> = {}) {
      const question = findQuestion(id)!;
      return runReport(sql, question, { ...paramsFor(question), ...overrides }, ctx());
    }

    function rowsOf(result: Awaited<ReturnType<typeof runReport>>): Record<string, string>[] {
      return result.panels.flatMap((panel) => (panel.data.kind === "table" ? panel.data.rows : []));
    }

    function barsOf(
      result: Awaited<ReturnType<typeof runReport>>,
    ): { label: string; value: number; display: string; detail?: string | null }[] {
      return result.panels.flatMap((panel) =>
        panel.data.kind === "ranked" ? panel.data.bars : [],
      );
    }

    function textOf(result: Awaited<ReturnType<typeof runReport>>): string {
      return JSON.stringify(result.panels);
    }

    it("names the consistently-failing test as the most-failing", async () => {
      const result = await report("most-failing-tests", { branch: "" });
      expect(textOf(result)).toContain(BROKEN);
      expect(result.empty).toBe(false);
    });

    it("finds the test that flips between pass and fail", async () => {
      const result = await report("flipping-tests", { suite: "" });
      // `flipper` alternates every run; `steady` never changes and must not appear.
      expect(textOf(result)).toContain(FLIPPER);
    });

    it("reports the quarantine audit with the reason", async () => {
      const result = await report("quarantine-audit");
      const text = textOf(result);
      expect(text).toContain(QUARANTINED);
      // The reason is the point of the audit — a list of hidden tests without why is not
      // actionable.
      expect(text).toContain("TC-1");
    });

    it("splits the red by verdict, counting unreviewed alongside", async () => {
      /*
       * Six failing runs, two judged. The labels are humanised for display — "Product bug",
       * not the `product-bug` slug that goes in the database — so this asserts what a reader
       * actually sees, and the counts rather than mere presence.
       *
       * Unreviewed being counted as its own bar is the point of the panel: a split of two
       * judged runs means nothing without knowing four were never looked at.
       */
      const result = await report("verdict-split");
      const byLabel = new Map(barsOf(result).map((bar) => [bar.label, bar.value]));
      expect(byLabel.get("Infra")).toBe(1);
      expect(byLabel.get("Product bug")).toBe(1);
      expect(byLabel.get("Unreviewed")).toBe(4);
    });

    it("lists the runs still unreviewed", async () => {
      // Six runs, two given a verdict, so four remain.
      const result = await report("unreviewed-runs", { branch: "" });
      expect(result.empty).toBe(false);
      expect(rowsOf(result).length).toBeGreaterThan(0);
    });

    it("filters runs by the chosen verdict", async () => {
      const infra = await report("runs-by-verdict", { verdict: "infra" });
      expect(rowsOf(infra).length).toBe(1);

      // A verdict nobody used is an empty answer, not an error.
      const flaky = await report("runs-by-verdict", { verdict: "flaky" });
      expect(rowsOf(flaky)).toEqual([]);
    });

    it("narrows to a branch when one is chosen", async () => {
      // `slowest-runs` answers with a stat and a ranked list, not a table — so the rows to
      // compare are bars. Four of the six runs are on main.
      const all = await report("slowest-runs", { branch: "" });
      const main = await report("slowest-runs", { branch: "main" });

      expect(barsOf(all).length).toBe(6);
      expect(barsOf(main).length).toBe(4);
      // Each bar names its branch in the detail line; none may be from the other branch.
      for (const bar of barsOf(main)) expect(bar.detail ?? "").toContain("main");
      expect(textOf(main)).not.toContain("release/2.0");
    });
  });

  // ── the blanks a question offers ──────────────────────────────────────────

  describe("resolveBlanks", () => {
    it("offers only values that exist in the data", async () => {
      const question = findQuestion("most-failing-tests")!;
      const blanks = await resolveBlanks(sql, question, { orgId, projectId });

      const branch = blanks.find((blank) => blank.key === "branch");
      const values = branch?.options.map((option) => option.value) ?? [];
      expect(values).toContain("main");
      expect(values).toContain("release/2.0");
      // Offering a branch with no runs would produce an empty report from a valid choice.
      expect(values).not.toContain("no-such-branch");

      for (const blank of blanks) {
        expect(question.blanks.map((spec) => spec.key)).toContain(blank.key);
      }
    });

    it("offers the fixed day and top-N choices", async () => {
      const question = findQuestion("most-failing-tests")!;
      const blanks = await resolveBlanks(sql, question, { orgId, projectId });
      const days = blanks.find((blank) => blank.key === "days");
      expect(days?.options.length).toBeGreaterThan(0);
      // A default is required: the picker renders before anything is chosen.
      expect(days?.defaultValue).toBeTruthy();
    });

    it("returns empty option lists for a project with no runs", async () => {
      const question = findQuestion("slowest-runs")!;
      const blanks = await resolveBlanks(sql, question, { orgId, projectId: emptyProjectId });
      const branch = blanks.find((blank) => blank.key === "branch");
      expect(branch?.options ?? []).toEqual([]);
    });

    it("resolves blanks for every question without error", async () => {
      // Same reasoning as running every report: each question's blanks are resolved by their
      // own queries.
      for (const question of REPORT_QUESTIONS) {
        const blanks = await resolveBlanks(sql, question, { orgId, projectId });
        expect(Array.isArray(blanks)).toBe(true);
      }
    });
  });
});
