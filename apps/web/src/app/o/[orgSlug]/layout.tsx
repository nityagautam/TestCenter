import { listProjects } from "@testcenter/db";
import { AppShell } from "@/components/app-shell";
import { getServices } from "@/lib/services";
import { can, requirePageContext } from "@/lib/viewer";

/**
 * Every org-scoped page renders inside this layout, which means every one of them
 * passes through `requirePageContext` — the authorisation gate — before anything is
 * rendered. Putting the check here rather than in each page makes it impossible to
 * add a new page that forgets it.
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
  const projects = await listProjects(sql, context.org.id);

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
    >
      {children}
    </AppShell>
  );
}
