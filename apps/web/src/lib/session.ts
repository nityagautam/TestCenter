import "server-only";
import { schema } from "@testcenter/db";
import { getServices } from "@/lib/services";

/**
 * Resolves the org for a page render.
 *
 * Pages need the same tenant scoping as the API, but without the API's token
 * handling. Kept separate from `authenticate()` so a page never accidentally depends
 * on request headers it does not have.
 *
 * We ship as a single internal org (docs/test-center-plan.md §1b), so this resolves
 * to the only org. The signature already takes the shape it will need when
 * membership actually selects between orgs, so callers will not change.
 */
export async function currentOrgId(): Promise<string | null> {
  const { db } = getServices();
  const orgs = await db.select({ id: schema.organizations.id }).from(schema.organizations).limit(1);
  return orgs[0]?.id ?? null;
}
