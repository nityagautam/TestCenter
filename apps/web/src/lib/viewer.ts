import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  AccessDeniedError,
  findProjectByKey,
  findViewerByEmail,
  listAccessibleOrgs,
  requireOrgAccess,
  requireProject,
  roleAllows,
  type AccessContext,
  type AccessibleOrg,
  type Capability,
  type Viewer,
} from "@testcenter/db";
import { auth } from "@/auth";
import { getServices } from "@/lib/services";
import { ORG_SCOPE_COOKIE, preferredLandingOrg, readOrgScope } from "@/lib/org-scope";
import { PROJECT_SCOPE_COOKIE, readProjectScope } from "@/lib/project-scope";

/**
 * Page-side access resolution.
 *
 * Wrapped in React's `cache` so a single render resolves the viewer and their
 * organisations once, no matter how many components ask. Without it, a page with a
 * header switcher, a nav and a body would issue the same membership query three
 * times per request.
 *
 * Pages call `requirePageContext` and get an authorised context or a redirect —
 * there is deliberately no way to obtain an org id without passing the check.
 */
export const currentViewer = cache(async (): Promise<Viewer | null> => {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return null;

  const { db } = getServices();
  return findViewerByEmail(db, email.toLowerCase());
});

export const currentOrgs = cache(async (): Promise<AccessibleOrg[]> => {
  const viewer = await currentViewer();
  if (!viewer) return [];
  const { db } = getServices();
  return listAccessibleOrgs(db, viewer);
});

/**
 * Sends an unauthenticated visitor to sign-in, and a signed-in user who has not
 * finished onboarding to the onboarding flow.
 *
 * Returning the viewer rather than a boolean means the caller cannot forget to use
 * the result.
 */
export async function requireViewer(): Promise<Viewer> {
  const viewer = await currentViewer();
  if (!viewer) redirect("/signin");
  return viewer;
}

export interface PageContext extends AccessContext {
  /** Every org this viewer may switch to, for the header dropdown. */
  orgs: AccessibleOrg[];
}

/**
 * Resolves an org from the URL and proves the viewer may see it.
 *
 * A viewer with no access lands on `/no-access` rather than a 403 page, because the
 * common cause is a legitimate new user waiting for an admin to grant them
 * something — an error page would read as a broken product.
 */
export async function requirePageContext(orgSlug: string): Promise<PageContext> {
  const viewer = await requireViewer();
  const { db } = getServices();

  /*
   * Onboarding is about giving someone somewhere to go, so it is keyed on whether
   * they actually have access — not on the flag alone.
   *
   * Someone granted access by an administrator has never been through onboarding and
   * never needs to: sending them there would bounce a legitimate member away from the
   * organisation they were just added to. The flag only matters when they also have
   * nothing to look at.
   */
  const accessible = await currentOrgs();
  if (accessible.length === 0) redirect(viewer.onboarded ? "/no-access" : "/onboarding");

  try {
    const context = await requireOrgAccess(db, viewer, orgSlug);
    const orgs = await currentOrgs();
    return { ...context, orgs };
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      // Signed in with access elsewhere: send them somewhere they can actually use
      // rather than showing a dead end. Same preference order as the landing path.
      const fallback = await resolveLandingPath();
      redirect(fallback);
    }
    throw error;
  }
}

/** Resolves a project inside an already-authorised org, or 404s. */
export async function requirePageProject(
  context: AccessContext,
  projectKey: string,
  options: { includeArchived?: boolean } = {},
): Promise<{
  id: string;
  key: string;
  name: string;
  defaultBranch: string;
  archivedAt: Date | null;
}> {
  /*
   * `includeArchived` is for the settings page only.
   *
   * Every other project page stays 404 for an archived project — an archived project should
   * not be accepting uploads or presenting dashboards as though it were live. But settings
   * has to resolve it, because settings is where un-archiving happens, and excluding it
   * there made archiving irreversible.
   */
  const { sql } = getServices();
  try {
    return await requireProject(sql, context, projectKey, options);
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      const { notFound } = await import("next/navigation");
      notFound();
    }
    throw error;
  }
}

/**
 * Where to send someone who arrives at the root.
 *
 * Deliberately explicit about all four states — signed out, mid-onboarding, no
 * access, and has-orgs — because each one has a different correct destination and
 * conflating them is how users end up staring at an empty page.
 */
export async function resolveLandingPath(): Promise<string> {
  const viewer = await currentViewer();
  if (!viewer) return "/signin";
  const orgs = await currentOrgs();
  // Access decides the destination, not the onboarding flag — a granted member should
  // land in their organisation rather than being asked to create one.
  if (orgs.length === 0) return viewer.onboarded ? "/no-access" : "/onboarding";

  /*
   * Preference order matters most for platform admins, who can see *every*
   * organisation. Picking the first alphabetically landed them in whichever empty
   * org sorted earliest rather than the one they actually work in, which reads as
   * "the product lost my data".
   *
   * So: an organisation they are really a member of wins; a shared one beats their
   * personal space; and orgs visible only through platform admin come last.
   */
  const store = await cookies();
  const rememberedOrgSlug = readOrgScope(store.get(ORG_SCOPE_COOKIE)?.value);
  const byPreference = preferredLandingOrg(orgs, rememberedOrgSlug);

  if (!byPreference) return "/no-access";

  /*
   * Project memory is already qualified by organisation. Validate the key against the chosen
   * org before putting it back in a path: a deleted, archived or newly-inaccessible project
   * falls back to the organisation dashboard rather than producing a stale 404.
   */
  const rememberedProjectKey = readProjectScope(
    store.get(PROJECT_SCOPE_COOKIE)?.value,
    byPreference.slug,
  );
  if (rememberedProjectKey) {
    const { sql } = getServices();
    const project = await findProjectByKey(sql, {
      orgId: byPreference.id,
      key: rememberedProjectKey,
    });
    if (project) return `/o/${byPreference.slug}/p/${project.key}`;
  }

  return `/o/${byPreference.slug}`;
}

/**
 * Capability check for conditional UI (hiding an Upload button from a viewer).
 *
 * Delegates to the same `roleAllows` the server-side gate uses rather than keeping a
 * second copy of the rank table here — two tables would drift, and the UI would end
 * up offering actions the API then refuses.
 */
export function can(context: AccessContext, capability: Capability): boolean {
  return roleAllows(context.org.role, capability);
}
