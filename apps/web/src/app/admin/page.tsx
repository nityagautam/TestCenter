import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  grantOrgAccess,
  listOrgMembers,
  revokeOrgAccess,
  schema,
  type MembershipRole,
} from "@testcenter/db";
import { Card, CardHeader, EmptyState } from "@/components/ui";
import { formatRelativeTime } from "@/lib/format";
import { getServices } from "@/lib/services";
import { requireViewer } from "@/lib/viewer";

/**
 * Platform administration.
 *
 * This is how someone gets access to an organisation they are not already in — the
 * alternative to email invites. A platform admin can see every organisation and grant
 * membership across boundaries, which no org-level role can do.
 *
 * Deliberately a separate area rather than a mode on the normal settings screens: the
 * whole point is acting outside your own memberships, and mixing that into the same UI
 * would make it easy to modify the wrong tenant by accident.
 */
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Platform administration" };

const ROLES: MembershipRole[] = ["viewer", "member", "maintainer", "admin", "owner"];

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string; error?: string; ok?: string }>;
}) {
  const { org: selectedSlug, error, ok } = await searchParams;
  const viewer = await requireViewer();

  // Platform admin comes from configuration and is re-asserted at sign-in, so this
  // check cannot be satisfied by anything a user can change from inside the app.
  if (!viewer.isPlatformAdmin) {
    return (
      <div className="mx-auto max-w-lg px-6 py-14">
        <Card className="p-6 text-center">
          <h1 className="text-sm font-semibold">Not permitted</h1>
          <p className="mt-2 text-xs leading-relaxed text-[var(--color-ink-muted)]">
            Platform administration is limited to addresses listed in{" "}
            <span className="font-mono">TESTCENTER_ADMIN_EMAILS</span>. Your account is not one of
            them.
          </p>
          <Link href="/" className="mt-4 inline-block text-xs underline">
            Go back
          </Link>
        </Card>
      </div>
    );
  }

  const { sql, db } = getServices();

  const orgs = await sql<
    {
      id: string;
      slug: string;
      name: string;
      members: number;
      projects: number;
      runs: number;
      lastRunAt: Date | null;
      isPersonal: boolean;
      createdAt: Date;
    }[]
  >`
    SELECT
      o.id, o.slug, o.name,
      (SELECT count(*)::int FROM memberships m WHERE m.org_id = o.id AND m.team_id IS NULL) AS members,
      (SELECT count(*)::int FROM projects p WHERE p.org_id = o.id AND p.archived_at IS NULL) AS projects,
      (SELECT count(*)::int FROM runs r WHERE r.org_id = o.id) AS runs,
      (SELECT max(r.started_at) FROM runs r WHERE r.org_id = o.id) AS "lastRunAt",
      (o.personal_for_user_id IS NOT NULL) AS "isPersonal",
      o.created_at AS "createdAt"
    FROM organizations o
    ORDER BY o.name ASC
  `;

  const selected = selectedSlug ? orgs.find((entry) => entry.slug === selectedSlug) : undefined;
  const members = selected ? await listOrgMembers(sql, selected.id) : [];

  const userCount = await db.select({ id: schema.users.id }).from(schema.users);

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Platform administration</h1>
          <p className="mt-0.5 text-xs text-[var(--color-ink-muted)]">
            {orgs.length} organisation{orgs.length === 1 ? "" : "s"} · {userCount.length} account
            {userCount.length === 1 ? "" : "s"} · signed in as{" "}
            <span className="font-mono">{viewer.email}</span>
          </p>
        </div>
        <Link
          href="/organizations/new"
          className="rounded-md bg-[var(--color-ink)] px-3 py-2 text-xs font-medium text-[var(--color-surface)] hover:opacity-90"
        >
          New organisation
        </Link>
      </div>

      {error ? (
        <p className="mb-4 rounded-md border border-[var(--color-status-failed)]/40 bg-[var(--color-status-failed)]/5 px-3 py-2 text-xs text-[var(--color-status-failed)]">
          {error}
        </p>
      ) : null}
      {ok ? (
        <p className="mb-4 rounded-md border border-[var(--color-status-passed)]/40 bg-[var(--color-status-passed)]/5 px-3 py-2 text-xs text-[var(--color-status-passed)]">
          {ok}
        </p>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card className="overflow-hidden">
          <CardHeader title="All organisations" />
          {orgs.length === 0 ? (
            <EmptyState
              title="No organisations"
              description="None exist yet. Create one here, or let a new user create a personal space during onboarding."
            />
          ) : (
            <ul className="divide-y divide-[var(--color-border-subtle)]">
              {orgs.map((entry) => (
                <li
                  key={entry.id}
                  className={`px-5 py-2.5 ${entry.slug === selectedSlug ? "bg-[var(--color-surface)]" : ""}`}
                >
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          href={`/admin?org=${entry.slug}`}
                          className="truncate text-xs font-medium hover:underline"
                        >
                          {entry.name}
                        </Link>
                        {entry.isPersonal ? (
                          <span className="rounded bg-[var(--color-border-subtle)] px-1.5 py-0.5 text-[10px]">
                            personal
                          </span>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap gap-x-3 font-mono text-[10px] text-[var(--color-ink-muted)]">
                        <span>{entry.slug}</span>
                        <span>{entry.members} members</span>
                        <span>{entry.projects} projects</span>
                        <span>{entry.runs} runs</span>
                        <span>
                          {entry.lastRunAt
                            ? `active ${formatRelativeTime(entry.lastRunAt)}`
                            : "never used"}
                        </span>
                      </div>
                    </div>
                    <Link
                      href={`/o/${entry.slug}`}
                      className="shrink-0 rounded border border-[var(--color-border-subtle)] px-2 py-1 text-[10px] hover:border-[var(--color-ink-muted)]"
                    >
                      open
                    </Link>
                    <Link
                      href={`/o/${entry.slug}/settings`}
                      className="shrink-0 text-[10px] text-[var(--color-ink-muted)] underline hover:text-[var(--color-ink)]"
                    >
                      settings
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="overflow-hidden">
          <CardHeader
            title={selected ? `Access to ${selected.name}` : "Select an organisation"}
            action={
              selected ? (
                <Link href="/admin" className="text-[11px] underline">
                  clear
                </Link>
              ) : undefined
            }
          />

          {!selected ? (
            <EmptyState
              title="No organisation selected"
              description="Pick one on the left to grant or revoke access. As a platform admin you can do this for organisations you are not a member of."
            />
          ) : (
            <>
              <div className="border-b border-[var(--color-border-subtle)] px-5 py-4">
                <form
                  action={async (formData: FormData) => {
                    "use server";
                    const email = String(formData.get("email") ?? "");
                    const role = String(formData.get("role") ?? "member") as MembershipRole;

                    const { db: database } = getServices();
                    const { requireViewer: resolve } = await import("@/lib/viewer");
                    const current = await resolve();
                    // Re-checked inside the action: a form post is a separate request and
                    // must not trust that the page render was authorised.
                    if (!current.isPlatformAdmin) {
                      redirect("/admin?error=Platform+administration+is+not+permitted");
                    }

                    try {
                      const result = await grantOrgAccess(database, {
                        orgId: selected.id,
                        email,
                        role,
                        grantedBy: current,
                      });
                      revalidatePath("/admin");
                      redirect(
                        `/admin?org=${selected.slug}&ok=${encodeURIComponent(
                          result.pending
                            ? `Grant saved — applies when ${email} first signs in.`
                            : `${email} now has ${role} access to ${selected.name}.`,
                        )}`,
                      );
                    } catch (cause) {
                      redirect(
                        `/admin?org=${selected.slug}&error=${encodeURIComponent(
                          cause instanceof Error ? cause.message : "could not grant access",
                        )}`,
                      );
                    }
                  }}
                  className="flex flex-wrap gap-2"
                >
                  <input
                    name="email"
                    type="email"
                    required
                    placeholder="person@example.com"
                    className="min-w-48 flex-1 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 font-mono text-xs outline-none focus:border-[var(--color-ink-muted)]"
                  />
                  <select
                    name="role"
                    defaultValue="member"
                    className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1.5 text-xs outline-none focus:border-[var(--color-ink-muted)]"
                  >
                    {ROLES.map((role) => (
                      <option key={role} value={role}>
                        {role}
                      </option>
                    ))}
                  </select>
                  <button
                    type="submit"
                    className="rounded-md bg-[var(--color-ink)] px-3 py-1.5 text-xs font-medium text-[var(--color-surface)] hover:opacity-90"
                  >
                    Grant
                  </button>
                </form>
                <p className="mt-2 text-[11px] leading-relaxed text-[var(--color-ink-muted)]">
                  Works for addresses that have never signed in — the grant is held and applied at
                  first login.
                </p>
              </div>

              <ul className="divide-y divide-[var(--color-border-subtle)]">
                {members.map((member) => (
                  <li key={member.membershipId} className="flex items-center gap-3 px-5 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-mono text-[11px]">{member.email}</span>
                        {member.pending ? (
                          <span className="rounded bg-[var(--color-status-flaky)]/15 px-1 text-[10px]">
                            pending
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <span className="shrink-0 rounded bg-[var(--color-border-subtle)] px-1.5 py-0.5 text-[10px] uppercase">
                      {member.role}
                    </span>
                    <form
                      action={async () => {
                        "use server";
                        const { db: database } = getServices();
                        const { requireViewer: resolve } = await import("@/lib/viewer");
                        const current = await resolve();
                        if (!current.isPlatformAdmin) {
                          redirect("/admin?error=Platform+administration+is+not+permitted");
                        }
                        const result = await revokeOrgAccess(database, {
                          orgId: selected.id,
                          membershipId: member.membershipId,
                        });
                        revalidatePath("/admin");
                        if (!result.removed) {
                          redirect(
                            `/admin?org=${selected.slug}&error=${encodeURIComponent(
                              result.reason ?? "could not remove",
                            )}`,
                          );
                        }
                      }}
                    >
                      <button
                        type="submit"
                        className="shrink-0 text-[11px] text-[var(--color-ink-muted)] underline hover:text-[var(--color-status-failed)]"
                      >
                        revoke
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
