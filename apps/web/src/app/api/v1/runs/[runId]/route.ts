import { NextResponse } from "next/server";
import { normalizeTags, tagsSchema } from "@testcenter/core";
import {
  deleteRun,
  getRun,
  listRunResults,
  requireCapability,
  requireOrgAccess,
  summarizeRunSuites,
  updateRunTags,
} from "@testcenter/db";
import { ApiError, apiErrorResponse, authenticate, requireScope } from "@/lib/api-auth";
import { getServices } from "@/lib/services";
import { currentViewer } from "@/lib/viewer";

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

/**
 * Permanently delete a run. Admin and above.
 *
 * A session viewer rather than `authenticate`, which also accepts CI tokens: a token
 * leaked from a pipeline log must not be able to destroy history, and no CI system has a
 * reason to. Same reasoning as the rename endpoint, with more at stake.
 *
 * `?orgSlug=` rather than a JSON body — request bodies on DELETE are inconsistently
 * supported by clients and proxies. The slug is then *proved* via requireOrgAccess, and
 * `deleteRun` is additionally scoped by org_id, so a run id from another organisation
 * deletes nothing rather than the wrong row.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<NextResponse> {
  try {
    const { runId } = await params;
    const orgSlug = new URL(request.url).searchParams.get("orgSlug");
    if (!orgSlug) {
      throw new ApiError(400, "org_required", "the ?orgSlug= query parameter is required");
    }

    const viewer = await currentViewer();
    if (!viewer) throw new ApiError(401, "unauthenticated", "sign-in required");

    const { db, sql, blobStore } = getServices();
    const context = await requireOrgAccess(db, viewer, orgSlug);
    requireCapability(context, "run:delete");

    const deleted = await deleteRun(sql, { orgId: context.org.id, runId });
    if (!deleted) {
      throw new ApiError(404, "run_not_found", "run does not exist in this organisation");
    }

    /*
     * After the commit, and never fatal.
     *
     * The run is already gone from the database; failing the request now would tell the
     * caller the deletion did not happen when it did, and a retry would 404. An orphaned
     * blob costs storage, which is the cheaper of the two failures.
     */
    const orphaned: string[] = [];
    for (const key of deleted.storageKeys) {
      try {
        await blobStore.delete(key);
      } catch {
        orphaned.push(key);
      }
    }

    return NextResponse.json({
      runId,
      deleted: true,
      results: deleted.results,
      artifacts: deleted.storageKeys.length,
      ...(orphaned.length > 0 ? { orphanedBlobs: orphaned.length } : {}),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
