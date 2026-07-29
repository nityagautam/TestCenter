import { NextResponse } from "next/server";
import { normalizeTags, tagsSchema } from "@testcenter/core";
import { getRun, listRunResults, summarizeRunSuites, updateRunTags } from "@testcenter/db";
import { ApiError, apiErrorResponse, authenticate, requireScope } from "@/lib/api-auth";
import { getServices } from "@/lib/services";

/**
 * Run detail.
 *
 * Results are paginated and their heavy fields (stack trace, captured output) are
 * excluded — a 50k-result run must not serialize megabytes of text into a response
 * nobody scrolls through. The individual result endpoint fetches those on demand.
 */
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<NextResponse> {
  try {
    const principal = await authenticate(request);
    const { runId } = await params;
    const { sql } = getServices();

    const run = await getRun(sql, { orgId: principal.orgId, runId });
    if (!run) throw new ApiError(404, "run_not_found", "run does not exist");

    const url = new URL(request.url);
    const includeResults = url.searchParams.get("results") !== "false";

    if (!includeResults) {
      return NextResponse.json({ run });
    }

    const statusParam = url.searchParams.get("status");
    const page = await listRunResults(
      sql,
      {
        runId,
        status: statusParam ? statusParam.split(",") : undefined,
        suite: url.searchParams.get("suite") ?? undefined,
        search: url.searchParams.get("search") ?? undefined,
        onlyFlaky: url.searchParams.get("flaky") === "true",
      },
      { limit: Number(url.searchParams.get("limit") ?? 100) },
    );

    const suites =
      url.searchParams.get("suites") === "true" ? await summarizeRunSuites(sql, runId) : undefined;

    return NextResponse.json({
      run,
      results: page.results,
      nextCursor: page.nextCursor,
      ...(suites ? { suites } : {}),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/**
 * Tag editing after the fact.
 *
 * Tags are frequently wrong on first upload — a CI variable was unset, or a team
 * realises later that it wants to slice by release. Making them immutable would push
 * people to re-upload the run, so they are editable and the run keeps its results.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<NextResponse> {
  try {
    const principal = await authenticate(request);
    requireScope(principal, "runs:write");
    const { runId } = await params;

    const body: unknown = await request.json().catch(() => {
      throw new ApiError(400, "invalid_json", "request body must be JSON");
    });

    const parsed = tagsSchema.safeParse(
      normalizeTags((body as { tags?: Record<string, unknown> })?.tags ?? {}),
    );
    if (!parsed.success) {
      throw new ApiError(
        422,
        "invalid_tags",
        parsed.error.issues.map((issue) => issue.message).join("; "),
      );
    }

    const { sql } = getServices();
    const updated = await updateRunTags(sql, {
      orgId: principal.orgId,
      runId,
      tags: parsed.data,
    });
    if (!updated) throw new ApiError(404, "run_not_found", "run does not exist");

    return NextResponse.json({ runId, tags: parsed.data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
