import { createHash, randomBytes } from "node:crypto";
import { eq, and, isNull } from "drizzle-orm";
import type { Database } from "./client.js";
import * as schema from "./schema.js";

/**
 * Idempotent bootstrap: gives a fresh database the one org and project needed for
 * a first upload, so `pnpm db:migrate && pnpm dev` is immediately usable rather
 * than requiring manual SQL before anything works.
 */
export interface BootstrapOptions {
  orgSlug?: string;
  orgName?: string;
  projectKey?: string;
  projectName?: string;
}

export interface BootstrapResult {
  orgId: string;
  projectId: string;
  created: { org: boolean; project: boolean };
}

export async function bootstrap(
  db: Database,
  options: BootstrapOptions = {},
): Promise<BootstrapResult> {
  const orgSlug = options.orgSlug ?? process.env.TESTCENTER_DEFAULT_ORG_SLUG ?? "default";
  const orgName = options.orgName ?? process.env.TESTCENTER_DEFAULT_ORG_NAME ?? "Default";
  const projectKey = options.projectKey ?? "demo";
  const projectName = options.projectName ?? "Demo Project";

  const existingOrg = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(eq(schema.organizations.slug, orgSlug))
    .limit(1);

  let orgId = existingOrg[0]?.id;
  const createdOrg = !orgId;
  if (!orgId) {
    const inserted = await db
      .insert(schema.organizations)
      .values({ slug: orgSlug, name: orgName })
      .returning({ id: schema.organizations.id });
    orgId = inserted[0]?.id;
    if (!orgId) throw new Error("failed to create organization");
  }

  const existingProject = await db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(and(eq(schema.projects.orgId, orgId), eq(schema.projects.key, projectKey)))
    .limit(1);

  let projectId = existingProject[0]?.id;
  const createdProject = !projectId;
  if (!projectId) {
    const inserted = await db
      .insert(schema.projects)
      .values({ orgId, key: projectKey, name: projectName })
      .returning({ id: schema.projects.id });
    projectId = inserted[0]?.id;
    if (!projectId) throw new Error("failed to create project");
  }

  return { orgId, projectId, created: { org: createdOrg, project: createdProject } };
}

/**
 * API tokens.
 *
 * The plaintext is returned once and never stored — only a sha256 of it. A
 * readable prefix is kept so a token can be identified in the UI and in audit
 * logs without being reversible.
 */
export const TOKEN_PREFIX = "tc_";

export interface GeneratedToken {
  /** Show once, at creation. */
  plaintext: string;
  hash: Buffer;
  prefix: string;
}

export function generateApiToken(): GeneratedToken {
  const secret = randomBytes(32).toString("base64url");
  const plaintext = `${TOKEN_PREFIX}${secret}`;
  return {
    plaintext,
    hash: hashApiToken(plaintext),
    prefix: plaintext.slice(0, TOKEN_PREFIX.length + 6),
  };
}

export function hashApiToken(plaintext: string): Buffer {
  return createHash("sha256").update(plaintext, "utf8").digest();
}

export interface ResolvedToken {
  tokenId: string;
  orgId: string;
  projectId: string | null;
  scopes: string[];
}

/**
 * Looks a token up by hash. Revocation and expiry are checked here rather than at
 * call sites so a forgotten check cannot become an auth bypass.
 */
export async function resolveApiToken(
  db: Database,
  plaintext: string,
  now = new Date(),
): Promise<ResolvedToken | null> {
  if (!plaintext.startsWith(TOKEN_PREFIX)) return null;
  const rows = await db
    .select({
      tokenId: schema.apiTokens.id,
      orgId: schema.apiTokens.orgId,
      projectId: schema.apiTokens.projectId,
      scopes: schema.apiTokens.scopes,
      expiresAt: schema.apiTokens.expiresAt,
    })
    .from(schema.apiTokens)
    .where(
      and(
        eq(schema.apiTokens.tokenHash, hashApiToken(plaintext)),
        isNull(schema.apiTokens.revokedAt),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.expiresAt && row.expiresAt <= now) return null;

  return {
    tokenId: row.tokenId,
    orgId: row.orgId,
    projectId: row.projectId,
    scopes: row.scopes,
  };
}
