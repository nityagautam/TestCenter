import { createHash, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
  artifactKey,
  MAX_RUN_NAME_LENGTH,
  normalizeTags,
  parseTagArgs,
  QUEUES,
  type IngestJobPayload,
} from "@testcenter/core";
import { findProjectByKey, schema } from "@testcenter/db";
import {
  ApiError,
  apiErrorResponse,
  assertProjectAccess,
  authenticate,
  requireScope,
} from "@/lib/api-auth";
import { getServices } from "@/lib/services";

/**
 * Single-shot ingest: create a run, store the report, and queue parsing in one call.
 *
 * This exists because adoption is the real battle. The three-step flow is correct for
 * large reports, but asking a team to write three chained curl calls to try the
 * product guarantees they never do. This endpoint is one command:
 *
 *   curl -X POST "$TC/api/v1/ingest?project=web&branch=main&tag=suite:smoke" \
 *        -H "Authorization: Bearer $TOKEN" \
 *        -F "report=@junit.xml"
 *
 * The trade-off is deliberate and bounded: bytes pass through this process, so the
 * size limit here is far below the presigned path's. Anything large should use
 * /api/v1/runs.
 */
export const dynamic = "force-dynamic";

/** Well below MAX_ARTIFACT_BYTES: this path buffers, the presigned path does not. */
const MAX_SINGLE_SHOT_BYTES = 32 * 1024 * 1024;

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const principal = await authenticate(request);
    requireScope(principal, "runs:write");

    const url = new URL(request.url);
    const projectKey = url.searchParams.get("project");
    if (!projectKey) {
      throw new ApiError(400, "project_required", "the ?project= query parameter is required");
    }

    const { db, sql, blobStore, queue } = getServices();
    const project = await findProjectByKey(sql, { orgId: principal.orgId, key: projectKey });
    if (!project) {
      throw new ApiError(404, "project_not_found", `no project with key "${projectKey}"`);
    }
    assertProjectAccess(principal, project.id);

    const files = await readUploadedFiles(request);
    if (files.length === 0) {
      throw new ApiError(
        400,
        "no_file",
        "attach at least one report as multipart form data, or POST the file as the raw body",
      );
    }

    const totalBytes = files.reduce((sum, file) => sum + file.bytes.length, 0);
    if (totalBytes > MAX_SINGLE_SHOT_BYTES) {
      throw new ApiError(
        413,
        "too_large_for_single_shot",
        `single-shot ingest is limited to ${MAX_SINGLE_SHOT_BYTES} bytes; ` +
          `use POST /api/v1/runs for presigned direct-to-storage upload`,
      );
    }

    // Tags come from repeated ?tag=key:value, which is what the CLI and the curl
    // recipe emit. Normalizing here keeps casing consistent across CI systems.
    const tags = normalizeTags({
      ...parseTagArgs(url.searchParams.getAll("tag")),
      ...(url.searchParams.get("env") ? { env: url.searchParams.get("env") as string } : {}),
      ...(url.searchParams.get("suite") ? { suite: url.searchParams.get("suite") as string } : {}),
    });

    const startedAtParam = url.searchParams.get("startedAt");
    const startedAt = startedAtParam ? new Date(startedAtParam) : new Date();

    /*
     * `?name=` names the run at upload time, so CI does not have to rename it afterwards.
     *
     * Trimmed, and empty becomes null so the read path's `name ?? framework` fallback
     * applies rather than a blank heading. Over-long is rejected rather than truncated:
     * `runs.name` is unbounded `text`, and silently storing a clipped name would leave CI
     * believing it set something it did not.
     */
    const nameParam = url.searchParams.get("name")?.trim();
    if (nameParam && nameParam.length > MAX_RUN_NAME_LENGTH) {
      throw new ApiError(
        422,
        "name_too_long",
        `name must be ${MAX_RUN_NAME_LENGTH} characters or fewer`,
      );
    }

    const inserted = await db
      .insert(schema.runs)
      .values({
        orgId: principal.orgId,
        projectId: project.id,
        name: nameParam || null,
        framework: url.searchParams.get("framework"),
        status: "parsing",
        startedAt: Number.isNaN(startedAt.getTime()) ? new Date() : startedAt,
        environment: url.searchParams.get("environment") ?? url.searchParams.get("env"),
        branch: url.searchParams.get("branch"),
        commitSha: url.searchParams.get("commit") ?? url.searchParams.get("commitSha"),
        ciProvider: url.searchParams.get("ciProvider"),
        ciBuildId: url.searchParams.get("buildId"),
        ciJobUrl: url.searchParams.get("jobUrl"),
        tags,
        ...(principal.kind === "session"
          ? { createdByUserId: principal.userId }
          : { createdByTokenId: principal.tokenId }),
      })
      .returning({ id: schema.runs.id });

    const runId = inserted[0]?.id;
    if (!runId) throw new ApiError(500, "run_not_created", "failed to create run");

    const queued: string[] = [];
    for (const file of files) {
      const artifactId = randomUUID();
      const key = artifactKey({
        orgId: principal.orgId,
        projectId: project.id,
        runId,
        artifactId,
        filename: file.filename,
      });

      await blobStore.put(key, file.bytes, { contentType: file.contentType });

      await db.insert(schema.artifacts).values({
        id: artifactId,
        orgId: principal.orgId,
        projectId: project.id,
        runId,
        filename: file.filename,
        storageKey: key,
        bytes: file.bytes.length,
        contentType: file.contentType,
        sha256: createHash("sha256").update(file.bytes).digest(),
        uploadedAt: new Date(),
      });

      await db
        .insert(schema.ingestJobs)
        .values({
          orgId: principal.orgId,
          projectId: project.id,
          artifactId,
          runId,
          state: "queued",
          stage: "detect",
        })
        .onConflictDoNothing();

      await queue.enqueue<IngestJobPayload>(
        QUEUES.ingest,
        "parse-artifact",
        {
          artifactId,
          runId,
          projectId: project.id,
          orgId: principal.orgId,
          storageKey: key,
        },
        { jobId: `ingest-${artifactId}`, attempts: 3 },
      );
      queued.push(file.filename);
    }

    return NextResponse.json(
      {
        runId,
        project: { id: project.id, key: project.key },
        status: "parsing",
        artifacts: queued,
        tags,
        runUrl: `/runs/${runId}`,
        eventsUrl: `/api/v1/runs/${runId}/events`,
      },
      { status: 202 },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}

interface UploadedFile {
  filename: string;
  contentType: string;
  bytes: Buffer;
}

/**
 * Accepts multipart form data *or* a raw body.
 *
 * Both are supported because CI authors reach for whichever their tool makes easy —
 * `curl -F` and `curl --data-binary` are equally common, and rejecting one is a
 * pointless adoption barrier.
 */
async function readUploadedFiles(request: Request): Promise<UploadedFile[]> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const files: UploadedFile[] = [];
    for (const [, value] of form.entries()) {
      if (typeof value === "string") continue;
      files.push({
        filename: value.name || "report.xml",
        contentType: value.type || "application/xml",
        bytes: Buffer.from(await value.arrayBuffer()),
      });
    }
    return files;
  }

  const raw = Buffer.from(await request.arrayBuffer());
  if (raw.length === 0) return [];
  return [
    {
      filename: new URL(request.url).searchParams.get("filename") ?? "report.xml",
      contentType: contentType || "application/xml",
      bytes: raw,
    },
  ];
}
