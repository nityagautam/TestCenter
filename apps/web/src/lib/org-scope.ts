/**
 * The organisation the viewer last visited.
 *
 * Organisation scope normally lives in `/o/:slug`, which is the right source of truth for a
 * shared link. Neutral entry points such as `/` and `/help` have no slug to recover, though, so
 * they need a small remembered preference or they send a platform admin back to whichever
 * organisation happens to win the default sort.
 */
export const ORG_SCOPE_COOKIE = "tc_org";

/**
 * Cookie contents are never trusted as a route by themselves. Callers match this value against
 * the organisations the current viewer can access before using it.
 */
export function readOrgScope(value: string | undefined): string | null {
  const slug = value?.trim();
  return slug ? slug : null;
}

/**
 * Chooses the remembered accessible org before applying the ordinary membership preference.
 * Kept pure so the rule is tested without mocking authentication, cookies, or Postgres.
 */
export function preferredLandingOrg<
  T extends { slug: string; viaPlatformAdmin: boolean; isPersonal: boolean },
>(orgs: T[], rememberedSlug: string | null): T | undefined {
  return (
    orgs.find((org) => org.slug === rememberedSlug) ??
    orgs.find((org) => !org.viaPlatformAdmin && !org.isPersonal) ??
    orgs.find((org) => !org.viaPlatformAdmin) ??
    orgs[0]
  );
}
