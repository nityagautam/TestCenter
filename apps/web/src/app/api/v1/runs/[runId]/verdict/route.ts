import { NextResponse } from "next/server";
import { MAX_VERDICT_NOTE_LENGTH, runVerdictSchema } from "@testcenter/core";
import { addRunVerdict, requireCapability, requireOrgAccess } from "@testcenter/db";
import { ApiError, apiErrorResponse } from "@/lib/api-auth";
import { getServices } from "@/lib/services";
import { currentViewer } from "@/lib/viewer";

/**
 * Record a verdict on a run. Admin and above.
 *
 * A session viewer rather than `authenticate`, which also accepts CI tokens. A verdict is
 * a *human* judgement — "these failures are environmental, not yours" — and a pipeline has
 * no standing to make it. Same reasoning as rename and delete.
 *
 * POST only, and never PATCH or PUT: the table is append-only, so correcting a verdict
 * means recording a new one. The previous judgement and its author stay readable, which is
 * the whole point of keeping history rather than a column on `runs`.
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
      verdict?: unknown;
      note?: unknown;
    } | null;

    if (!body?.orgSlug) {
      throw new ApiError(400, "org_required", "orgSlug is required");
    }

    const parsed = runVerdictSchema.safeParse(body.verdict);
    if (!parsed.success) {
      throw new ApiError(
        422,
        "invalid_verdict",
        `verdict must be one of: ${runVerdictSchema.options.join(", ")}`,
      );
    }

    if (body.note !== undefined && body.note !== null && typeof body.note !== "string") {
      throw new ApiError(400, "invalid_note", "note must be a string when present");
    }
    const note = typeof body.note === "string" ? body.note.trim() : "";
    if (note.length > MAX_VERDICT_NOTE_LENGTH) {
      throw new ApiError(
        422,
        "note_too_long",
        `note must be ${MAX_VERDICT_NOTE_LENGTH} characters or fewer`,
      );
    }

    const viewer = await currentViewer();
    if (!viewer) throw new ApiError(401, "unauthenticated", "sign-in required");

    const { db, sql } = getServices();
    const context = await requireOrgAccess(db, viewer, body.orgSlug);
    requireCapability(context, "run:verdict");

    const recorded = await addRunVerdict(sql, {
      orgId: context.org.id,
      runId,
      verdict: parsed.data,
      // Empty becomes null rather than "", so "has a note" is a single check downstream.
      note: note.length > 0 ? note : null,
      userId: viewer.userId,
    });

    if (!recorded) {
      throw new ApiError(404, "run_not_found", "run does not exist in this organisation");
    }

    return NextResponse.json({ runId, verdict: recorded.verdict, recordedAt: recorded.createdAt });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
