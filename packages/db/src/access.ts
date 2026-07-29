import { randomBytes } from "node:crypto";
import { and, eq, isNull, sql as raw } from "drizzle-orm";
import type { Database, Sql } from "./client.js";
import * as schema from "./schema.js";
import type { MembershipRole } from "./schema.js";

/**
 * Access control.
 *
 * Every read and write in the product is scoped to an organisation. Concentrating
 * that decision here — rather than letting each page or route remember to add
 * `WHERE org_id = ...` — is the difference between isolation that holds and
 * isolation that holds until someone forgets. Callers resolve an `AccessContext`
 * once and pass its `orgId` to queries; a caller with no context cannot read
 * anything.
 *
 * Roles are ordered, so a permission check is a comparison rather than a set of
 * hand-maintained lists that drift.
 */
const ROLE_RANK: Record<MembershipRole, number> = {
  viewer: 0,
  member: 1,
  maintainer: 2,
  admin: 3,
  owner: 4,
};

/** What each capability requires. Named so intent is legible at the call site. */
export const CAPABILITIES = {
  "run:read": "viewer",
  "run:upload": "member",
  "run:edit": "member",
  "run:delete": "maintainer",
  "project:create": "maintainer",
  "project:edit": "maintainer",
  "project:delete": "admin",
  "token:manage": "admin",
  "member:manage": "admin",
  "org:edit": "admin",
  "org:delete": "owner",
} as const satisfies Record<string, MembershipRole>;

export type Capability = keyof typeof CAPABILITIES;

export function roleAllows(role: MembershipRole, capability: Capability): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[CAPABILITIES[capability]];
}

export interface AccessibleOrg {
  id: string;
  slug: string;
  name: string;
  role: MembershipRole;
  isPersonal: boolean;
  /** True when access comes from platform-admin status rather than membership. */
  viaPlatformAdmin: boolean;
}

export interface Viewer {
  userId: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  isPlatformAdmin: boolean;
  onboarded: boolean;
}

export class AccessDeniedError extends Error {
  constructor(
    message: string,
    readonly reason: "not_a_member" | "insufficient_role" | "unknown_org" | "unauthenticated",
  ) {
    super(message);
    this.name = "AccessDeniedError";
  }
}

export async function findViewerByEmail(db: Database, email: string): Promise<Viewer | null> {
  const rows = await db
    .select({
      userId: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      avatarUrl: schema.users.avatarUrl,
      isPlatformAdmin: schema.users.isPlatformAdmin,
      onboardedAt: schema.users.onboardedAt,
      status: schema.users.status,
    })
    .from(schema.users)
    .where(eq(schema.users.email, email.toLowerCase()))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  // A disabled account must not resolve to a viewer, or it would keep working.
  if (row.status !== "active") return null;

  return {
    userId: row.userId,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatarUrl,
    isPlatformAdmin: row.isPlatformAdmin,
    onboarded: row.onboardedAt !== null,
  };
}

/**
 * Organisations this user may see, for the header switcher.
 *
 * Platform admins see every organisation; that is the point of the role, and it is
 * how someone grants a new user access to a team they are not themselves in.
 */
export async function listAccessibleOrgs(db: Database, viewer: Viewer): Promise<AccessibleOrg[]> {
  if (viewer.isPlatformAdmin) {
    const all = await db
      .select({
        id: schema.organizations.id,
        slug: schema.organizations.slug,
        name: schema.organizations.name,
        personalForUserId: schema.organizations.personalForUserId,
        role: schema.memberships.role,
      })
      .from(schema.organizations)
      .leftJoin(
        schema.memberships,
        and(
          eq(schema.memberships.orgId, schema.organizations.id),
          eq(schema.memberships.userId, viewer.userId),
          isNull(schema.memberships.teamId),
        ),
      )
      .orderBy(schema.organizations.name);

    return all.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      // A platform admin acts as owner where they have no explicit membership.
      role: row.role ?? "owner",
      isPersonal: row.personalForUserId === viewer.userId,
      viaPlatformAdmin: row.role === null,
    }));
  }

  const rows = await db
    .select({
      id: schema.organizations.id,
      slug: schema.organizations.slug,
      name: schema.organizations.name,
      personalForUserId: schema.organizations.personalForUserId,
      role: schema.memberships.role,
    })
    .from(schema.memberships)
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.memberships.orgId))
    .where(
      and(
        eq(schema.memberships.userId, viewer.userId),
        isNull(schema.memberships.teamId),
        // Pending grants are not access until the account is bound to them.
        raw`${schema.memberships.activatedAt} IS NOT NULL`,
      ),
    )
    .orderBy(schema.organizations.name);

  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    role: row.role,
    isPersonal: row.personalForUserId === viewer.userId,
    viaPlatformAdmin: false,
  }));
}

export interface AccessContext {
  viewer: Viewer;
  org: AccessibleOrg;
}

/**
 * The single gate. Resolves an org by slug *and* proves the viewer may see it.
 *
 * Deliberately takes a slug rather than an id: slugs are what appear in URLs, so
 * this is the boundary a request actually crosses. It throws rather than returning
 * null so a forgotten check fails loudly instead of silently widening access.
 */
export async function requireOrgAccess(
  db: Database,
  viewer: Viewer | null,
  orgSlug: string,
): Promise<AccessContext> {
  if (!viewer) throw new AccessDeniedError("authentication required", "unauthenticated");

  const orgs = await listAccessibleOrgs(db, viewer);
  const org = orgs.find((candidate) => candidate.slug === orgSlug);
  if (!org) {
    // Same error whether the org does not exist or the viewer simply cannot see it:
    // distinguishing them would let anyone enumerate organisation slugs.
    throw new AccessDeniedError(`no access to organisation "${orgSlug}"`, "not_a_member");
  }
  return { viewer, org };
}

export function requireCapability(context: AccessContext, capability: Capability): void {
  if (!roleAllows(context.org.role, capability)) {
    throw new AccessDeniedError(
      `role "${context.org.role}" cannot ${capability}`,
      "insufficient_role",
    );
  }
}

/**
 * Resolves a project within an already-authorised organisation.
 *
 * Takes the org id from the context rather than trusting a caller-supplied one, so
 * a project key from one org can never resolve against another.
 */
export async function requireProject(
  sql: Sql,
  context: AccessContext,
  projectKey: string,
): Promise<{ id: string; key: string; name: string; defaultBranch: string }> {
  const rows = await sql<{ id: string; key: string; name: string; defaultBranch: string }[]>`
    SELECT id, key, name, default_branch AS "defaultBranch"
    FROM projects
    WHERE org_id = ${context.org.id} AND key = ${projectKey} AND archived_at IS NULL
    LIMIT 1
  `;
  const project = rows[0];
  if (!project) {
    throw new AccessDeniedError(`no project "${projectKey}" in this organisation`, "unknown_org");
  }
  return project;
}

// ─── Onboarding and membership management ────────────────────────────────────

function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || "org";
}

/**
 * Creates or updates a user at sign-in, and binds any access granted to their
 * email before the account existed.
 *
 * `adminEmails` comes from configuration, never from the database, so platform
 * admin cannot be escalated from inside the product.
 */
export async function upsertUserOnSignIn(
  db: Database,
  input: {
    email: string;
    name?: string | null;
    avatarUrl?: string | null;
    googleSub?: string | null;
    adminEmails: readonly string[];
  },
): Promise<{ viewer: Viewer; activatedGrants: number }> {
  const email = input.email.toLowerCase();
  const isAdmin = input.adminEmails.map((entry) => entry.toLowerCase()).includes(email);

  const existing = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1);

  if (existing[0]) {
    await db
      .update(schema.users)
      .set({
        name: input.name ?? null,
        avatarUrl: input.avatarUrl ?? null,
        ...(input.googleSub ? { googleSub: input.googleSub } : {}),
        // Admin status is re-asserted from config on every sign-in, so removing an
        // address from the list actually revokes it.
        isPlatformAdmin: isAdmin,
        lastSeenAt: new Date(),
      })
      .where(eq(schema.users.id, existing[0].id));
  } else {
    await db.insert(schema.users).values({
      email,
      name: input.name ?? null,
      avatarUrl: input.avatarUrl ?? null,
      googleSub: input.googleSub ?? null,
      isPlatformAdmin: isAdmin,
      lastSeenAt: new Date(),
    });
  }

  const viewer = await findViewerByEmail(db, email);
  if (!viewer) throw new Error("user disappeared during sign-in");

  const activatedGrants = await activatePendingGrants(db, viewer);
  return { viewer, activatedGrants };
}

/**
 * Binds grants made by email to the now-existing account.
 *
 * This is what lets an administrator grant access to someone who has never signed
 * in — the ergonomics of an invite without needing to send mail.
 */
export async function activatePendingGrants(db: Database, viewer: Viewer): Promise<number> {
  const pending = await db
    .select({ id: schema.memberships.id, orgId: schema.memberships.orgId })
    .from(schema.memberships)
    .where(
      and(
        raw`lower(${schema.memberships.invitedEmail}) = ${viewer.email.toLowerCase()}`,
        isNull(schema.memberships.userId),
      ),
    );

  let activated = 0;
  for (const grant of pending) {
    // A grant may collide with a membership the user already has, e.g. two admins
    // granting the same person. Absorb that rather than failing sign-in.
    const already = await db
      .select({ id: schema.memberships.id })
      .from(schema.memberships)
      .where(
        and(
          eq(schema.memberships.orgId, grant.orgId),
          eq(schema.memberships.userId, viewer.userId),
          isNull(schema.memberships.teamId),
        ),
      )
      .limit(1);

    if (already[0]) {
      await db.delete(schema.memberships).where(eq(schema.memberships.id, grant.id));
      continue;
    }

    await db
      .update(schema.memberships)
      .set({ userId: viewer.userId, invitedEmail: null, activatedAt: new Date() })
      .where(eq(schema.memberships.id, grant.id));
    activated += 1;
  }
  return activated;
}

export interface CreateOrgResult {
  orgId: string;
  slug: string;
}

/**
 * Creates an organisation with the creator as owner.
 *
 * Slug collisions are resolved by suffixing rather than rejecting: a user typing
 * "QA" should not have to guess that the name is taken by an org they cannot see.
 */
export async function createOrganization(
  db: Database,
  input: { name: string; createdBy: Viewer; personal?: boolean },
): Promise<CreateOrgResult> {
  const base = slugify(input.name);
  let slug = base;

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const taken = await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(eq(schema.organizations.slug, slug))
      .limit(1);
    if (!taken[0]) break;
    slug = `${base}-${randomBytes(2).toString("hex")}`;
  }

  const inserted = await db
    .insert(schema.organizations)
    .values({
      slug,
      name: input.name.trim().slice(0, 120),
      createdBy: input.createdBy.userId,
      ...(input.personal ? { personalForUserId: input.createdBy.userId } : {}),
    })
    .returning({ id: schema.organizations.id });

  const orgId = inserted[0]?.id;
  if (!orgId) throw new Error("failed to create organisation");

  await db.insert(schema.memberships).values({
    orgId,
    userId: input.createdBy.userId,
    role: "owner",
    activatedAt: new Date(),
    grantedBy: input.createdBy.userId,
  });

  await db
    .update(schema.users)
    .set({ onboardedAt: new Date() })
    .where(eq(schema.users.id, input.createdBy.userId));

  return { orgId, slug };
}

/** Marks onboarding finished without creating an org (the "skip" path). */
export async function completeOnboarding(db: Database, viewer: Viewer): Promise<void> {
  await db
    .update(schema.users)
    .set({ onboardedAt: new Date() })
    .where(eq(schema.users.id, viewer.userId));
}

export interface OrgMember {
  membershipId: string;
  userId: string | null;
  email: string;
  name: string | null;
  role: MembershipRole;
  pending: boolean;
  lastSeenAt: Date | null;
}

export async function listOrgMembers(sql: Sql, orgId: string): Promise<OrgMember[]> {
  return sql<OrgMember[]>`
    SELECT
      m.id                                        AS "membershipId",
      m.user_id                                   AS "userId",
      COALESCE(u.email, m.invited_email)          AS email,
      u.name,
      m.role,
      (m.user_id IS NULL)                         AS pending,
      u.last_seen_at                              AS "lastSeenAt"
    FROM memberships m
    LEFT JOIN users u ON u.id = m.user_id
    WHERE m.org_id = ${orgId} AND m.team_id IS NULL
    ORDER BY pending ASC, email ASC
  `;
}

/**
 * Grants org access by email, whether or not that person has an account.
 *
 * Idempotent: re-granting updates the role instead of erroring, which is what an
 * administrator changing someone's level actually wants.
 */
export async function grantOrgAccess(
  db: Database,
  input: { orgId: string; email: string; role: MembershipRole; grantedBy: Viewer },
): Promise<{ status: "granted" | "updated"; pending: boolean }> {
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error(`"${input.email}" is not a valid email address`);
  }

  const user = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1);

  if (user[0]) {
    const existing = await db
      .select({ id: schema.memberships.id })
      .from(schema.memberships)
      .where(
        and(
          eq(schema.memberships.orgId, input.orgId),
          eq(schema.memberships.userId, user[0].id),
          isNull(schema.memberships.teamId),
        ),
      )
      .limit(1);

    if (existing[0]) {
      await db
        .update(schema.memberships)
        .set({ role: input.role })
        .where(eq(schema.memberships.id, existing[0].id));
      return { status: "updated", pending: false };
    }

    await db.insert(schema.memberships).values({
      orgId: input.orgId,
      userId: user[0].id,
      role: input.role,
      activatedAt: new Date(),
      grantedBy: input.grantedBy.userId,
    });
    return { status: "granted", pending: false };
  }

  // No account yet: record the grant against the address and bind it at first login.
  const pendingExisting = await db
    .select({ id: schema.memberships.id })
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.orgId, input.orgId),
        raw`lower(${schema.memberships.invitedEmail}) = ${email}`,
      ),
    )
    .limit(1);

  if (pendingExisting[0]) {
    await db
      .update(schema.memberships)
      .set({ role: input.role })
      .where(eq(schema.memberships.id, pendingExisting[0].id));
    return { status: "updated", pending: true };
  }

  await db.insert(schema.memberships).values({
    orgId: input.orgId,
    invitedEmail: email,
    role: input.role,
    grantedBy: input.grantedBy.userId,
  });
  return { status: "granted", pending: true };
}

/**
 * Revokes a membership, refusing to remove the last owner.
 *
 * Without that guard an organisation can be left with nobody able to administer
 * it, which is unrecoverable from inside the product.
 */
export async function revokeOrgAccess(
  db: Database,
  input: { orgId: string; membershipId: string },
): Promise<{ removed: boolean; reason?: string }> {
  const target = await db
    .select({ role: schema.memberships.role, userId: schema.memberships.userId })
    .from(schema.memberships)
    .where(
      and(eq(schema.memberships.id, input.membershipId), eq(schema.memberships.orgId, input.orgId)),
    )
    .limit(1);

  if (!target[0]) return { removed: false, reason: "membership not found" };

  if (target[0].role === "owner") {
    const owners = await db
      .select({ id: schema.memberships.id })
      .from(schema.memberships)
      .where(
        and(
          eq(schema.memberships.orgId, input.orgId),
          eq(schema.memberships.role, "owner"),
          isNull(schema.memberships.teamId),
        ),
      );
    if (owners.length <= 1) {
      return { removed: false, reason: "an organisation must keep at least one owner" };
    }
  }

  await db.delete(schema.memberships).where(eq(schema.memberships.id, input.membershipId));
  return { removed: true };
}

/** Creates a project, enforcing the org's project ceiling. */
export async function createProject(
  db: Database,
  input: {
    context: AccessContext;
    key: string;
    name: string;
    description?: string | undefined;
    defaultBranch?: string | undefined;
  },
): Promise<{ projectId: string; key: string }> {
  const key = input.key
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 128);

  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(key)) {
    throw new Error("project key must start with a letter or digit");
  }

  const limits = await db
    .select({ maxProjects: schema.organizations.maxProjects })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, input.context.org.id))
    .limit(1);

  const current = await db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(
      and(eq(schema.projects.orgId, input.context.org.id), isNull(schema.projects.archivedAt)),
    );

  const ceiling = limits[0]?.maxProjects ?? 50;
  if (current.length >= ceiling) {
    throw new Error(`this organisation has reached its limit of ${ceiling} projects`);
  }

  const clash = await db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(and(eq(schema.projects.orgId, input.context.org.id), eq(schema.projects.key, key)))
    .limit(1);
  if (clash[0]) throw new Error(`a project with key "${key}" already exists`);

  const inserted = await db
    .insert(schema.projects)
    .values({
      orgId: input.context.org.id,
      key,
      name: input.name.trim().slice(0, 120) || key,
      description: input.description?.trim().slice(0, 500) ?? null,
      defaultBranch: input.defaultBranch?.trim() || "main",
      createdBy: input.context.viewer.userId,
    })
    .returning({ id: schema.projects.id });

  const projectId = inserted[0]?.id;
  if (!projectId) throw new Error("failed to create project");
  return { projectId, key };
}
