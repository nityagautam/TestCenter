import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { QUEUES, type IngestJobPayload } from "@testcenter/core";
import { schema } from "@testcenter/db";
import {
  ApiError,
  apiErrorResponse,
  assertProjectAccess,
  authenticate,
  requireScope,
} from "@/lib/api-auth";
import { getServices } from "@/lib/services";

/**
 * Marks a run's uploads finished and queues parsing.
 *
 * Verifying that each artifact actually landed in object storage is the point of
 * this step. Without it, a CI job whose upload silently failed would leave a run
 * stuck in "pending" with no explanation — the most confusing possible outcome for
 * whoever looks at the dashboard next.
 */
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<NextResponse> {
  try {
    const principal = await authenticate(request);
    requireScope(principal, "runs:write");
    const { runId } = await params;

    const { db, blobStore, queue } = getServices();

    const runs = await db
      .select({
        id: schema.runs.id,
        orgId: schema.runs.orgId,
        projectId: schema.runs.projectId,
        status: schema.runs.status,
      })
      .from(schema.runs)
      .where(and(eq(schema.runs.id, runId), eq(schema.runs.orgId, principal.orgId)))
      .limit(1);

    const run = runs[0];
    if (!run) throw new ApiError(404, "run_not_found", "run does not exist");
    assertProjectAccess(principal, run.projectId);

    const artifacts = await db
      .select({
        id: schema.artifacts.id,
        filename: schema.artifacts.filename,
        storageKey: schema.artifacts.storageKey,
        uploadedAt: schema.artifacts.uploadedAt,
      })
      .from(schema.artifacts)
      .where(eq(schema.artifacts.runId, runId));

    if (artifacts.length === 0) {
      throw new ApiError(400, "no_artifacts", "run has no artifacts to parse");
    }

    const missing: string[] = [];
    const ready: typeof artifacts = [];

    for (const artifact of artifacts) {
      const metadata = await blobStore.head(artifact.storageKey);
      if (!metadata || metadata.bytes === 0) {
        missing.push(artifact.filename);
        continue;
      }
      // Size and checksum are recorded now so a later re-parse can verify the
      // artifact is byte-identical to what produced the current results.
      await db
        .update(schema.artifacts)
        .set({ bytes: metadata.bytes, uploadedAt: artifact.uploadedAt ?? new Date() })
        .where(eq(schema.artifacts.id, artifact.id));
      ready.push(artifact);
    }

    if (ready.length === 0) {
      throw new ApiError(
        400,
        "uploads_missing",
        `no uploaded content found for: ${missing.join(", ")}`,
      );
    }

    await db.update(schema.runs).set({ status: "parsing" }).where(eq(schema.runs.id, runId));

    for (const artifact of ready) {
      await db
        .insert(schema.ingestJobs)
        .values({
          orgId: run.orgId,
          projectId: run.projectId,
          artifactId: artifact.id,
          runId,
          state: "queued",
          stage: "detect",
        })
        .onConflictDoNothing();

      await queue.enqueue<IngestJobPayload>(
        QUEUES.ingest,
        "parse-artifact",
        {
          artifactId: artifact.id,
          runId,
          projectId: run.projectId,
          orgId: run.orgId,
          storageKey: artifact.storageKey,
        },
        {
          // Deduplicates on the artifact: a retried /complete call must not enqueue
          // the same parse twice.
          jobId: `ingest-${artifact.id}`,
          attempts: 3,
          backoff: { type: "exponential", delayMs: 2000 },
        },
      );
    }

    return NextResponse.json({
      runId,
      status: "parsing",
      queued: ready.length,
      ...(missing.length > 0 ? { missingUploads: missing } : {}),
      eventsUrl: `/api/v1/runs/${runId}/events`,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
