import { notFound } from "next/navigation";
import { RUN_VERDICT_LABELS, type RunVerdict } from "@testcenter/core";
import {
  findProjectByKey,
  latestRunVerdicts,
  listRunsForExport,
  type RunExportRow,
} from "@testcenter/db";
import { csvFilenamePart, csvResponse, type CsvColumn, toCsv } from "@/lib/csv";
import { resolveDashboardDays } from "@/lib/dashboard-range";
import { getServices } from "@/lib/services";
import { requirePageContext } from "@/lib/viewer";

/**
 * The dashboard window as a CSV, one row per run.
 *
 * A sibling of `DashboardExport` rather than a mode of it. The PDF is a document — it formats
 * for a reader, and every value in it has been through `formatDuration` or `formatPercent`.
 * Reusing those here is the mistake this file exists to avoid: `"2m 3s"` and `"96.4%"` are
 * both text to a spreadsheet, so a column of them cannot be summed, averaged or charted, and
 * the export would be a screenshot with commas in it. Durations stay integer milliseconds and
 * rates stay bare numbers; the reader formats them, or does arithmetic on them, as they choose.
 *
 * Same window and same scope as the PDF, so the two reconcile: a reader who exports both
 * gets a document and the numbers behind it, not two disagreeing views.
 */
export async function dashboardExportCsv({
  orgSlug,
  scopedProjectKey,
  params,
}: {
  orgSlug: string;
  scopedProjectKey: string | null;
  params: { days?: string };
}): Promise<Response> {
  const context = await requirePageContext(orgSlug);
  const { sql } = getServices();
  const days = resolveDashboardDays(params.days);
  const project = scopedProjectKey
    ? await findProjectByKey(sql, { orgId: context.org.id, key: scopedProjectKey })
    : null;
  if (scopedProjectKey && !project) notFound();

  const page = await listRunsForExport(sql, {
    orgId: context.org.id,
    projectId: project?.id,
    days,
  });

  /*
   * The verdict is the human sign-off, so it belongs in the export somebody builds a release
   * report from. Fetched by id from the rows already in hand, exactly as the PDF and the
   * dashboard do — `latestRunVerdicts` is the one place that knows "latest" means latest.
   */
  const verdicts = await latestRunVerdicts(sql, {
    orgId: context.org.id,
    runIds: page.runs.map((run) => run.runId),
  });
  const verdictLabel = (runId: string): string => {
    const verdict = verdicts.get(runId)?.verdict ?? null;
    // Empty would be indistinguishable from a run type that never takes a verdict. An
    // unreviewed run is a real state — it is the one a release report is looking for.
    if (verdict === null) return "unreviewed";
    return verdict in RUN_VERDICT_LABELS ? RUN_VERDICT_LABELS[verdict as RunVerdict] : verdict;
  };

  const columns: CsvColumn<RunExportRow>[] = [
    { header: "run_id", value: (run) => run.runId },
    { header: "project_key", value: (run) => run.projectKey },
    // UTC, and named so in the header. The PDF renders the viewer's zone because a reader
    // needs local time; a column that is sorted and subtracted needs one zone, stated.
    { header: "started_at_utc", value: (run) => run.startedAt },
    { header: "finished_at_utc", value: (run) => run.finishedAt },
    { header: "duration_ms", value: (run) => run.durationMs },
    { header: "run_name", value: (run) => run.name },
    { header: "branch", value: (run) => run.branch },
    // Full sha, not `shortSha`. This is the column that joins the export to a git history or
    // a deploy log, and a seven-character prefix is not a key.
    { header: "commit_sha", value: (run) => run.commitSha },
    { header: "pr_number", value: (run) => run.prNumber },
    { header: "environment", value: (run) => run.environment },
    { header: "framework", value: (run) => run.framework },
    { header: "status", value: (run) => run.status },
    { header: "verdict", value: (run) => verdictLabel(run.runId) },
    { header: "tests_total", value: (run) => run.total },
    { header: "passed", value: (run) => run.passed },
    { header: "failed", value: (run) => run.failed },
    { header: "errored", value: (run) => run.errored },
    { header: "skipped", value: (run) => run.skipped },
    { header: "flaky", value: (run) => run.flaky },
    // 0–100, matching the tile. Not divided by 100 into a fraction: the dashboard, the API
    // and this file should not each hold a different idea of what "pass rate" is.
    { header: "pass_rate_percent", value: (run) => run.passRate },
    { header: "ci_job_url", value: (run) => run.ciJobUrl },
  ];

  const scopePart = csvFilenamePart(project ? `${orgSlug}-${project.key}` : orgSlug);
  const datePart = new Date().toISOString().slice(0, 10);
  /*
   * Truncation is stated in the filename.
   *
   * A CSV has nowhere else to put it. The PDF says so in a footnote, but a comment row here
   * would land in the data and a response header nobody sees is not a disclosure — and a
   * partial export that looks complete is the failure mode worth spending a filename on.
   */
  const truncatedPart = page.truncated ? `-partial-${page.runs.length}-of-${page.total}` : "";
  const filename = `testcenter-runs-${scopePart}-${days}d-${datePart}${truncatedPart}.csv`;

  return csvResponse(filename, toCsv(columns, page.runs));
}
