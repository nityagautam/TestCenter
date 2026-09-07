import { NextResponse } from "next/server";
import { requireOrgAccess } from "@testcenter/db";
import { apiErrorResponse, ApiError } from "@/lib/api-auth";
import { getServices } from "@/lib/services";
import { currentViewer } from "@/lib/viewer";

/**
 * A change token: has anything arrived since the caller last looked?
 *
 * This exists so auto-refresh does not have to be a timer. A timer re-renders the page whether or
 * not anything happened — it spends a full server render on every tick, and it moves the page
 * under somebody who is reading it for no reason. Polling one cheap token and refreshing only when
 * it changes turns "every 30 seconds" into "when there is something to see", which is what the
 * reader actually asked for.
 *
 * The token deliberately carries no data. It is a comparison value, so the client never has to
 * decide what counts as a meaningful change, and this endpoint never becomes a second, weaker copy
 * of the dashboard queries.
 *
 * Cheap by construction: a count and a max over an index, no joins, no rollups, nothing scanned.
 * It is the one endpoint in the app designed to be called on a schedule, and it is sized for that.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const url = new URL(request.url);
    const orgSlug = url.searchParams.get("org");
    if (!orgSlug) throw new ApiError(400, "org_required", "org is required");
    const projectKey = url.searchParams.get("project");

    /*
     * Session auth, not a bearer token. This is polled by a browser on the viewer's behalf, and a
     * CI token has no reason to ask "is there anything new" — it is the thing making the news.
     */
    const viewer = await currentViewer();
    if (!viewer) throw new ApiError(401, "unauthenticated", "sign-in required");

    const { db, sql } = getServices();
    const context = await requireOrgAccess(db, viewer, orgSlug);

    const [row] = await sql<{ runs: number; latest: Date | null; finished: number }[]>`
      SELECT
        count(*)::int                                   AS runs,
        max(r.started_at)                               AS latest,
        count(*) FILTER (WHERE r.status IN ('complete', 'partial'))::int AS finished
      FROM runs r
      WHERE r.org_id = ${context.org.id}
        ${
          projectKey
            ? sql`AND r.project_id = (
                SELECT id FROM projects
                WHERE org_id = ${context.org.id} AND key = ${projectKey}
              )`
            : sql``
        }
    `;

    /*
     * `finished` is in the token as well as `runs`, and that is the difference between useful and
     * annoying. An upload creates its run row immediately and finishes parsing seconds later, so a
     * token of "how many runs" fires a refresh the instant a report lands — showing a run that is
     * still parsing and has no results yet. Counting completions too means the second refresh,
     * the one that actually has something to show, happens as well.
     */
    const token = [row?.runs ?? 0, row?.finished ?? 0, row?.latest ? row.latest.getTime() : 0].join(
      ".",
    );

    return NextResponse.json(
      { token },
      // Never cached, by any layer. A cached change token is a change token that reports no change.
      { headers: { "cache-control": "no-store, max-age=0" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
