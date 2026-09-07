import { NextResponse } from "next/server";
import { getRun, listRunResults, type ResultCursor } from "@testcenter/db";
import { getServices } from "@/lib/services";
import { requirePageContext } from "@/lib/viewer";

/*
 * One page of a run's results, as JSON, for the results overlay.
 *
 * Inside the org segment rather than under `/api/v1`, matching the CSV export beside it: this is
 * read by a browser on behalf of a signed-in reader, so it authorises through the session like
 * every other page in this segment. `/api/v1` is the token-authenticated machine surface and
 * already exposes run results for that audience.
 *
 * It calls the same `listRunResults` the run page renders from. That is deliberate rather than
 * convenient: two paths answering "what is in this run" is how a header ends up disagreeing with
 * the page it links to, which happened in this codebase and took a while to notice.
 */
export const dynamic = "force-dynamic";

/** Small, because paging inside an overlay should be rare rather than constant. */
const PAGE_SIZE = 25;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ orgSlug: string; runId: string }> },
): Promise<NextResponse> {
  const { orgSlug, runId } = await params;
  const context = await requirePageContext(orgSlug);
  const { sql } = getServices();

  /*
   * The run is resolved in the organisation first. `listRunResults` now takes an `orgId` of its
   * own, so this is belt and braces — but it is also what turns another tenant's run id into a
   * 404 rather than an empty page, and an empty page is indistinguishable from a run with no
   * results.
   */
  const run = await getRun(sql, { orgId: context.org.id, runId });
  if (!run) {
    return NextResponse.json({ error: "run not found" }, { status: 404 });
  }

  /*
   * The cursor arrives as JSON from the client, so every field is parsed and bounded rather than
   * trusted. It only ever reaches SQL as three bound numbers, so a malformed one is a bad page
   * rather than an injection — but `Number(undefined)` is `NaN`, and `NaN` in a row comparison
   * silently matches nothing, which would read as "this run is empty".
   */
  const raw = new URL(request.url).searchParams.get("cursor");
  let cursor: ResultCursor | null = null;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<ResultCursor>;
      const statusRank = Number(parsed.statusRank);
      const durationMs = Number(parsed.durationMs);
      const id = Number(parsed.id);
      if (Number.isFinite(statusRank) && Number.isFinite(durationMs) && Number.isFinite(id)) {
        cursor = { statusRank, durationMs, id };
      }
    } catch {
      // An unparseable cursor is treated as no cursor: the reader gets the first page, which is
      // recoverable, rather than a 400 they cannot act on.
    }
  }

  const page = await listRunResults(
    sql,
    { orgId: context.org.id, runId },
    { limit: PAGE_SIZE, cursor },
  );

  return NextResponse.json(
    {
      results: page.results,
      nextCursor: page.nextCursor,
      total: page.total,
      pageSize: PAGE_SIZE,
      run: { id: run.id, name: run.name, framework: run.framework, status: run.status },
    },
    // Tenant data resolved from a session cookie: a shared cache keyed on the URL alone would
    // serve one organisation's results to the next reader of the same path.
    { headers: { "cache-control": "no-store" } },
  );
}
