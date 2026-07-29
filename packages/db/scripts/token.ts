import { createClient } from "../src/client.js";
import { generateApiToken } from "../src/bootstrap.js";
import * as schema from "../src/schema.js";
import { requireDatabaseUrl } from "./load-env.js";

/**
 * Mints a project API token for CI.
 *
 *   pnpm --filter @testcenter/db token <project-key> [name]
 *
 * The plaintext is printed once and never stored — only its sha256. A CLI rather
 * than a UI for now because CI onboarding needs this in Phase 1 while token
 * management screens are Phase 2 work.
 */
async function main(): Promise<void> {
  const databaseUrl = requireDatabaseUrl();
  const projectKey = process.argv[2];
  const name = process.argv[3] ?? "ci";

  if (!projectKey) {
    console.error("usage: pnpm --filter @testcenter/db token <project-key> [name]");
    process.exit(1);
  }

  const { sql, db } = createClient({ databaseUrl, maxConnections: 2 });
  try {
    const projects = await db
      .select({ id: schema.projects.id, orgId: schema.projects.orgId, key: schema.projects.key })
      .from(schema.projects)
      .limit(100);

    const project = projects.find((candidate) => candidate.key === projectKey);
    if (!project) {
      console.error(
        `✗ no project with key "${projectKey}". Existing: ${
          projects.map((p) => p.key).join(", ") || "(none)"
        }`,
      );
      process.exit(1);
    }

    const token = generateApiToken();
    await db.insert(schema.apiTokens).values({
      orgId: project.orgId,
      projectId: project.id,
      name,
      tokenHash: token.hash,
      tokenPrefix: token.prefix,
      scopes: ["runs:write", "runs:read"],
    });

    console.log(`✓ token "${name}" created for project ${project.key}`);
    console.log(`  ${token.plaintext}`);
    console.log(`  (shown once — store it in your CI secret manager now)`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
