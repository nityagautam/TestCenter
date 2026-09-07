import { getRun, runResultsExportCursor, type ResultRow } from "@testcenter/db";
import { csvFilenamePart, csvStreamResponse, type CsvColumn } from "@/lib/csv";
import { getServices } from "@/lib/services";
import { requirePageContext } from "@/lib/viewer";

/*
 * Inside the org segment rather than under `/api/v1`, matching the dashboard export.
 *
 * This is a download a signed-in reader starts by clicking a button, so it authorises through the
 * session like every other page in this segment — `requirePageContext`, one explicit `orgId`, no
 * second auth path to keep in step. `/api/v1` is the token-authenticated machine surface.
 */
export const dynamic = "force-dynamic";

/**
 * Every result in the run, as the reader sees them plus the columns the table has no room for.
 *
 * Captured output is deliberately absent. `stdout` and `stderr` are capped at 200,000 characters
 * each, and a cell that long breaks Excel and Numbers outright — the file would be unopenable by
 * the tool it exists for. They are also fetched per-result by design (`getRunResult`), precisely
 * so a list never carries megabytes of text nobody is reading.
 */
const COLUMNS: CsvColumn<ResultRow>[] = [
  { header: "test", value: (row) => row.name },
  { header: "classname", value: (row) => row.classname },
  { header: "suite", value: (row) => row.suite },
  { header: "status", value: (row) => row.status },
  // Number(), because int8 comes back from postgres.js as a string and will not silently narrow —
  // the same trap as `dailySeries`. Left as text it sorts lexically in a spreadsheet, putting
  // "1000" before "9".
  {
    header: "duration_ms",
    value: (row) => (row.durationMs === null ? null : Number(row.durationMs)),
  },
  { header: "retries", value: (row) => row.retryCount },
  { header: "flaky_in_run", value: (row) => row.wasFlaky },
  { header: "failure_type", value: (row) => row.failureType },
  { header: "failure_message", value: (row) => row.failureMessage },
  {
    header: "flake_score",
    value: (row) => (row.flakeScore === null ? null : Number(row.flakeScore)),
  },
  { header: "quarantined", value: (row) => row.quarantined },
  { header: "test_case_id", value: (row) => row.testCaseId },
];

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ orgSlug: string; runId: string }> },
): Promise<Response> {
  const { orgSlug, runId } = await params;
  const context = await requirePageContext(orgSlug);
  const { sql } = getServices();

  /*
   * The run is resolved first, and inside the organisation, for two reasons: the filename wants
   * its name, and a run belonging to another tenant must 404 rather than stream an empty file.
   * An empty CSV is indistinguishable from a run with no results, which would make a permission
   * boundary look like a data problem.
   */
  const run = await getRun(sql, { orgId: context.org.id, runId });
  if (!run) return new Response("Run not found", { status: 404 });

  const filename = `run-${csvFilenamePart(run.name ?? run.framework ?? "results")}-${runId.slice(0, 8)}.csv`;

  /*
   * The cursor is handed over directly, not wrapped.
   *
   * My first version pumped batches into an array and had a generator poll it. That buffers
   * whatever the database produces faster than the socket drains — the unbounded memory this
   * whole approach exists to avoid, reintroduced one layer up, behind a comment claiming the
   * opposite. Passing the cursor makes the response *pull*: a batch is fetched only once the
   * previous one has been written.
   */
  return csvStreamResponse(
    filename,
    COLUMNS,
    runResultsExportCursor(sql, { orgId: context.org.id, runId }),
  );
}
