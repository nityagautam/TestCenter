import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { logger } from "@testcenter/core";
import { AccessDeniedError, resolveApiToken, schema } from "@testcenter/db";
import { auth } from "@/auth";
import { getServices } from "@/lib/services";

/**
 * API authentication.
 *
 * Two callers with different needs share these routes: CI, which presents a project
 * API token, and the browser, which presents a session cookie. Resolving both to one
 * `Principal` means no route handler has to care which it got, and no route can
 * accidentally support only one.
 */
export type Principal =
  | {
      kind: "token";
      orgId: string;
      tokenId: string;
      /** Non-null restricts the token to a single project. */
      projectId: string | null;
      scopes: string[];
    }
  | {
      kind: "session";
      orgId: string;
      userId: string;
      email: string;
    };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function apiErrorResponse(error: unknown): NextResponse {
  // Authorisation failures come from the db access layer, which knows nothing about
  // HTTP. Mapping them here keeps a denied request from surfacing as a 500 — and a
  // 500 on a permission problem is indistinguishable from a real bug.
  if (error instanceof AccessDeniedError) {
    const status = error.reason === "unauthenticated" ? 401 : 403;
    return NextResponse.json({ error: { code: error.reason, message: error.message } }, { status });
  }
  if (error instanceof ApiError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }
  // Never leak internals to an API caller — but the detail must reach the server
  // log, or a 500 becomes undebuggable from the outside.
  logger.error({ err: error }, "unhandled API error");
  return NextResponse.json(
    { error: { code: "internal_error", message: "internal error" } },
    { status: 500 },
  );
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  // Convenience for curl-based CI snippets that find headers awkward.
  const alternative = request.headers.get("x-testcenter-token");
  return alternative?.trim() || null;
}

/**
 * Resolves the caller, preferring a token so an authenticated browser session
 * cannot silently mask a broken CI token during debugging.
 */
export async function authenticate(request: Request): Promise<Principal> {
  const { db } = getServices();

  const token = bearerToken(request);
  if (token) {
    const resolved = await resolveApiToken(db, token);
    if (!resolved)
      throw new ApiError(401, "invalid_token", "API token is invalid, expired or revoked");

    // Recording use is what makes an unused or leaked token identifiable later.
    await db
      .update(schema.apiTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(schema.apiTokens.id, resolved.tokenId));

    return {
      kind: "token",
      orgId: resolved.orgId,
      tokenId: resolved.tokenId,
      projectId: resolved.projectId,
      scopes: resolved.scopes,
    };
  }

  const session = await auth();
  const email = session?.user?.email;
  if (!email) throw new ApiError(401, "unauthenticated", "authentication required");

  const users = await db
    .select({ id: schema.users.id, email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.email, email.toLowerCase()))
    .limit(1);
  const user = users[0];
  if (!user) throw new ApiError(401, "unknown_user", "no account for this session");

  const memberships = await db
    .select({ orgId: schema.memberships.orgId })
    .from(schema.memberships)
    .where(eq(schema.memberships.userId, user.id))
    .limit(1);

  // Single internal org for now (docs/test-center-plan.md §1b): fall back to the
  // only org rather than forcing membership rows to exist before anything works.
  let orgId = memberships[0]?.orgId;
  if (!orgId) {
    const orgs = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .limit(1);
    orgId = orgs[0]?.id;
  }
  if (!orgId) throw new ApiError(403, "no_organization", "no organization is provisioned");

  return { kind: "session", orgId, userId: user.id, email: user.email };
}

export function requireScope(principal: Principal, scope: string): void {
  if (principal.kind === "session") return; // session permissions are role-based
  if (!principal.scopes.includes(scope)) {
    throw new ApiError(403, "insufficient_scope", `token is missing the "${scope}" scope`);
  }
}

/** A project-scoped token must not write into a different project. */
export function assertProjectAccess(principal: Principal, projectId: string): void {
  if (principal.kind === "token" && principal.projectId && principal.projectId !== projectId) {
    throw new ApiError(403, "project_forbidden", "token is not valid for this project");
  }
}

/**
 * Idempotency.
 *
 * CI retries uploads far more often than expected — a network blip during a
 * multi-hundred-megabyte upload, a re-run of a failed job, an at-least-once webhook.
 * Without this, each retry creates a duplicate run and the same nightly appears
 * three times. The request body is hashed alongside the key so reusing a key with
 * different content is reported rather than silently returning the wrong response.
 */
export interface IdempotencyHit {
  status: number;
  body: unknown;
}

export async function checkIdempotency(
  orgId: string,
  key: string | null,
  requestBody: string,
): Promise<IdempotencyHit | null> {
  if (!key) return null;
  const { sql } = getServices();
  const hash = createHash("sha256").update(requestBody).digest();

  const rows = await sql<{ request_hash: Buffer; response: unknown; status_code: number }[]>`
    SELECT request_hash, response, status_code
    FROM idempotency_keys
    WHERE org_id = ${orgId} AND key = ${key}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;

  const stored = Buffer.from(row.request_hash);
  const matches = stored.length === hash.length && timingSafeEqual(stored, hash);
  if (!matches) {
    throw new ApiError(
      409,
      "idempotency_key_reused",
      "this Idempotency-Key was already used with a different request body",
    );
  }

  return { status: row.status_code, body: row.response };
}

export async function recordIdempotency(
  orgId: string,
  key: string | null,
  requestBody: string,
  response: { status: number; body: unknown },
): Promise<void> {
  if (!key) return;
  const { sql } = getServices();
  const hash = createHash("sha256").update(requestBody).digest();
  await sql`
    INSERT INTO idempotency_keys (org_id, key, request_hash, response, status_code)
    VALUES (${orgId}, ${key}, ${hash}, ${sql.json(response.body as never)}, ${response.status})
    ON CONFLICT (org_id, key) DO NOTHING
  `;
}
