import { cookies } from "next/headers";
import { listProjects, orgSummary } from "@testcenter/db";
import { PROJECT_SCOPE_COOKIE, readProjectScope } from "@/lib/project-scope";
import { readSidebarState, SIDEBAR_COOKIE } from "@/lib/sidebar";
import { readThemePreference, THEME_COOKIE } from "@/lib/theme";
import { AppShell } from "@/components/app-shell";
import { getServices } from "@/lib/services";
import { can, requirePageContext } from "@/lib/viewer";

/**
 * Every org-scoped page renders inside this layout, which means every one of them passes
 * through `requirePageContext` — the authorisation gate — before anything is rendered.
 * Putting the check here rather than in each page makes it impossible to add a new page
 * that forgets it.
 */
export default async function OrgLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requirePageContext(orgSlug);

  const { sql } = getServices();
  const store = await cookies();

  // The nav counts come from the same rollups the dashboard reads, so the rail agrees
  // with the page rather than telling a slightly different story.
  const [projects, summary] = await Promise.all([
    listProjects(sql, context.org.id),
    orgSummary(sql, { orgId: context.org.id }),
  ]);

  const sidebar = readSidebarState(store.get(SIDEBAR_COOKIE)?.value);
  const theme = readThemePreference(store.get(THEME_COOKIE)?.value);

  /*
   * Read here, in the server render, so a page whose URL carries no project still arrives
   * with the right project selected rather than correcting itself after hydration.
   *
   * Validated against the projects this viewer can actually see, so a project that has been
   * deleted, renamed, or had access revoked cannot leave a phantom selection in the header
   * pointing at something that is no longer there.
   */
  const remembered = readProjectScope(store.get(PROJECT_SCOPE_COOKIE)?.value, orgSlug);
  const rememberedProjectKey =
    remembered && projects.some((project) => project.key === remembered) ? remembered : null;

  return (
    <AppShell
      orgSlug={orgSlug}
      orgs={context.orgs.map((org) => ({
        slug: org.slug,
        name: org.name,
        isPersonal: org.isPersonal,
        role: org.role,
        viaPlatformAdmin: org.viaPlatformAdmin,
      }))}
      projects={projects.map((project) => ({ key: project.key, name: project.name }))}
      viewer={{
        email: context.viewer.email,
        name: context.viewer.name,
        isPlatformAdmin: context.viewer.isPlatformAdmin,
      }}
      capabilities={{
        canCreateProject: can(context, "project:create"),
        canUpload: can(context, "run:upload"),
        canManageMembers: can(context, "member:manage"),
      }}
      signals={{ failing: summary.failing30d, flaky: summary.flakyTests }}
      rememberedProjectKey={rememberedProjectKey}
      initialSidebar={sidebar}
      initialTheme={theme}
    >
      {children}
    </AppShell>
  );
}
