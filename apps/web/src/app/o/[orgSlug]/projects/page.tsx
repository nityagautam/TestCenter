import Link from "next/link";
import { listProjects } from "@testcenter/db";
import { restoreProject } from "@/app/actions/projects";
import { Button, Card, CardHeader, EmptyState } from "@/components/ui";
import { formatPercent, formatRelativeTime } from "@/lib/format";
import { getServices } from "@/lib/services";
import { can, requirePageContext } from "@/lib/viewer";

export const dynamic = "force-dynamic";

export default async function ProjectsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { orgSlug } = await params;
  const { ok, error } = await searchParams;
  const context = await requirePageContext(orgSlug);
  const { sql } = getServices();

  /*
   * Fetched with archived included, then split.
   *
   * Archiving previously removed a project from every list, including this one, so the only
   * way back to it was to remember and type its settings URL. An archive nobody can browse
   * is a delete with extra steps — so archived projects get their own quiet section here,
   * each with the action that undoes it.
   */
  const all = await listProjects(sql, context.org.id, { includeArchived: true });
  const projects = all.filter((project) => project.archivedAt === null);
  const archived = all.filter((project) => project.archivedAt !== null);
  const mayCreate = can(context, "project:create");
  const mayArchive = can(context, "project:archive");

  return (
    <main className="mx-auto max-w-5xl px-6 py-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Projects</h1>
          <p className="mt-0.5 text-xs text-[var(--color-ink-muted)]">
            A project groups results from one codebase or suite.
          </p>
        </div>
        {mayCreate ? (
          <Button href={`/o/${orgSlug}/projects/new`} variant="primary">
            New project
          </Button>
        ) : null}
      </div>

      {ok ? (
        <p className="mb-4 rounded-md border border-[var(--color-status-passed)]/40 bg-[var(--color-status-passed)]/5 px-3 py-2 text-xs text-[var(--color-status-passed)]">
          {ok}
        </p>
      ) : null}
      {error ? (
        <p className="mb-4 rounded-md border border-[var(--color-status-failed)]/40 bg-[var(--color-status-failed)]/5 px-3 py-2 text-xs text-[var(--color-status-failed)]">
          {error}
        </p>
      ) : null}

      <Card className="overflow-hidden">
        <CardHeader title={`${projects.length} project${projects.length === 1 ? "" : "s"}`} />
        {projects.length === 0 ? (
          <EmptyState
            title="No projects yet"
            description={
              mayCreate
                ? "Create a project, then upload a JUnit XML report from CI or the browser."
                : `Your role in this organisation is ${context.org.role}, which cannot create projects. Ask an administrator.`
            }
            action={
              mayCreate ? (
                <Button href={`/o/${orgSlug}/projects/new`} variant="primary">
                  Create a project
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ul className="divide-y divide-[var(--color-border-subtle)]">
            {projects.map((project) => (
              <li key={project.id} className="flex items-center gap-4 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/o/${orgSlug}/p/${project.key}`}
                    className="text-sm font-medium hover:underline"
                  >
                    {project.name}
                  </Link>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 font-mono text-[10px] text-[var(--color-ink-muted)]">
                    <span>{project.key}</span>
                    <span>
                      {project.lastRunAt
                        ? `last run ${formatRelativeTime(project.lastRunAt)}`
                        : "no runs yet"}
                    </span>
                    {project.runs7d > 0 ? <span>{project.runs7d} runs / 7d</span> : null}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  {project.passRate7d !== null ? (
                    <div className="font-mono text-xs tabular-nums">
                      {formatPercent(project.passRate7d)}
                    </div>
                  ) : (
                    <div className="text-[10px] text-[var(--color-ink-muted)]">—</div>
                  )}
                  <div className="text-[10px] text-[var(--color-ink-muted)]">7d avg</div>
                </div>
                {can(context, "run:upload") ? (
                  <Link
                    href={`/o/${orgSlug}/p/${project.key}/upload`}
                    className="shrink-0 rounded-md border border-[var(--color-border-subtle)] px-2 py-1 text-[11px] hover:border-[var(--color-ink-muted)]"
                  >
                    Upload
                  </Link>
                ) : null}
                {can(context, "project:edit") ? (
                  <Link
                    href={`/o/${orgSlug}/p/${project.key}/settings`}
                    className="shrink-0 text-[11px] text-[var(--color-ink-muted)] underline hover:text-[var(--color-ink)]"
                  >
                    Settings
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {archived.length > 0 ? (
        <Card className="mt-5 overflow-hidden">
          <CardHeader
            title={`${archived.length} archived`}
            action={
              <span className="text-[11px] text-[var(--color-ink-muted)]">
                hidden from dashboards · results kept
              </span>
            }
          />
          <ul className="divide-y divide-[var(--color-border-subtle)]">
            {archived.map((project) => (
              <li key={project.id} className="flex items-center gap-4 px-5 py-3">
                <div className="min-w-0 flex-1">
                  {/* Deliberately not a link to the project: its pages stay 404 while
                      archived. Settings is the one page that resolves it, because settings is
                      where it gets restored. */}
                  <div className="truncate text-sm text-[var(--color-ink-muted)]">
                    {project.name}
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 font-mono text-[10px] text-[var(--color-ink-muted)]">
                    <span>{project.key}</span>
                    <span>archived {formatRelativeTime(project.archivedAt)}</span>
                  </div>
                </div>
                {mayArchive ? (
                  <>
                    <form action={restoreProject.bind(null, orgSlug, project.key)}>
                      <button
                        type="submit"
                        className="shrink-0 rounded-md border border-[var(--color-border-subtle)] px-2 py-1 text-[11px] hover:border-[var(--color-ink-muted)]"
                      >
                        Restore
                      </button>
                    </form>
                    <Link
                      href={`/o/${orgSlug}/p/${project.key}/settings`}
                      className="shrink-0 text-[11px] text-[var(--color-ink-muted)] underline hover:text-[var(--color-ink)]"
                    >
                      Settings
                    </Link>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </main>
  );
}
