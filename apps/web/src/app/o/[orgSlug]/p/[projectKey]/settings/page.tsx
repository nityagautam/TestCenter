import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { schema } from "@testcenter/db";
import { archiveProject, deleteProject, restoreProject } from "@/app/actions/projects";
import { PermissionDenied } from "@/components/permission-denied";
import { Card, CardHeader } from "@/components/ui";
import { formatRelativeTime } from "@/lib/format";
import { getServices } from "@/lib/services";
import { can, requirePageContext, requirePageProject } from "@/lib/viewer";

/**
 * Project settings.
 *
 * The key is deliberately not editable here. It is what CI sends, so changing it
 * silently breaks every pipeline that uses it — and the failure appears as "results
 * stopped arriving", which is hard to trace back to a settings change.
 *
 * Archiving rather than deleting is the default destructive action: results are
 * evidence, and a project someone stopped using is usually worth keeping readable.
 */
export const dynamic = "force-dynamic";

export default async function ProjectSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; projectKey: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { orgSlug, projectKey } = await params;
  const { ok, error } = await searchParams;
  const context = await requirePageContext(orgSlug);
  // Archived projects must resolve here: this is the page that un-archives them.
  const project = await requirePageProject(context, projectKey, { includeArchived: true });
  const archived = project.archivedAt !== null;

  if (!can(context, "project:edit")) {
    return (
      <PermissionDenied
        action="Editing project settings"
        requires="maintainer"
        role={context.org.role}
        orgName={context.org.name}
        backHref={`/o/${orgSlug}/p/${projectKey}`}
      />
    );
  }

  const { db } = getServices();
  const rows = await db
    .select({
      description: schema.projects.description,
      retentionDays: schema.projects.retentionDays,
      artifactRetentionDays: schema.projects.artifactRetentionDays,
      repositoryUrl: schema.projects.repositoryUrl,
    })
    .from(schema.projects)
    .where(eq(schema.projects.id, project.id))
    .limit(1);
  const detail = rows[0];

  return (
    <main className="mx-auto max-w-2xl px-6 py-6">
      <h1 className="text-lg font-semibold tracking-tight">{project.name} settings</h1>
      <p className="mt-0.5 mb-5 font-mono text-xs text-[var(--color-ink-muted)]">
        {project.key} · in {context.org.name}
      </p>

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

      <Card className="mb-5 p-5">
        <h2 className="mb-3 text-sm font-medium">Project details</h2>
        <form
          action={async (formData: FormData) => {
            "use server";
            const { db: database } = getServices();
            const { requirePageContext: resolve, can: allows } = await import("@/lib/viewer");
            const current = await resolve(orgSlug);
            if (!allows(current, "project:edit")) {
              redirect(`/o/${orgSlug}/p/${projectKey}/settings?error=Not+permitted`);
            }

            const retention = Number(formData.get("retentionDays") ?? 365);
            const artifactRetention = Number(formData.get("artifactRetentionDays") ?? 90);
            // The database has CHECK constraints on these; validating here turns a
            // constraint violation into a readable message.
            if (retention < 7 || retention > 3650) {
              redirect(
                `/o/${orgSlug}/p/${projectKey}/settings?error=Result+retention+must+be+between+7+and+3650+days`,
              );
            }
            if (artifactRetention < 1 || artifactRetention > 3650) {
              redirect(
                `/o/${orgSlug}/p/${projectKey}/settings?error=Artifact+retention+must+be+between+1+and+3650+days`,
              );
            }

            await database
              .update(schema.projects)
              .set({
                name:
                  String(formData.get("name") ?? project.name)
                    .trim()
                    .slice(0, 120) || project.name,
                description:
                  String(formData.get("description") ?? "")
                    .trim()
                    .slice(0, 500) || null,
                defaultBranch:
                  String(formData.get("defaultBranch") ?? "")
                    .trim()
                    .slice(0, 255) || "main",
                repositoryUrl: String(formData.get("repositoryUrl") ?? "").trim() || null,
                retentionDays: retention,
                artifactRetentionDays: artifactRetention,
              })
              .where(
                and(eq(schema.projects.id, project.id), eq(schema.projects.orgId, current.org.id)),
              );

            revalidatePath(`/o/${orgSlug}`, "layout");
            revalidatePath(`/o/${orgSlug}/p/${projectKey}/settings`);
            redirect(`/o/${orgSlug}/p/${projectKey}/settings?ok=Saved`);
          }}
          className="space-y-4"
        >
          <Field label="Name">
            <input
              name="name"
              required
              defaultValue={project.name}
              maxLength={120}
              className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-2 text-xs outline-none focus:border-[var(--color-ink-muted)]"
            />
          </Field>

          <Field label="Key" hint="not editable — CI sends this">
            <input
              value={project.key}
              readOnly
              disabled
              className="w-full cursor-not-allowed rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-2 font-mono text-xs opacity-60"
            />
          </Field>

          <Field label="Default branch">
            <input
              name="defaultBranch"
              defaultValue={project.defaultBranch}
              maxLength={255}
              className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-2 font-mono text-xs outline-none focus:border-[var(--color-ink-muted)]"
            />
          </Field>

          <Field label="Repository URL" hint="optional">
            <input
              name="repositoryUrl"
              type="url"
              defaultValue={detail?.repositoryUrl ?? ""}
              className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-2 font-mono text-xs outline-none focus:border-[var(--color-ink-muted)]"
            />
          </Field>

          <Field label="Description" hint="optional">
            <textarea
              name="description"
              rows={2}
              maxLength={500}
              defaultValue={detail?.description ?? ""}
              className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-2 text-xs outline-none focus:border-[var(--color-ink-muted)]"
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Result retention (days)" hint="7–3650">
              <input
                name="retentionDays"
                type="number"
                min={7}
                max={3650}
                defaultValue={detail?.retentionDays ?? 365}
                className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-2 font-mono text-xs outline-none focus:border-[var(--color-ink-muted)]"
              />
            </Field>
            <Field label="Artifact retention (days)" hint="1–3650">
              <input
                name="artifactRetentionDays"
                type="number"
                min={1}
                max={3650}
                defaultValue={detail?.artifactRetentionDays ?? 90}
                className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-2 font-mono text-xs outline-none focus:border-[var(--color-ink-muted)]"
              />
            </Field>
          </div>
          <p className="text-[11px] leading-relaxed text-[var(--color-ink-muted)]">
            Results are dropped a whole month at a time by dropping their partition, so the
            effective cutoff rounds to a month boundary rather than the exact day.
          </p>

          <button
            type="submit"
            className="rounded-md bg-[var(--color-ink)] px-4 py-2 text-sm font-medium text-[var(--color-surface)] hover:opacity-90"
          >
            Save changes
          </button>
        </form>
      </Card>

      {can(context, "project:archive") ? (
        <Card className="mb-5">
          <CardHeader title={archived ? "Restore project" : "Archive project"} />
          <div className="px-5 py-4">
            {archived ? (
              <>
                <p className="mb-3 text-xs leading-relaxed text-[var(--color-ink-muted)]">
                  This project was archived {formatRelativeTime(project.archivedAt)}. It is hidden
                  from lists and dashboards and accepts no uploads, but every run and result is
                  still stored. Restoring puts it back exactly as it was.
                </p>
                <form action={restoreProject.bind(null, orgSlug, project.key)}>
                  <button
                    type="submit"
                    className="rounded-md bg-[var(--color-ink)] px-3 py-1.5 text-xs font-medium text-[var(--color-surface)] hover:opacity-90"
                  >
                    Restore {project.key}
                  </button>
                </form>
              </>
            ) : (
              <>
                <p className="mb-3 text-xs leading-relaxed text-[var(--color-ink-muted)]">
                  Archiving hides the project and stops it accepting uploads. Results are kept and
                  stay readable — test history is evidence, so nothing is deleted here, and you can
                  restore it from this page at any time.
                </p>
                <form action={archiveProject.bind(null, orgSlug, project.key)}>
                  <button
                    type="submit"
                    className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs font-medium hover:border-[var(--color-ink-muted)]"
                  >
                    Archive {project.key}
                  </button>
                </form>
              </>
            )}
          </div>
        </Card>
      ) : null}

      {/*
       * Deletion is separated from archiving, visually and by role.
       *
       * They used to be one control — the button said "Archive" and the capability was called
       * `project:delete` — which left no way to actually delete and no way to un-archive.
       * They are different actions with different consequences, so they look different: this
       * one is the only card on the page with a red border, it is owner-only, and it will not
       * proceed without the project key typed by hand. A destructive action reachable by one
       * click is a destructive action that happens by accident.
       */}
      {can(context, "project:delete") ? (
        <Card className="border-[var(--color-status-failed)]/40">
          <CardHeader title="Delete project permanently" />
          <div className="px-5 py-4">
            <p className="mb-1 text-xs leading-relaxed text-[var(--color-ink-muted)]">
              Deletes {project.key} together with{" "}
              <span className="text-[var(--color-ink)]">every run, result and API token</span> under
              it. This cannot be undone and the history cannot be recovered.
            </p>
            <p className="mb-3 text-xs leading-relaxed text-[var(--color-ink-muted)]">
              If the intent is only to stop using the project, archive it instead — that keeps the
              history and is reversible.
            </p>
            <form
              action={deleteProject.bind(null, orgSlug, project.key)}
              className="flex flex-wrap items-end gap-2"
            >
              <label className="block">
                <span className="mb-1 block text-[11px] text-[var(--color-ink-muted)]">
                  Type <span className="font-mono text-[var(--color-ink)]">{project.key}</span> to
                  confirm
                </span>
                <input
                  name="confirm"
                  autoComplete="off"
                  aria-label={`Type ${project.key} to confirm deletion`}
                  className="w-56 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1.5 font-mono text-xs outline-none focus:border-[var(--color-status-failed)]"
                />
              </label>
              <button
                type="submit"
                className="rounded-md border border-[var(--color-status-failed)]/50 px-3 py-1.5 text-xs font-medium text-[var(--color-status-failed)] hover:bg-[var(--color-status-failed)]/5"
              >
                Delete permanently
              </button>
            </form>
          </div>
        </Card>
      ) : null}
    </main>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium">
        {label}
        {hint ? (
          <span className="ml-1.5 font-normal text-[var(--color-ink-muted)]">({hint})</span>
        ) : null}
      </span>
      {children}
    </label>
  );
}
