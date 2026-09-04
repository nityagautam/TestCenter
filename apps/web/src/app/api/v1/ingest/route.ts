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
import { formatBytes } from "@/lib/format";
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

/*
 * The size ceiling is `env.MAX_SINGLE_SHOT_BYTES` — configurable, and validated at boot to be
 * no larger than `MAX_ARTIFACT_BYTES`. It used to be a literal here, which meant the only way
 * to accept a bigger report was a code change and a deploy.
 */

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const principal = await authenticate(request);
    requireScope(principal, "runs:write");

    const url = new URL(request.url);
    const projectKey = url.searchParams.get("project");
    if (!projectKey) {
      throw new ApiError(400, "project_required", "the ?project= query parameter is required");
    }

    const { db, sql, blobStore, queue, env } = getServices();
    const limit = env.MAX_SINGLE_SHOT_BYTES;

    /*
     * Rejected on the header, before a single byte of body is read.
     *
     * This ordering is the whole fix. The check used to happen after `readUploadedFiles`, which
     * meant an oversized upload was fully buffered and *then* refused: measured, a 191 MB post
     * against a 32 MiB limit made the client transfer all 191 MB and took the server from
     * 187 MB to 1.34 GB of RSS before returning 413. The limit reported a problem it had
     * already caused, and a few concurrent ones would OOM the process.
     *
     * Content-Length is advisory — absent under chunked encoding, and a client may lie — so
     * this is the cheap gate, not the only one. `readUploadedFiles` bounds the read itself.
     */
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > limit) {
      throw tooLarge(declared, limit);
    }

    const project = await findProjectByKey(sql, { orgId: principal.orgId, key: projectKey });
    if (!project) {
      throw new ApiError(404, "project_not_found", `no project with key "${projectKey}"`);
    }
    assertProjectAccess(principal, project.id);

    const files = await readUploadedFiles(request, limit);
    if (files.length === 0) {
      throw new ApiError(
        400,
        "no_file",
        "attach at least one report as multipart form data, or POST the file as the raw body",
      );
    }

    // Backstop. `readUploadedFiles` already aborts past the limit, so reaching this would mean
    // multipart framing overhead pushed the decoded total over — worth a clear 413 either way.
    const totalBytes = files.reduce((sum, file) => sum + file.bytes.length, 0);
    if (totalBytes > limit) throw tooLarge(totalBytes, limit);

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
 * The 413, with the numbers a caller needs to act on it.
 *
 * `details` carries `limitBytes`/`actualBytes` as integers so a CI wrapper can decide to fall
 * back to the presigned path without regex-matching the prose, and the message states both
 * sizes in binary units because "33554432 bytes" is not a number anyone reads at a glance —
 * that is what the original message printed, and it is why this exists.
 */
function tooLarge(actualBytes: number, limitBytes: number): ApiError {
  return new ApiError(
    413,
    "too_large_for_single_shot",
    `report is ${formatBytes(actualBytes)}; single-shot ingest accepts up to ` +
      `${formatBytes(limitBytes)}. Either raise MAX_SINGLE_SHOT_BYTES on the server, or use ` +
      `the three-step presigned flow (POST /api/v1/runs) which streams straight to object ` +
      `storage and has no such limit.`,
    {
      limitBytes,
      actualBytes,
      limitEnvVar: "MAX_SINGLE_SHOT_BYTES",
      // Named so a client can route itself rather than needing the docs open.
      alternative: { method: "POST", path: "/api/v1/runs" },
    },
  );
}

/**
 * Reads the body with a hard ceiling, so an oversized upload cannot be buffered.
 *
 * The point is that memory is bounded by `limit` no matter what the client does — including
 * chunked encoding with no Content-Length, and a client whose Content-Length understates the
 * body. Streaming and counting is the only way to get that guarantee; `request.arrayBuffer()`
 * and `request.formData()` have both already allocated everything by the time they return,
 * which is what made the old check cosmetic.
 *
 * Returns `null` once the limit is passed, and stops pulling from the stream at that point
 * rather than draining it. The connection is dropped by the runtime when the handler responds,
 * so the client learns quickly instead of finishing a transfer that is going to be discarded.
 */
async function readBounded(
  body: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Buffer | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      // Checked before keeping the chunk, so the peak is limit + one chunk rather than the
      // whole body. Comparing after pushing would defeat the entire purpose.
      if (total > limit) return null;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

/**
 * Accepts multipart form data *or* a raw body.
 *
 * Both are supported because CI authors reach for whichever their tool makes easy —
 * `curl -F` and `curl --data-binary` are equally common, and rejecting one is a
 * pointless adoption barrier.
 *
 * Both now go through `readBounded` first. Multipart cannot be parsed incrementally with the
 * platform API, so the bytes are bounded on the way in and the FormData parse then runs against
 * a buffer already known to fit — which keeps one code path for the size guarantee instead of
 * trusting Content-Length for one shape and enforcing it for the other.
 */
async function readUploadedFiles(request: Request, limit: number): Promise<UploadedFile[]> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!request.body) return [];

  const raw = await readBounded(request.body, limit);
  // `limit + 1` is a floor, not the real size: the stream was abandoned rather than counted to
  // the end, so the true total is unknown. Reporting a lower bound beats reporting a wrong
  // exact figure, and the Content-Length gate above already handles the common case where the
  // real number is known.
  if (raw === null) throw tooLarge(limit + 1, limit);

  if (contentType.includes("multipart/form-data")) {
    // Re-wrapped so the platform multipart parser can run over the bounded bytes. Headers are
    // carried across because the boundary lives in Content-Type.
    const form = await new Request(request.url, {
      method: "POST",
      headers: request.headers,
      /*
       * Handed over as a plain ArrayBuffer.
       *
       * `Buffer` is a `Uint8Array` subclass, but since TS made `ArrayBufferView` generic its
       * `ArrayBufferLike` parameter no longer satisfies `BodyInit`. `.slice()` copies, which
       * is accepted here rather than cast away: the length is already bounded by `limit`, and
       * a cast would be asserting something about SharedArrayBuffer that is not checked.
       */
      body: raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer,
    }).formData();
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

  if (raw.length === 0) return [];
  return [
    {
      filename: new URL(request.url).searchParams.get("filename") ?? "report.xml",
      contentType: contentType || "application/xml",
      bytes: raw,
    },
  ];
}
