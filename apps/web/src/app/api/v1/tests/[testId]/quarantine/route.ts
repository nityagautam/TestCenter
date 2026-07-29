import { NextResponse } from "next/server";
import { requireOrgAccess, requireCapability, setQuarantine } from "@testcenter/db";
import { ApiError, apiErrorResponse } from "@/lib/api-auth";
import { getServices } from "@/lib/services";
import { currentViewer } from "@/lib/viewer";

/**
 * Quarantine or un-quarantine a test.
 *
 * The org comes from the request body and is then *proved* via requireOrgAccess — the
 * test id alone is not authority to modify it, and `setQuarantine` is additionally
 * scoped by org_id so a mismatched pair updates nothing rather than the wrong row.
 */
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ testId: string }> },
): Promise<NextResponse> {
  try {
    const { testId } = await params;
    const numericId = Number(testId);
    if (!Number.isInteger(numericId)) {
      throw new ApiError(400, "invalid_test_id", "test id must be an integer");
    }

    const body = (await request.json().catch(() => null)) as {
      orgSlug?: string;
      quarantined?: boolean;
      reason?: string;
    } | null;

    if (!body?.orgSlug) {
      throw new ApiError(400, "org_required", "orgSlug is required");
    }

    const viewer = await currentViewer();
    if (!viewer) throw new ApiError(401, "unauthenticated", "sign-in required");

    const { db, sql } = getServices();
    const context = await requireOrgAccess(db, viewer, body.orgSlug);
    requireCapability(context, "run:edit");

    const updated = await setQuarantine(sql, {
      orgId: context.org.id,
      testCaseId: numericId,
      quarantined: body.quarantined === true,
      reason: body.reason,
    });

    if (!updated)
      throw new ApiError(404, "test_not_found", "test does not exist in this organisation");

    return NextResponse.json({ testId: numericId, quarantined: body.quarantined === true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
