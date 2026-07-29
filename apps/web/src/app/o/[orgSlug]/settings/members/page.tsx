import { revalidatePath } from "next/cache";
import {
  grantOrgAccess,
  listOrgMembers,
  requireCapability,
  revokeOrgAccess,
  type MembershipRole,
} from "@testcenter/db";
import { PermissionDenied } from "@/components/permission-denied";
import { Card, CardHeader } from "@/components/ui";
import { formatRelativeTime } from "@/lib/format";
import { getServices } from "@/lib/services";
import { can, requirePageContext } from "@/lib/viewer";

/**
 * Organisation members.
 *
 * Access is granted by email, which works whether or not that person has signed in
 * yet — a grant for an unknown address is held and bound to the account at first
 * login. That gives invite ergonomics without needing to send mail, which is the
 * right trade for a self-hosted tool.
 */
export const dynamic = "force-dynamic";

const ROLES: { value: MembershipRole; label: string; description: string }[] = [
  { value: "viewer", label: "Viewer", description: "read results only" },
  { value: "member", label: "Member", description: "upload results, edit tags" },
  { value: "maintainer", label: "Maintainer", description: "manage projects" },
  { value: "admin", label: "Admin", description: "manage members and tokens" },
  { value: "owner", label: "Owner", description: "full control" },
];

export default async function MembersPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const { orgSlug } = await params;
  const { error, ok } = await searchParams;
  const context = await requirePageContext(orgSlug);
  if (!can(context, "member:manage")) {
    return (
      <PermissionDenied
        action="Managing members"
        requires="admin"
        role={context.org.role}
        orgName={context.org.name}
        backHref={`/o/${orgSlug}`}
      />
    );
  }

  const { sql } = getServices();
  const members = await listOrgMembers(sql, context.org.id);

  return (
    <main className="mx-auto max-w-3xl px-6 py-6">
      <h1 className="text-lg font-semibold tracking-tight">Members</h1>
      <p className="mt-0.5 mb-5 text-xs text-[var(--color-ink-muted)]">
        {context.org.name} · everyone here can see every project in this organisation.
      </p>

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

      <Card className="mb-5 p-5">
        <h2 className="mb-1 text-sm font-medium">Grant access</h2>
        <p className="mb-3 text-xs leading-relaxed text-[var(--color-ink-muted)]">
          If this address has never signed in, the grant waits and applies automatically on their
          first login.
        </p>
        <form
          action={async (formData: FormData) => {
            "use server";
            const email = String(formData.get("email") ?? "");
            const role = String(formData.get("role") ?? "member") as MembershipRole;
            const { db } = getServices();
            const { requirePageContext: resolve } = await import("@/lib/viewer");
            const current = await resolve(orgSlug);
            requireCapability(current, "member:manage");

            const { redirect } = await import("next/navigation");
            try {
              const result = await grantOrgAccess(db, {
                orgId: current.org.id,
                email,
                role,
                grantedBy: current.viewer,
              });
              revalidatePath(`/o/${orgSlug}/settings/members`);
              redirect(
                `/o/${orgSlug}/settings/members?ok=${encodeURIComponent(
                  result.pending
                    ? `Grant saved — it applies when ${email} first signs in.`
                    : `${email} now has ${role} access.`,
                )}`,
              );
            } catch (cause) {
              redirect(
                `/o/${orgSlug}/settings/members?error=${encodeURIComponent(
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
            placeholder="teammate@example.com"
            className="min-w-56 flex-1 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 font-mono text-xs outline-none focus:border-[var(--color-ink-muted)]"
          />
          <select
            name="role"
            defaultValue="member"
            className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1.5 text-xs outline-none focus:border-[var(--color-ink-muted)]"
          >
            {ROLES.map((role) => (
              <option key={role.value} value={role.value}>
                {role.label} — {role.description}
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
      </Card>

      <Card className="overflow-hidden">
        <CardHeader title={`${members.length} member${members.length === 1 ? "" : "s"}`} />
        <ul className="divide-y divide-[var(--color-border-subtle)]">
          {members.map((member) => (
            <li key={member.membershipId} className="flex items-center gap-3 px-5 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-xs font-medium">
                    {member.name ?? member.email}
                  </span>
                  {member.pending ? (
                    <span
                      className="rounded bg-[var(--color-status-flaky)]/15 px-1.5 py-0.5 text-[10px]"
                      title="Applies when this person first signs in"
                    >
                      pending
                    </span>
                  ) : null}
                </div>
                <div className="truncate font-mono text-[10px] text-[var(--color-ink-muted)]">
                  {member.email}
                  {member.lastSeenAt ? ` · seen ${formatRelativeTime(member.lastSeenAt)}` : ""}
                </div>
              </div>
              <span className="shrink-0 rounded bg-[var(--color-border-subtle)] px-1.5 py-0.5 text-[10px] tracking-wide uppercase">
                {member.role}
              </span>
              <form
                action={async () => {
                  "use server";
                  const { db } = getServices();
                  const { requirePageContext: resolve } = await import("@/lib/viewer");
                  const current = await resolve(orgSlug);
                  requireCapability(current, "member:manage");
                  const result = await revokeOrgAccess(db, {
                    orgId: current.org.id,
                    membershipId: member.membershipId,
                  });
                  revalidatePath(`/o/${orgSlug}/settings/members`);
                  if (!result.removed) {
                    const { redirect } = await import("next/navigation");
                    redirect(
                      `/o/${orgSlug}/settings/members?error=${encodeURIComponent(
                        result.reason ?? "could not remove member",
                      )}`,
                    );
                  }
                }}
              >
                <button
                  type="submit"
                  className="shrink-0 text-[11px] text-[var(--color-ink-muted)] underline hover:text-[var(--color-status-failed)]"
                >
                  remove
                </button>
              </form>
            </li>
          ))}
        </ul>
      </Card>
    </main>
  );
}
