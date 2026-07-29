import { NextResponse } from "next/server";
import { listProjects, requireOrgAccess, searchTests } from "@testcenter/db";
import { ApiError, apiErrorResponse } from "@/lib/api-auth";
import { getServices } from "@/lib/services";
import { currentViewer } from "@/lib/viewer";

/**
 * Search behind the command palette.
 *
 * Tests are searched server-side rather than shipped to the client and filtered there:
 * an organisation can hold tens of thousands of test identities, and the whole point of
 * the trigram index is that Postgres does this in milliseconds. Projects come back too
 * so one keystroke can reach either.
 *
 * The org arrives as a query parameter and is then *proved* through requireOrgAccess —
 * a slug in a URL is a request, not an authorisation.
 */
export const dynamic = "force-dynamic";

const MAX_TESTS = 8;
const MAX_PROJECTS = 5;

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const url = new URL(request.url);
    const orgSlug = url.searchParams.get("org");
    const query = (url.searchParams.get("q") ?? "").trim();

    if (!orgSlug) throw new ApiError(400, "org_required", "the ?org= parameter is required");

    const viewer = await currentViewer();
    if (!viewer) throw new ApiError(401, "unauthenticated", "sign-in required");

    const { db, sql } = getServices();
    const context = await requireOrgAccess(db, viewer, orgSlug);

    // An empty query still returns projects, so opening the palette is immediately
    // useful rather than an empty box waiting to be typed into.
    const projects = await listProjects(sql, context.org.id);
    const matchedProjects = (
      query
        ? projects.filter(
            (project) =>
              project.name.toLowerCase().includes(query.toLowerCase()) ||
              project.key.toLowerCase().includes(query.toLowerCase()),
          )
        : projects
    ).slice(0, MAX_PROJECTS);

    // Two characters is the point where trigram matching stops returning almost
    // everything; below it the results are noise and the query is wasted.
    const tests =
      query.length >= 2
        ? (
            await searchTests(
              sql,
              { orgId: context.org.id, query, sort: "recent" },
              { limit: MAX_TESTS },
            )
          ).tests
        : [];

    return NextResponse.json(
      {
        projects: matchedProjects.map((project) => ({
          key: project.key,
          name: project.name,
        })),
        tests: tests.map((test) => ({
          id: test.id,
          name: test.name,
          suite: test.suite,
          projectKey: test.projectKey,
          lastStatus: test.lastStatus,
          flakeScore: Number(test.flakeScore),
        })),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
