import { eq, isNull, and } from "drizzle-orm";
import { createClient } from "../src/client.js";
import {
  grantOrgAccess,
  listOrgMembers,
  revokeOrgAccess,
  upsertUserOnSignIn,
  type MembershipRole,
} from "../src/access.js";
import * as schema from "../src/schema.js";
import { requireDatabaseUrl } from "./load-env.js";

/**
 * The canonical account roster.
 *
 * Kept as a script rather than applied by hand so the roster survives a database
 * reset and is reviewable in the repository. Idempotent: run it as often as you like.
 *
 *   pnpm --filter @testcenter/db seed-users [org-slug]
 *
 * Platform-admin status is NOT set here. It comes from TESTCENTER_ADMIN_EMAILS and is
 * re-asserted at every sign-in, deliberately outside anything the database or this
 * script can grant — otherwise "superadmin" would be escalatable from inside the app.
 */
const ROSTER: { email: string; role: MembershipRole; note: string }[] = [
  {
    email: "admin@testcenter.dev",
    role: "owner",
    note: "superadmin — also listed in TESTCENTER_ADMIN_EMAILS",
  },
  { email: "qalead@testcenter.dev", role: "maintainer", note: "manages projects" },
  { email: "sdet@testcenter.dev", role: "member", note: "uploads results, edits tags" },
  { email: "qa@testcenter.dev", role: "viewer", note: "read-only" },
];

/**
 * Addresses from earlier rosters. Removed so the sign-in page has one obvious set of
 * accounts rather than two overlapping ones.
 */
const SUPERSEDED = [
  "qa-lead@test-organisation.dev",
  "sre@test-organisation.dev",
  "dev@test-organisation.dev",
  "manager@test-organisation.dev",
];

/**
 * Kept deliberately: an address granted access that has never signed in. Signing in as
 * this one demonstrates a pending grant binding to a new account, which is the feature
 * that replaces email invites.
 */
const PENDING_DEMO = { email: "future-hire@testcenter.dev", role: "member" as MembershipRole };

async function main(): Promise<void> {
  const databaseUrl = requireDatabaseUrl();
  const orgSlug = process.argv[2] ?? "test-organisation";

  const { sql, db } = createClient({ databaseUrl, maxConnections: 3 });

  try {
    const orgs = await db
      .select({ id: schema.organizations.id, name: schema.organizations.name })
      .from(schema.organizations)
      .where(eq(schema.organizations.slug, orgSlug))
      .limit(1);
    const org = orgs[0];
    if (!org) {
      console.error(
        `✗ no organisation "${orgSlug}". Run \`pnpm --filter @testcenter/db seed-test-org\` first.`,
      );
      process.exit(1);
    }

    console.log(`→ ${org.name} (${orgSlug})\n`);

    /*
     * The owner is created and granted first. An organisation must keep at least one
     * owner, so promoting the new one before removing the old is the only ordering
     * that works — the revoke guard would otherwise refuse.
     */
    for (const entry of ROSTER) {
      const { viewer } = await upsertUserOnSignIn(db, {
        email: entry.email,
        name: entry.email.split("@")[0] ?? entry.email,
        // Platform admin comes from configuration; passing an empty list here means
        // this script can never mint one.
        adminEmails: [],
      });
      const result = await grantOrgAccess(db, {
        orgId: org.id,
        email: entry.email,
        role: entry.role,
        grantedBy: viewer,
      });
      console.log(
        `  ${result.status === "granted" ? "+" : "~"} ${entry.email.padEnd(26)} ${entry.role.padEnd(11)} ${entry.note}`,
      );
    }

    // A grant with no account behind it yet.
    const pending = await grantOrgAccess(db, {
      orgId: org.id,
      email: PENDING_DEMO.email,
      role: PENDING_DEMO.role,
      grantedBy: (
        await upsertUserOnSignIn(db, {
          email: ROSTER[0]?.email as string,
          adminEmails: [],
        })
      ).viewer,
    });
    console.log(
      `  ${pending.status === "granted" ? "+" : "~"} ${PENDING_DEMO.email.padEnd(26)} ${PENDING_DEMO.role.padEnd(11)} pending — never signed in`,
    );

    // Now that a new owner exists, superseded accounts can go.
    console.log("");
    const members = await listOrgMembers(sql, org.id);
    let removed = 0;
    for (const email of SUPERSEDED) {
      const member = members.find((candidate) => candidate.email === email);
      if (!member) continue;
      const result = await revokeOrgAccess(db, {
        orgId: org.id,
        membershipId: member.membershipId,
      });
      if (result.removed) {
        // Delete the account too, so it no longer appears anywhere.
        await db.delete(schema.users).where(eq(schema.users.email, email));
        console.log(`  - ${email.padEnd(26)} removed (superseded)`);
        removed += 1;
      } else {
        console.log(`  ! ${email.padEnd(26)} kept: ${result.reason}`);
      }
    }
    // Also clear any superseded pending grants left behind.
    for (const email of ["future-hire@test-organisation.dev"]) {
      const stale = await db
        .select({ id: schema.memberships.id })
        .from(schema.memberships)
        .where(and(eq(schema.memberships.orgId, org.id), isNull(schema.memberships.userId)));
      for (const row of stale) {
        const match = await db
          .select({ invitedEmail: schema.memberships.invitedEmail })
          .from(schema.memberships)
          .where(eq(schema.memberships.id, row.id))
          .limit(1);
        if (match[0]?.invitedEmail?.toLowerCase() === email) {
          await db.delete(schema.memberships).where(eq(schema.memberships.id, row.id));
          console.log(`  - ${email.padEnd(26)} removed (superseded pending grant)`);
          removed += 1;
        }
      }
    }
    if (removed === 0) console.log("  (nothing to remove)");

    // ── report ───────────────────────────────────────────────────────────────
    const finalMembers = await listOrgMembers(sql, org.id);
    const adminEmails = (process.env.TESTCENTER_ADMIN_EMAILS ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);

    console.log(`\n  ${"EMAIL".padEnd(26)} ${"ROLE".padEnd(11)} STATE     SUPERADMIN`);
    for (const member of finalMembers) {
      const isAdmin = adminEmails.includes(member.email.toLowerCase());
      console.log(
        `  ${member.email.padEnd(26)} ${member.role.padEnd(11)} ${(member.pending ? "pending" : "active").padEnd(9)} ${isAdmin ? "yes" : "—"}`,
      );
    }

    const missingAdmins = ROSTER.filter(
      (entry) =>
        entry.note.includes("TESTCENTER_ADMIN_EMAILS") && !adminEmails.includes(entry.email),
    );
    if (missingAdmins.length > 0) {
      console.warn(
        `\n! ${missingAdmins.map((entry) => entry.email).join(", ")} should be in ` +
          `TESTCENTER_ADMIN_EMAILS to get superadmin. Add it to .env and sign in again.`,
      );
    }

    console.log(`\nSign in at http://localhost:3000/signin — email only, no password.`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
