import Link from "next/link";
import { listProjects } from "@testcenter/db";
import { Button, Card, CardHeader, EmptyState } from "@/components/ui";
import { formatPercent, formatRelativeTime } from "@/lib/format";
import { getServices } from "@/lib/services";
import { can, requirePageContext } from "@/lib/viewer";

export const dynamic = "force-dynamic";

export default async function ProjectsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const context = await requirePageContext(orgSlug);
  const { sql } = getServices();
  const projects = await listProjects(sql, context.org.id);
  const mayCreate = can(context, "project:create");

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
              </li>
            ))}
          </ul>
        )}
      </Card>
    </main>
  );
}
