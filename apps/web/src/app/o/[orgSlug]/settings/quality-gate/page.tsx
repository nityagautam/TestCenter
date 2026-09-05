import { redirect } from "next/navigation";
import { getGateLayer, listProjects } from "@testcenter/db";
import { Card } from "@/components/ui";
import { gatePatchFromForm, QualityGateSettings } from "@/features/quality-gate-settings";
import { getServices } from "@/lib/services";
import { can, requirePageContext } from "@/lib/viewer";
import Link from "next/link";

/**
 * The organisation-wide quality gate.
 *
 * A page of its own rather than a card on organisation settings, and the reason is what the two
 * screens are for. Organisation settings describe the organisation — its name, who is in it. This
 * decides what happens to every run uploaded to every project from now on, which is a different
 * kind of thing and the thing somebody comes looking for by name after a build was gated.
 *
 * It is the *floor*, not the whole policy: a project can tighten it, and a branch under a project
 * can tighten it again. The list at the bottom says which projects have done so, because the
 * common failure of layered configuration is an administrator changing a default and never
 * learning that four projects had already overridden it.
 */
export const dynamic = "force-dynamic";

export default async function OrgQualityGatePage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { orgSlug } = await params;
  const { ok, error } = await searchParams;
  const context = await requirePageContext(orgSlug);

  /*
   * Deliberately no permission wall. Everyone whose runs are judged by this policy can read it —
   * a rule you can only discover by failing it is a bad rule, and "why did my build get gated"
   * is the question this page exists to answer for exactly the people who cannot change it.
   *
   * Editing is a different matter: the organisation gate is the floor under every project at
   * once, so it is owner-only. A platform admin counts, since they administer every organisation
   * by definition.
   */
  const canEdit = can(context, "gate:manage-org") || context.viewer.isPlatformAdmin;

  const { sql } = getServices();
  const [gateLayer, projects] = await Promise.all([
    getGateLayer(sql, { orgId: context.org.id, projectId: null, branch: null }),
    listProjects(sql, context.org.id, { includeArchived: true }),
  ]);

  /*
   * Which projects override this floor. One query rather than one per project, and it reads the
   * policy table directly instead of resolving each project — the question here is "who has a
   * layer of their own", not "what does each project end up with".
   */
  const overrides = await sql<{ projectId: string; branch: string | null }[]>`
    SELECT project_id AS "projectId", branch
    FROM quality_gates
    WHERE org_id = ${context.org.id} AND project_id IS NOT NULL
    ORDER BY project_id, branch NULLS FIRST
  `;
  const byProject = new Map<string, string[]>();
  for (const row of overrides) {
    const list = byProject.get(row.projectId) ?? [];
    list.push(row.branch ?? "project-wide");
    byProject.set(row.projectId, list);
  }

  return (
    /*
     * Wider than the other settings pages, on purpose. Those are short forms about one object; this
     * one carries a policy summary, seven controls and a list of projects that override it, and at
     * a 42rem measure the summary and the form become a long single column that has to be scrolled
     * to compare. Full width below lg, where 80% would only add margins to a phone.
     */
    <main className="mx-auto w-full px-6 py-6 lg:w-4/5">
      <h1 className="text-lg font-semibold tracking-tight">Quality gate</h1>
      <p className="mt-0.5 mb-5 max-w-3xl text-xs leading-relaxed text-[var(--color-ink-muted)]">
        The default for every project in {context.org.name}. A project can tighten it, switch it off
        for itself, or override it per branch.
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

      <QualityGateSettings
        scope="org"
        layer={gateLayer}
        layers={[{ scope: "org", config: gateLayer }]}
        canEdit={canEdit}
        wide
        showHeading={false}
        readOnlyNote="Read-only — only an organisation owner can change the global quality gate. You can see everything it applies."
        description=""
        action={async (formData: FormData) => {
          "use server";
          const { requirePageContext: resolve, can: allows } = await import("@/lib/viewer");
          const current = await resolve(orgSlug);
          // Re-checked here and not merely in the render: a disabled input is a convenience, and
          // the form posts to a server action that anyone can reach.
          if (!allows(current, "gate:manage-org") && !current.viewer.isPlatformAdmin) {
            redirect(
              `/o/${orgSlug}/settings/quality-gate?error=Only+an+organisation+owner+can+change+the+global+gate`,
            );
          }
          const { sql: db } = getServices();
          const {
            saveGateLayer: save,
            deleteGateLayer: drop,
            reevaluateGateForScope: rejudge,
          } = await import("@testcenter/db");

          if (formData.get("reset")) {
            await drop(db, { orgId: current.org.id, projectId: null, branch: null });
            const cleared = await rejudge(db, { orgId: current.org.id });
            redirect(
              `/o/${orgSlug}/settings/quality-gate?ok=${encodeURIComponent(
                `Policy cleared. ${cleared} run${cleared === 1 ? "" : "s"} re-checked against the built-in checks.`,
              )}`,
            );
          }

          await save(db, {
            orgId: current.org.id,
            projectId: null,
            branch: null,
            config: gatePatchFromForm(formData),
            userId: current.viewer.userId,
          });
          /*
           * Apply it to the runs already here, not only to the next upload. Saving a policy that
           * visibly changes nothing is the behaviour this replaced: the rules were correct and
           * every run on screen still showed the ones it was judged against.
           */
          const judged = await rejudge(db, { orgId: current.org.id });
          redirect(
            `/o/${orgSlug}/settings/quality-gate?ok=${encodeURIComponent(
              `Saved. ${judged} existing run${judged === 1 ? "" : "s"} re-checked.`,
            )}`,
          );
        }}
      />

      {/*
       * Its own section, deliberately outside the policy card.
       *
       * It answers a different question — not "what is the rule" but "who is not following it" —
       * and it is the one part of this page that grows without bound: an organisation with two
       * hundred projects can have two hundred rows here, and nesting an unbounded list inside a
       * form makes the Save button recede down the page as the organisation grows.
       */}
      <Card className="p-5">
        <h2 className="text-sm font-medium">Projects that override this</h2>
        <p className="mt-1 mb-3 text-xs leading-relaxed text-[var(--color-ink-muted)]">
          Changes above do not reach these. Listed so a default that appears to have no effect is
          explainable rather than mysterious.
        </p>
        {byProject.size === 0 ? (
          <p className="text-[12px] text-[var(--color-ink-muted)]">
            None — every project follows this policy.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--color-border-subtle)] text-[12px]">
            {projects
              .filter((project) => byProject.has(project.id))
              .map((project) => (
                <li key={project.id} className="flex items-baseline justify-between gap-3 py-1.5">
                  <Link
                    href={`/o/${orgSlug}/p/${project.key}/settings`}
                    className="min-w-0 truncate hover:underline"
                  >
                    {project.name}
                  </Link>
                  <span className="shrink-0 font-mono text-[11px] text-[var(--color-ink-muted)]">
                    {byProject.get(project.id)!.join(", ")}
                  </span>
                </li>
              ))}
          </ul>
        )}
      </Card>
    </main>
  );
}
