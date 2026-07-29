import { eq } from "drizzle-orm";
import { createClient } from "../src/client.js";
import * as schema from "../src/schema.js";
import { requireDatabaseUrl } from "./load-env.js";

/**
 * Permanently removes an organisation and everything under it.
 *
 *   pnpm --filter @testcenter/db remove-org <slug> [--yes]
 *
 * A script rather than ad-hoc SQL because it is destructive and worth reviewing: it
 * reports exactly what will go before it goes, and refuses without confirmation. Every
 * tenant-scoped table cascades from `organizations`, which is the payoff for having put
 * `org_id` on all of them and declared the foreign keys.
 */
async function main(): Promise<void> {
  const databaseUrl = requireDatabaseUrl();
  const slug = process.argv[2];
  const confirmed = process.argv.includes("--yes");

  if (!slug) {
    console.error("usage: pnpm --filter @testcenter/db remove-org <slug> [--yes]");
    process.exit(1);
  }

  const { sql, db } = createClient({ databaseUrl, maxConnections: 2, statementTimeoutMs: 300_000 });

  try {
    const orgs = await db
      .select({ id: schema.organizations.id, name: schema.organizations.name })
      .from(schema.organizations)
      .where(eq(schema.organizations.slug, slug))
      .limit(1);
    const org = orgs[0];
    if (!org) {
      console.error(`✗ no organisation with slug "${slug}"`);
      process.exit(1);
    }

    // Counted before deleting so the operator sees the blast radius, not a bare "done".
    const counts = await sql<
      {
        projects: number;
        runs: number;
        results: number;
        cases: number;
        members: number;
        tokens: number;
      }[]
    >`
      SELECT
        (SELECT count(*)::int FROM projects      WHERE org_id = ${org.id}) AS projects,
        (SELECT count(*)::int FROM runs          WHERE org_id = ${org.id}) AS runs,
        (SELECT count(*)::int FROM test_results  WHERE org_id = ${org.id}) AS results,
        (SELECT count(*)::int FROM test_cases    WHERE org_id = ${org.id}) AS cases,
        (SELECT count(*)::int FROM memberships   WHERE org_id = ${org.id}) AS members,
        (SELECT count(*)::int FROM api_tokens    WHERE org_id = ${org.id}) AS tokens
    `;
    const summary = counts[0];

    console.log(`\n  ${org.name} (${slug})`);
    console.log(`    projects   ${summary?.projects ?? 0}`);
    console.log(`    runs       ${summary?.runs ?? 0}`);
    console.log(`    results    ${(summary?.results ?? 0).toLocaleString()}`);
    console.log(`    test cases ${summary?.cases ?? 0}`);
    console.log(`    members    ${summary?.members ?? 0}`);
    console.log(`    tokens     ${summary?.tokens ?? 0}`);

    if (!confirmed) {
      console.log(`\n  Nothing deleted. Re-run with --yes to remove all of the above.`);
      return;
    }

    const startedAt = Date.now();
    await db.delete(schema.organizations).where(eq(schema.organizations.id, org.id));

    // Artifacts in object storage are keyed by org id and are not reachable through a
    // foreign key, so say so rather than implying everything is gone.
    console.log(`\n✓ removed "${org.name}" in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    console.log(
      `  Note: uploaded report files under orgs/${org.id}/ in object storage are not ` +
        `removed by this — they expire with artifact retention.`,
    );
  } finally {
    await sql.end({ timeout: 10 });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
