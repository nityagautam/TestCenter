import { NextResponse } from "next/server";
import { MAX_RUN_NAME_LENGTH } from "@testcenter/core";
import { requireCapability, requireOrgAccess, updateRunName } from "@testcenter/db";
import { ApiError, apiErrorResponse } from "@/lib/api-auth";
import { getServices } from "@/lib/services";
import { currentViewer } from "@/lib/viewer";

/**
 * Rename a run. Admin and above.
 *
 * A separate route from the tag PATCH on purpose: that one authenticates CI tokens by
 * scope, and a CI token must not be able to rename runs — the whole point of the
 * restriction is that a name is shared identity, changed by a person who is accountable
 * for it. So this takes a session viewer, proves the organisation via requireOrgAccess
 * (a run id alone is not authority to modify it), then checks `run:rename`.
 *
 * `updateRunName` is additionally scoped by org_id, so a mismatched org/run pair updates
 * nothing rather than the wrong row.
 */
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<NextResponse> {
  try {
    const { runId } = await params;

    const body = (await request.json().catch(() => null)) as {
      orgSlug?: string;
      name?: unknown;
    } | null;

    if (!body?.orgSlug) {
      throw new ApiError(400, "org_required", "orgSlug is required");
    }
    if (body.name !== null && typeof body.name !== "string") {
      throw new ApiError(400, "invalid_name", "name must be a string, or null to clear it");
    }

    // Trimmed, and an empty result becomes NULL so the framework-name fallback applies
    // rather than the heading rendering blank.
    const trimmed = typeof body.name === "string" ? body.name.trim() : "";
    const name = trimmed.length > 0 ? trimmed : null;

    if (name && name.length > MAX_RUN_NAME_LENGTH) {
      throw new ApiError(
        422,
        "name_too_long",
        `name must be ${MAX_RUN_NAME_LENGTH} characters or fewer`,
      );
    }

    const viewer = await currentViewer();
    if (!viewer) throw new ApiError(401, "unauthenticated", "sign-in required");

    const { db, sql } = getServices();
    const context = await requireOrgAccess(db, viewer, body.orgSlug);
    requireCapability(context, "run:rename");

    const updated = await updateRunName(sql, { orgId: context.org.id, runId, name });
    if (!updated) {
      throw new ApiError(404, "run_not_found", "run does not exist in this organisation");
    }

    return NextResponse.json({ runId, name });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
