import { NextResponse } from "next/server";
import { failureTriageSchema, MAX_VERDICT_NOTE_LENGTH } from "@testcenter/core";
import { addFailureTriage, requireCapability, requireOrgAccess } from "@testcenter/db";
import { ApiError, apiErrorResponse } from "@/lib/api-auth";
import { getServices } from "@/lib/services";
import { currentViewer } from "@/lib/viewer";

/**
 * Categorise a failure cause. Admin and above.
 *
 * A session viewer rather than `authenticate`, so a CI token cannot do it — the same reasoning
 * as the verdict, rename and delete routes. This one is arguably the strongest of them: a
 * verdict speaks for one run, while a triage speaks for a *signature* and is therefore inherited
 * by every future occurrence of that cause, in tests nobody has looked at yet.
 *
 * POST only, never PATCH or PUT. `failure_triage` is append-only, so correcting a category means
 * recording a new one and leaving the previous claim and its author readable — a developer may
 * have already acted on it.
 */
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ signature: string }> },
): Promise<NextResponse> {
  try {
    const { signature } = await params;

    /*
     * Validated as hex before it reaches SQL, where it becomes `decode($1, 'hex')`.
     * Postgres raises on malformed hex, which would surface as a 500 for what is really a bad
     * request — and the length is fixed because the digest is sha256.
     */
    if (!/^[0-9a-f]{64}$/.test(signature)) {
      throw new ApiError(
        400,
        "invalid_signature",
        "signature must be a 64-character lowercase hex sha256 digest",
      );
    }

    const body = (await request.json().catch(() => null)) as {
      orgSlug?: string;
      projectId?: string;
      category?: unknown;
      note?: unknown;
      title?: unknown;
      sampleMessage?: unknown;
      signatureVersion?: unknown;
    } | null;

    if (!body?.orgSlug) throw new ApiError(400, "org_required", "orgSlug is required");
    if (!body.projectId) throw new ApiError(400, "project_required", "projectId is required");

    const parsed = failureTriageSchema.safeParse(body.category);
    if (!parsed.success) {
      throw new ApiError(
        422,
        "invalid_category",
        `category must be one of: ${failureTriageSchema.options.join(", ")}`,
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

    /*
     * The label is supplied by the caller and stored, because it has to outlive the failures it
     * describes: `test_results` is retention-bound, so deriving the title at read time would
     * eventually leave a category attached to a bare hex digest. Falling back to the digest
     * prefix rather than rejecting keeps the endpoint usable when a caller has only the id.
     */
    const title =
      typeof body.title === "string" && body.title.trim().length > 0
        ? body.title.trim().slice(0, 200)
        : `Signature ${signature.slice(0, 12)}`;
    const sampleMessage =
      typeof body.sampleMessage === "string" ? body.sampleMessage.slice(0, 2_000) : null;
    // Recorded so a FAILURE_SIGNATURE_VERSION bump makes stale triage detectable rather than
    // silently non-matching. Defaults to the current algorithm when a caller omits it.
    const signatureVersion =
      typeof body.signatureVersion === "number" && Number.isInteger(body.signatureVersion)
        ? body.signatureVersion
        : 2;

    const viewer = await currentViewer();
    if (!viewer) throw new ApiError(401, "unauthenticated", "sign-in required");

    const { db, sql } = getServices();
    const context = await requireOrgAccess(db, viewer, body.orgSlug);
    requireCapability(context, "failure:triage");

    const recorded = await addFailureTriage(sql, {
      orgId: context.org.id,
      projectId: body.projectId,
      signatureHex: signature,
      signatureVersion,
      category: parsed.data,
      note: note.length > 0 ? note : null,
      title,
      sampleMessage,
      userId: viewer.userId,
    });

    // Null means the project did not belong to this org — a 404 rather than a 403, so a probe
    // cannot tell "exists elsewhere" from "does not exist".
    if (!recorded) {
      throw new ApiError(404, "project_not_found", "project does not exist in this organisation");
    }

    return NextResponse.json({ triage: recorded }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
