import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { listProjects, orgSummary } from "@testcenter/db";
import { AppShell } from "@/components/app-shell";
import { TimezoneSync } from "@/components/timezone-sync";
import { ORG_SCOPE_COOKIE, readOrgScope } from "@/lib/org-scope";
import { PROJECT_SCOPE_COOKIE, readProjectScope } from "@/lib/project-scope";
import { readSidebarState, SIDEBAR_COOKIE } from "@/lib/sidebar";
import { getServices } from "@/lib/services";
import { readThemePreference, THEME_COOKIE } from "@/lib/theme";
import { readViewerTimeZone, TIMEZONE_COOKIE } from "@/lib/timezone";
import { can, requirePageContext, resolveLandingPath } from "@/lib/viewer";

/**
 * The authenticated application chrome for one organisation.
 *
 * Kept outside the route layout so pages whose own URL has no tenant segment — Platform Admin
 * and creating another organisation — can use the exact same header and sidebar. The org is only
 * the shell's return context on those pages; their own authorization rules remain independent.
 */
export async function OrgAppShell({ orgSlug, children }: { orgSlug: string; children: ReactNode }) {
  const context = await requirePageContext(orgSlug);
  const { sql } = getServices();
  const store = await cookies();

  const [projects, summary] = await Promise.all([
    listProjects(sql, context.org.id),
    orgSummary(sql, { orgId: context.org.id }),
  ]);

  const sidebar = readSidebarState(store.get(SIDEBAR_COOKIE)?.value);
  const theme = readThemePreference(store.get(THEME_COOKIE)?.value);
  const timeZone = readViewerTimeZone(store.get(TIMEZONE_COOKIE)?.value);

  const remembered = readProjectScope(store.get(PROJECT_SCOPE_COOKIE)?.value, orgSlug);
  const rememberedProjectKey =
    remembered && projects.some((project) => project.key === remembered) ? remembered : null;
  const rememberedOrgSlug = readOrgScope(store.get(ORG_SCOPE_COOKIE)?.value);

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
        canEditOrg: can(context, "org:edit"),
      }}
      signals={{ failing: summary.failing30d, flaky: summary.flakyTests }}
      rememberedOrgSlug={rememberedOrgSlug}
      rememberedProjectKey={rememberedProjectKey}
      initialSidebar={sidebar}
      initialTheme={theme}
    >
      <TimezoneSync current={`${timeZone.zone}|${timeZone.label}`} />
      {children}
    </AppShell>
  );
}

/**
 * Shells a route that carries no `orgSlug` by using the viewer's remembered landing scope.
 * `resolveLandingPath` has already validated both the organisation and optional project.
 */
export async function RememberedOrgAppShell({ children }: { children: ReactNode }) {
  const landing = await resolveLandingPath();
  const match = /^\/o\/([^/]+)/.exec(landing);
  if (!match?.[1]) redirect(landing);
  return <OrgAppShell orgSlug={match[1]}>{children}</OrgAppShell>;
}
