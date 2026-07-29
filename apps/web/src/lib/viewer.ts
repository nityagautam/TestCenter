import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import {
  AccessDeniedError,
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
      const orgs = await currentOrgs();
      // Signed in with access elsewhere: send them somewhere they can actually use
      // rather than showing a dead end.
      if (orgs.length > 0 && orgs[0]) redirect(`/o/${orgs[0].slug}`);
      redirect("/no-access");
    }
    throw error;
  }
}

/** Resolves a project inside an already-authorised org, or 404s. */
export async function requirePageProject(
  context: AccessContext,
  projectKey: string,
): Promise<{ id: string; key: string; name: string; defaultBranch: string }> {
  const { sql } = getServices();
  try {
    return await requireProject(sql, context, projectKey);
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
  // Prefer a shared org over the personal one: if someone has been granted access to
  // a team, that is almost certainly what they came to look at.
  const shared = orgs.find((org) => !org.isPersonal);
  return `/o/${(shared ?? orgs[0])?.slug}`;
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
