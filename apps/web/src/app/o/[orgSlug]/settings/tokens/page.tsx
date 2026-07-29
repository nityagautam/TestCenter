import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { generateApiToken, listProjects, requireCapability, schema } from "@testcenter/db";
import { CiSnippet } from "@/components/ci-snippet";
import { PermissionDenied } from "@/components/permission-denied";
import { Card, CardHeader, EmptyState } from "@/components/ui";
import { formatRelativeTime } from "@/lib/format";
import { getServices } from "@/lib/services";
import { can, requirePageContext } from "@/lib/viewer";

/**
 * API tokens.
 *
 * Only a sha256 of each token is stored, so a token is displayed exactly once — at
 * creation, alongside the CI snippet that uses it. Revocation is a soft delete
 * (revoked_at) rather than a row removal, so an audit of "what uploaded this run"
 * still resolves after a token is retired.
 */
export const dynamic = "force-dynamic";

export default async function TokensPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ token?: string; project?: string }>;
}) {
  const { orgSlug } = await params;
  const { token: freshToken, project: freshProject } = await searchParams;
  const context = await requirePageContext(orgSlug);
  if (!can(context, "token:manage")) {
    return (
      <PermissionDenied
        action="Managing API tokens"
        requires="admin"
        role={context.org.role}
        orgName={context.org.name}
        backHref={`/o/${orgSlug}`}
      />
    );
  }

  const { sql, db } = getServices();
  const projects = await listProjects(sql, context.org.id);

  const tokens = await db
    .select({
      id: schema.apiTokens.id,
      name: schema.apiTokens.name,
      prefix: schema.apiTokens.tokenPrefix,
      projectId: schema.apiTokens.projectId,
      scopes: schema.apiTokens.scopes,
      lastUsedAt: schema.apiTokens.lastUsedAt,
      revokedAt: schema.apiTokens.revokedAt,
      createdAt: schema.apiTokens.createdAt,
    })
    .from(schema.apiTokens)
    .where(eq(schema.apiTokens.orgId, context.org.id));

  const active = tokens.filter((token) => token.revokedAt === null);
  const projectName = (id: string | null): string =>
    id ? (projects.find((project) => project.id === id)?.key ?? "unknown") : "all projects";

  return (
    <main className="mx-auto max-w-3xl px-6 py-6">
      <h1 className="text-lg font-semibold tracking-tight">API tokens</h1>
      <p className="mt-0.5 mb-5 text-xs text-[var(--color-ink-muted)]">
        Used by CI to upload results. Scope a token to one project unless it genuinely needs more.
      </p>

      {freshToken ? (
        <Card className="mb-5 border-[var(--color-status-flaky)]/40">
          <CardHeader title="New token" />
          <div className="px-5 py-4">
            <CiSnippet projectKey={freshProject ?? "your-project"} token={freshToken} />
          </div>
        </Card>
      ) : null}

      <Card className="mb-5 p-5">
        <h2 className="mb-3 text-sm font-medium">Create a token</h2>
        {projects.length === 0 ? (
          <p className="text-xs text-[var(--color-ink-muted)]">
            Create a project first — a token scoped to nothing cannot upload anything.
          </p>
        ) : (
          <form
            action={async (formData: FormData) => {
              "use server";
              const name = String(formData.get("name") ?? "ci").trim() || "ci";
              const projectKey = String(formData.get("projectKey") ?? "");

              const { db: database } = getServices();
              const { requirePageContext: resolve } = await import("@/lib/viewer");
              const current = await resolve(orgSlug);
              requireCapability(current, "token:manage");

              const { sql: rawSql } = getServices();
              const scoped = await listProjects(rawSql, current.org.id);
              const project = scoped.find((candidate) => candidate.key === projectKey);

              const token = generateApiToken();
              await database.insert(schema.apiTokens).values({
                orgId: current.org.id,
                projectId: project?.id ?? null,
                name,
                tokenHash: token.hash,
                tokenPrefix: token.prefix,
                scopes: ["runs:write", "runs:read"],
                createdBy: current.viewer.userId,
              });

              revalidatePath(`/o/${orgSlug}/settings/tokens`);
              const { redirect } = await import("next/navigation");
              redirect(
                `/o/${orgSlug}/settings/tokens?token=${encodeURIComponent(token.plaintext)}&project=${encodeURIComponent(projectKey)}`,
              );
            }}
            className="flex flex-wrap gap-2"
          >
            <input
              name="name"
              placeholder="github-actions"
              className="min-w-40 flex-1 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-xs outline-none focus:border-[var(--color-ink-muted)]"
            />
            <select
              name="projectKey"
              className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1.5 text-xs outline-none focus:border-[var(--color-ink-muted)]"
            >
              {projects.map((project) => (
                <option key={project.key} value={project.key}>
                  {project.key}
                </option>
              ))}
              <option value="">all projects</option>
            </select>
            <button
              type="submit"
              className="rounded-md bg-[var(--color-ink)] px-3 py-1.5 text-xs font-medium text-[var(--color-surface)] hover:opacity-90"
            >
              Create
            </button>
          </form>
        )}
      </Card>

      <Card className="overflow-hidden">
        <CardHeader title={`${active.length} active token${active.length === 1 ? "" : "s"}`} />
        {tokens.length === 0 ? (
          <EmptyState
            title="No tokens yet"
            description="Create one to let CI upload results without a browser session."
          />
        ) : (
          <ul className="divide-y divide-[var(--color-border-subtle)]">
            {tokens.map((token) => (
              <li key={token.id} className="flex items-center gap-3 px-5 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium">{token.name}</span>
                    <code className="font-mono text-[10px] text-[var(--color-ink-muted)]">
                      {token.prefix}…
                    </code>
                    {token.revokedAt ? (
                      <span className="rounded bg-[var(--color-status-failed)]/15 px-1.5 py-0.5 text-[10px]">
                        revoked
                      </span>
                    ) : null}
                  </div>
                  <div className="font-mono text-[10px] text-[var(--color-ink-muted)]">
                    {projectName(token.projectId)} ·{" "}
                    {token.lastUsedAt
                      ? `last used ${formatRelativeTime(token.lastUsedAt)}`
                      : "never used"}
                  </div>
                </div>
                {token.revokedAt === null ? (
                  <form
                    action={async () => {
                      "use server";
                      const { db: database } = getServices();
                      const { requirePageContext: resolve } = await import("@/lib/viewer");
                      const current = await resolve(orgSlug);
                      requireCapability(current, "token:manage");
                      // Soft delete: an audit of "what uploaded this run" must still
                      // resolve after the token is retired.
                      await database
                        .update(schema.apiTokens)
                        .set({ revokedAt: new Date() })
                        .where(eq(schema.apiTokens.id, token.id));
                      revalidatePath(`/o/${orgSlug}/settings/tokens`);
                    }}
                  >
                    <button
                      type="submit"
                      className="text-[11px] text-[var(--color-ink-muted)] underline hover:text-[var(--color-status-failed)]"
                    >
                      revoke
                    </button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </main>
  );
}
