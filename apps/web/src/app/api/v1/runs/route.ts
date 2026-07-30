import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  artifactKey,
  ciProviderSchema,
  MAX_RUN_NAME_LENGTH,
  normalizeTags,
  tagsSchema,
} from "@testcenter/core";
import { findProjectByKey, listRuns, schema } from "@testcenter/db";
import {
  ApiError,
  apiErrorResponse,
  assertProjectAccess,
  authenticate,
  checkIdempotency,
  recordIdempotency,
  requireScope,
} from "@/lib/api-auth";
import { getServices } from "@/lib/services";

/**
 * Run intake.
 *
 * `POST` creates the run and hands back presigned upload URLs. The bytes then go
 * **directly** from CI to object storage — an API process must never be in the path
 * of a 300 MB report, because that turns every upload into memory pressure and ties
 * request duration to the client's bandwidth.
 *
 * The three-step shape (create → PUT → complete) also means a failed upload leaves a
 * visible pending run rather than silently nothing.
 */
export const dynamic = "force-dynamic";

const createRunSchema = z.object({
  /** Project key, e.g. "checkout-web". */
  project: z.string().min(1).max(128),
  name: z.string().max(MAX_RUN_NAME_LENGTH).optional(),
  framework: z.string().max(64).optional(),
  environment: z.string().max(128).optional(),
  branch: z.string().max(255).optional(),
  commitSha: z.string().max(64).optional(),
  pullRequest: z.number().int().positive().optional(),
  startedAt: z.coerce.date().optional(),
  ci: z
    .object({
      provider: ciProviderSchema.optional(),
      buildId: z.string().max(255).optional(),
      buildNumber: z.string().max(64).optional(),
      jobName: z.string().max(255).optional(),
      jobUrl: z.string().url().max(2048).optional(),
    })
    .optional(),
  shard: z
    .object({
      groupId: z.string().min(1).max(255),
      index: z.number().int().min(0),
      total: z.number().int().min(1),
    })
    .optional(),
  attempt: z.number().int().min(1).default(1),
  tags: tagsSchema.optional(),
  /** Files to be uploaded; presigned URLs are returned for each. */
  artifacts: z
    .array(
      z.object({
        filename: z.string().min(1).max(512),
        contentType: z.string().max(255).optional(),
        bytes: z.number().int().positive().optional(),
        /** Skips detection when the uploader already knows the format. */
        format: z.string().max(64).optional(),
      }),
    )
    .min(1)
    .max(64),
});

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const principal = await authenticate(request);
    requireScope(principal, "runs:write");

    const rawBody = await request.text();
    const idempotencyKey = request.headers.get("idempotency-key");

    const cached = await checkIdempotency(principal.orgId, idempotencyKey, rawBody);
    if (cached) {
      return NextResponse.json(cached.body, {
        status: cached.status,
        headers: { "idempotent-replay": "true" },
      });
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawBody);
    } catch {
      throw new ApiError(400, "invalid_json", "request body must be JSON");
    }

    const parsed = createRunSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new ApiError(
        422,
        "invalid_request",
        parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; "),
      );
    }
    const input = parsed.data;

    const { sql, db, blobStore, env } = getServices();

    const project = await findProjectByKey(sql, { orgId: principal.orgId, key: input.project });
    if (!project) {
      throw new ApiError(404, "project_not_found", `no project with key "${input.project}"`);
    }
    assertProjectAccess(principal, project.id);

    const declaredBytes = input.artifacts.reduce((sum, a) => sum + (a.bytes ?? 0), 0);
    if (declaredBytes > env.MAX_RUN_BYTES) {
      throw new ApiError(413, "run_too_large", `run exceeds ${env.MAX_RUN_BYTES} bytes`);
    }
    for (const artifact of input.artifacts) {
      if (artifact.bytes && artifact.bytes > env.MAX_ARTIFACT_BYTES) {
        throw new ApiError(
          413,
          "artifact_too_large",
          `"${artifact.filename}" exceeds ${env.MAX_ARTIFACT_BYTES} bytes`,
        );
      }
    }

    // Tags are normalized here rather than trusted: CI supplies them from
    // environment variables where casing and spacing vary run to run.
    const tags = normalizeTags(input.tags ?? {});

    const inserted = await db
      .insert(schema.runs)
      .values({
        orgId: principal.orgId,
        projectId: project.id,
        name: input.name ?? null,
        framework: input.framework ?? null,
        status: "pending",
        startedAt: input.startedAt ?? new Date(),
        environment: input.environment ?? null,
        branch: input.branch ?? null,
        commitSha: input.commitSha ?? null,
        prNumber: input.pullRequest ?? null,
        ciProvider: input.ci?.provider ?? null,
        ciBuildId: input.ci?.buildId ?? null,
        ciBuildNumber: input.ci?.buildNumber ?? null,
        ciJobName: input.ci?.jobName ?? null,
        ciJobUrl: input.ci?.jobUrl ?? null,
        runGroupId: input.shard?.groupId ?? null,
        shardIndex: input.shard?.index ?? null,
        shardTotal: input.shard?.total ?? null,
        attempt: input.attempt,
        tags,
        ...(principal.kind === "session"
          ? { createdByUserId: principal.userId }
          : { createdByTokenId: principal.tokenId }),
      })
      .returning({ id: schema.runs.id });

    const runId = inserted[0]?.id;
    if (!runId) throw new ApiError(500, "run_not_created", "failed to create run");

    const uploads = [];
    for (const artifact of input.artifacts) {
      const artifactId = randomUUID();
      const key = artifactKey({
        orgId: principal.orgId,
        projectId: project.id,
        runId,
        artifactId,
        filename: artifact.filename,
      });

      await db.insert(schema.artifacts).values({
        id: artifactId,
        orgId: principal.orgId,
        projectId: project.id,
        runId,
        filename: artifact.filename,
        storageKey: key,
        bytes: artifact.bytes ?? null,
        contentType: artifact.contentType ?? "application/xml",
        declaredFormat: artifact.format ?? null,
      });

      const presigned = await blobStore.createUploadUrl({
        key,
        ...(artifact.contentType ? { contentType: artifact.contentType } : {}),
      });

      uploads.push({
        artifactId,
        filename: artifact.filename,
        uploadUrl: presigned.url,
        method: presigned.method,
        headers: presigned.headers,
        expiresAt: presigned.expiresAt.toISOString(),
      });
    }

    const body = {
      runId,
      project: { id: project.id, key: project.key },
      status: "pending",
      uploads,
      completeUrl: `/api/v1/runs/${runId}/complete`,
    };

    await recordIdempotency(principal.orgId, idempotencyKey, rawBody, { status: 201, body });
    return NextResponse.json(body, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

const listQuerySchema = z.object({
  project: z.string().optional(),
  branch: z.string().optional(),
  environment: z.string().optional(),
  framework: z.string().optional(),
  status: z.string().optional(),
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const principal = await authenticate(request);
    const url = new URL(request.url);
    const parsed = listQuerySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) throw new ApiError(422, "invalid_query", "invalid query parameters");
    const query = parsed.data;

    const { sql } = getServices();

    let projectId: string | undefined;
    if (query.project) {
      const project = await findProjectByKey(sql, {
        orgId: principal.orgId,
        key: query.project,
      });
      if (!project) throw new ApiError(404, "project_not_found", "unknown project");
      projectId = project.id;
    }

    // Repeated ?tag=key:value pairs, matching the CLI's tag syntax.
    const tags = normalizeTags(
      Object.fromEntries(
        url.searchParams
          .getAll("tag")
          .map((entry) => {
            const match = /^([^:=]+)[:=](.*)$/.exec(entry);
            return match ? [match[1] as string, match[2] as string] : null;
          })
          .filter((pair): pair is [string, string] => pair !== null),
      ),
    );

    const page = await listRuns(
      sql,
      {
        orgId: principal.orgId,
        projectId,
        branch: query.branch,
        environment: query.environment,
        framework: query.framework,
        status: query.status ? query.status.split(",") : undefined,
        search: query.search,
        tags: Object.keys(tags).length > 0 ? tags : undefined,
      },
      {
        limit: query.limit ?? 25,
        cursor: decodeCursor(query.cursor),
      },
    );

    return NextResponse.json({
      runs: page.runs,
      nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Opaque cursor so clients cannot construct one and depend on its shape. */
function encodeCursor(cursor: { startedAt: Date; id: string }): string {
  return Buffer.from(`${cursor.startedAt.toISOString()}|${cursor.id}`).toString("base64url");
}

function decodeCursor(value: string | undefined): { startedAt: Date; id: string } | null {
  if (!value) return null;
  try {
    const [startedAt, id] = Buffer.from(value, "base64url").toString("utf8").split("|");
    if (!startedAt || !id) return null;
    const date = new Date(startedAt);
    if (Number.isNaN(date.getTime())) return null;
    return { startedAt: date, id };
  } catch {
    return null;
  }
}
