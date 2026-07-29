import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import {
  AccessDeniedError,
  activatePendingGrants,
  completeOnboarding,
  createOrganization,
  createProject,
  grantOrgAccess,
  listAccessibleOrgs,
  listOrgMembers,
  requireCapability,
  requireOrgAccess,
  requireProject,
  revokeOrgAccess,
  roleAllows,
  upsertUserOnSignIn,
  type Viewer,
} from "./access.js";
import { createClient, type Database, type Sql } from "./client.js";
import { getRun, listRuns } from "./queries.js";
import * as schema from "./schema.js";

/**
 * Multi-tenant isolation.
 *
 * These are the tests that matter most in the whole suite. Everything else being
 * correct is worthless if one organisation can read another's test results, and the
 * failure mode is silent — a missing `WHERE org_id` looks fine until someone
 * notices their competitor's suite in the run list.
 *
 * So they assert isolation from the outside: a real second organisation, a real
 * second user, and attempts to reach across using ids that are perfectly valid in
 * their own tenant.
 */
const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

function unique(prefix: string): string {
  const letters = Array.from(
    { length: 8 },
    () => "abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 26)],
  ).join("");
  return `${prefix}-${letters}`;
}

describeIfDb("access control", () => {
  let sql: Sql;
  let db: Database;

  /** Two tenants that must never see each other, plus an outsider. */
  let alice: Viewer; // owner of org A
  let bob: Viewer; // owner of org B
  let carol: Viewer; // no memberships at all
  let admin: Viewer; // platform admin
  let orgA: { orgId: string; slug: string };
  let orgB: { orgId: string; slug: string };
  let runInA: string;
  const createdOrgSlugs: string[] = [];
  const createdUserEmails: string[] = [];

  beforeAll(async () => {
    const client = createClient({ databaseUrl: databaseUrl as string, maxConnections: 4 });
    sql = client.sql;
    db = client.db;

    alice = await signIn(unique("alice") + "@example.test");
    bob = await signIn(unique("bob") + "@example.test");
    carol = await signIn(unique("carol") + "@example.test");
    const adminEmail = unique("admin") + "@example.test";
    admin = (await upsertUserOnSignIn(db, { email: adminEmail, adminEmails: [adminEmail] })).viewer;
    createdUserEmails.push(adminEmail);

    orgA = await createOrganization(db, { name: unique("Org A"), createdBy: alice });
    orgB = await createOrganization(db, { name: unique("Org B"), createdBy: bob });
    createdOrgSlugs.push(orgA.slug, orgB.slug);

    const aliceContext = await requireOrgAccess(db, alice, orgA.slug);
    await createProject(db, { context: aliceContext, key: "secret-suite", name: "Secret Suite" });

    const inserted = await db
      .insert(schema.runs)
      .values({
        orgId: orgA.orgId,
        projectId: (await requireProject(sql, aliceContext, "secret-suite")).id,
        framework: "junit",
        status: "complete",
      })
      .returning({ id: schema.runs.id });
    runInA = inserted[0]?.id as string;
  });

  afterAll(async () => {
    if (!sql) return;
    for (const slug of createdOrgSlugs) {
      await db.delete(schema.organizations).where(eq(schema.organizations.slug, slug));
    }
    for (const email of createdUserEmails) {
      await db.delete(schema.users).where(eq(schema.users.email, email));
    }
    await sql.end({ timeout: 5 });
  });

  async function signIn(email: string): Promise<Viewer> {
    createdUserEmails.push(email);
    const { viewer } = await upsertUserOnSignIn(db, { email, name: email, adminEmails: [] });
    return viewer;
  }

  describe("cross-tenant isolation", () => {
    it("hides another organisation's runs from the run list", async () => {
      const aliceSees = await listRuns(sql, { orgId: orgA.orgId });
      expect(aliceSees.runs.some((run) => run.id === runInA)).toBe(true);

      // Bob queries with his own org id — the only one he can obtain.
      const bobSees = await listRuns(sql, { orgId: orgB.orgId });
      expect(bobSees.runs.some((run) => run.id === runInA)).toBe(false);
    });

    it("refuses a direct run read from another organisation", async () => {
      // Bob has the run's UUID (say it leaked in a screenshot). It must still fail.
      expect(await getRun(sql, { orgId: orgB.orgId, runId: runInA })).toBeNull();
      expect(await getRun(sql, { orgId: orgA.orgId, runId: runInA })).not.toBeNull();
    });

    it("refuses to resolve an organisation the viewer is not in", async () => {
      await expect(requireOrgAccess(db, bob, orgA.slug)).rejects.toThrow(AccessDeniedError);
      await expect(requireOrgAccess(db, carol, orgA.slug)).rejects.toThrow(AccessDeniedError);
    });

    it("reports a hidden organisation identically to a missing one", async () => {
      // Distinguishing them would let anyone enumerate organisation slugs.
      const hidden = await requireOrgAccess(db, bob, orgA.slug).catch(
        (error: AccessDeniedError) => error,
      );
      const missing = await requireOrgAccess(db, bob, "definitely-not-an-org").catch(
        (error: AccessDeniedError) => error,
      );
      expect((hidden as AccessDeniedError).reason).toBe((missing as AccessDeniedError).reason);
    });

    it("refuses to resolve a project from another organisation", async () => {
      const bobContext = await requireOrgAccess(db, bob, orgB.slug);
      // The key exists — just not in Bob's org.
      await expect(requireProject(sql, bobContext, "secret-suite")).rejects.toThrow(
        AccessDeniedError,
      );
    });

    it("rejects an unauthenticated viewer", async () => {
      await expect(requireOrgAccess(db, null, orgA.slug)).rejects.toThrow(
        /authentication required/,
      );
    });
  });

  describe("roles", () => {
    it("orders capabilities by role rank", () => {
      expect(roleAllows("viewer", "run:read")).toBe(true);
      expect(roleAllows("viewer", "run:upload")).toBe(false);
      expect(roleAllows("member", "run:upload")).toBe(true);
      expect(roleAllows("member", "project:create")).toBe(false);
      expect(roleAllows("maintainer", "project:create")).toBe(true);
      expect(roleAllows("maintainer", "member:manage")).toBe(false);
      expect(roleAllows("admin", "member:manage")).toBe(true);
      expect(roleAllows("admin", "org:delete")).toBe(false);
      expect(roleAllows("owner", "org:delete")).toBe(true);
    });

    it("blocks a viewer from uploading and allows them to read", async () => {
      await grantOrgAccess(db, {
        orgId: orgA.orgId,
        email: carol.email,
        role: "viewer",
        grantedBy: alice,
      });
      await activatePendingGrants(db, carol);

      const carolContext = await requireOrgAccess(db, carol, orgA.slug);
      expect(() => requireCapability(carolContext, "run:read")).not.toThrow();
      expect(() => requireCapability(carolContext, "run:upload")).toThrow(/cannot run:upload/);
      expect(() => requireCapability(carolContext, "project:create")).toThrow();
    });
  });

  describe("granting access", () => {
    it("grants to an existing account immediately", async () => {
      const result = await grantOrgAccess(db, {
        orgId: orgB.orgId,
        email: alice.email,
        role: "member",
        grantedBy: bob,
      });
      expect(result).toEqual({ status: "granted", pending: false });

      const orgs = await listAccessibleOrgs(db, alice);
      expect(orgs.map((org) => org.slug)).toContain(orgB.slug);
      expect(orgs.find((org) => org.slug === orgB.slug)?.role).toBe("member");
    });

    it("holds a grant for an address with no account, then binds it at sign-in", async () => {
      // This is what replaces email invites: the grant is recorded now and attaches
      // when that person first logs in.
      const futureEmail = unique("future") + "@example.test";
      const result = await grantOrgAccess(db, {
        orgId: orgB.orgId,
        email: futureEmail,
        role: "maintainer",
        grantedBy: bob,
      });
      expect(result).toEqual({ status: "granted", pending: true });

      const membersBefore = await listOrgMembers(sql, orgB.orgId);
      expect(membersBefore.find((member) => member.email === futureEmail)?.pending).toBe(true);

      const future = await signIn(futureEmail);
      const orgs = await listAccessibleOrgs(db, future);
      expect(orgs.map((org) => org.slug)).toContain(orgB.slug);
      expect(orgs.find((org) => org.slug === orgB.slug)?.role).toBe("maintainer");

      const membersAfter = await listOrgMembers(sql, orgB.orgId);
      expect(membersAfter.find((member) => member.email === futureEmail)?.pending).toBe(false);
    });

    it("treats a repeat grant as a role change", async () => {
      const result = await grantOrgAccess(db, {
        orgId: orgB.orgId,
        email: alice.email,
        role: "admin",
        grantedBy: bob,
      });
      expect(result.status).toBe("updated");
      const orgs = await listAccessibleOrgs(db, alice);
      expect(orgs.find((org) => org.slug === orgB.slug)?.role).toBe("admin");
    });

    it("rejects a malformed email", async () => {
      await expect(
        grantOrgAccess(db, {
          orgId: orgB.orgId,
          email: "not-an-email",
          role: "member",
          grantedBy: bob,
        }),
      ).rejects.toThrow(/not a valid email/);
    });

    it("refuses to remove the last owner", async () => {
      // Otherwise an org can be left with nobody able to administer it, which is
      // unrecoverable from inside the product.
      const members = await listOrgMembers(sql, orgA.orgId);
      const owner = members.find((member) => member.role === "owner");
      const result = await revokeOrgAccess(db, {
        orgId: orgA.orgId,
        membershipId: owner?.membershipId as string,
      });
      expect(result.removed).toBe(false);
      expect(result.reason).toMatch(/at least one owner/);
    });

    it("revokes a non-owner and removes their access", async () => {
      const members = await listOrgMembers(sql, orgA.orgId);
      const viewerMember = members.find((member) => member.role === "viewer");
      const result = await revokeOrgAccess(db, {
        orgId: orgA.orgId,
        membershipId: viewerMember?.membershipId as string,
      });
      expect(result.removed).toBe(true);
      await expect(requireOrgAccess(db, carol, orgA.slug)).rejects.toThrow(AccessDeniedError);
    });
  });

  describe("platform admin", () => {
    it("sees every organisation without explicit membership", async () => {
      const orgs = await listAccessibleOrgs(db, admin);
      const slugs = orgs.map((org) => org.slug);
      expect(slugs).toContain(orgA.slug);
      expect(slugs).toContain(orgB.slug);
      expect(orgs.find((org) => org.slug === orgA.slug)?.viaPlatformAdmin).toBe(true);
    });

    it("acts as owner where it has no membership", async () => {
      const context = await requireOrgAccess(db, admin, orgA.slug);
      expect(() => requireCapability(context, "member:manage")).not.toThrow();
    });

    it("is granted from configuration, not from the database", async () => {
      // Re-signing in without the address in adminEmails must revoke it, so removing
      // someone from the config actually takes effect.
      const { viewer: demoted } = await upsertUserOnSignIn(db, {
        email: admin.email,
        adminEmails: [],
      });
      expect(demoted.isPlatformAdmin).toBe(false);

      const { viewer: restored } = await upsertUserOnSignIn(db, {
        email: admin.email,
        adminEmails: [admin.email],
      });
      expect(restored.isPlatformAdmin).toBe(true);
    });
  });

  describe("onboarding", () => {
    it("marks a user onboarded when they create an organisation", async () => {
      const email = unique("newbie") + "@example.test";
      const newbie = await signIn(email);
      expect(newbie.onboarded).toBe(false);

      const created = await createOrganization(db, {
        name: unique("Newbie Org"),
        createdBy: newbie,
        personal: true,
      });
      createdOrgSlugs.push(created.slug);

      const after = await upsertUserOnSignIn(db, { email, adminEmails: [] });
      expect(after.viewer.onboarded).toBe(true);

      const orgs = await listAccessibleOrgs(db, after.viewer);
      const personal = orgs.find((org) => org.slug === created.slug);
      expect(personal?.isPersonal).toBe(true);
      expect(personal?.role).toBe("owner");
    });

    it("lets a user finish onboarding without an organisation", async () => {
      // Skipping is legitimate: they will be told they have no access yet rather
      // than shown an empty dashboard that looks broken.
      const email = unique("skipper") + "@example.test";
      const skipper = await signIn(email);
      await completeOnboarding(db, skipper);

      const after = await upsertUserOnSignIn(db, { email, adminEmails: [] });
      expect(after.viewer.onboarded).toBe(true);
      expect(await listAccessibleOrgs(db, after.viewer)).toHaveLength(0);
    });

    it("gives distinct slugs to organisations with the same name", async () => {
      const name = unique("Duplicate Name");
      const first = await createOrganization(db, { name, createdBy: alice });
      const second = await createOrganization(db, { name, createdBy: bob });
      createdOrgSlugs.push(first.slug, second.slug);
      expect(second.slug).not.toBe(first.slug);
    });
  });

  describe("projects", () => {
    it("creates a project scoped to the organisation", async () => {
      const context = await requireOrgAccess(db, alice, orgA.slug);
      const created = await createProject(db, {
        context,
        key: "Web Checkout!",
        name: "Web Checkout",
      });
      // The key is normalised rather than rejected for cosmetic reasons.
      expect(created.key).toBe("web-checkout");

      const resolved = await requireProject(sql, context, "web-checkout");
      expect(resolved.name).toBe("Web Checkout");

      // And it is invisible from the other tenant.
      const bobContext = await requireOrgAccess(db, bob, orgB.slug);
      await expect(requireProject(sql, bobContext, "web-checkout")).rejects.toThrow();
    });

    it("rejects a duplicate key within one organisation", async () => {
      const context = await requireOrgAccess(db, alice, orgA.slug);
      await expect(
        createProject(db, { context, key: "web-checkout", name: "Again" }),
      ).rejects.toThrow(/already exists/);
    });

    it("allows the same key in different organisations", async () => {
      const bobContext = await requireOrgAccess(db, bob, orgB.slug);
      const created = await createProject(db, {
        context: bobContext,
        key: "web-checkout",
        name: "Bob's Checkout",
      });
      expect(created.key).toBe("web-checkout");
    });

    it("enforces the organisation's project ceiling", async () => {
      await db
        .update(schema.organizations)
        .set({ maxProjects: 1 })
        .where(eq(schema.organizations.id, orgB.orgId));

      const bobContext = await requireOrgAccess(db, bob, orgB.slug);
      await expect(
        createProject(db, { context: bobContext, key: "one-too-many", name: "Nope" }),
      ).rejects.toThrow(/limit of 1 projects/);

      await db
        .update(schema.organizations)
        .set({ maxProjects: 50 })
        .where(eq(schema.organizations.id, orgB.orgId));
    });
  });

  it("keeps pending grants out of accessible organisations", async () => {
    // A grant that has not been bound to an account must not confer access to
    // anyone, including via a stray membership row with a null user_id.
    const email = unique("pending") + "@example.test";
    await grantOrgAccess(db, {
      orgId: orgA.orgId,
      email,
      role: "admin",
      grantedBy: alice,
    });

    const stray = await db
      .select({ id: schema.memberships.id })
      .from(schema.memberships)
      .where(and(eq(schema.memberships.orgId, orgA.orgId), isNull(schema.memberships.userId)));
    expect(stray.length).toBeGreaterThan(0);

    // Bob still cannot see org A despite a pending row existing there.
    await expect(requireOrgAccess(db, bob, orgA.slug)).rejects.toThrow(AccessDeniedError);
  });
});
