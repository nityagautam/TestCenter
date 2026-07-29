import postgres from "postgres";
import { requireDatabaseUrl } from "./load-env.js";

/**
 * Drops and recreates the public schema, then re-applies migrations.
 *
 * Destructive by design, so it refuses to run unless the target looks local or
 * `--force` is passed. An accidental `pnpm db:reset` against a shared database
 * would delete every team's test history.
 */
const LOCAL_HOST_PATTERN = /@(localhost|127\.0\.0\.1|\[::1\]|host\.docker\.internal)[:/]/;

async function main(): Promise<void> {
  const databaseUrl = requireDatabaseUrl();
  const force = process.argv.includes("--force");

  if (!LOCAL_HOST_PATTERN.test(databaseUrl) && !force) {
    console.error(
      "✗ refusing to reset a non-local database.\n" +
        `  DATABASE_URL does not point at localhost. Pass --force if you are certain.`,
    );
    process.exit(1);
  }

  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    console.log("→ dropping schema public");
    await sql.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    console.log("✓ schema dropped");
  } finally {
    await sql.end({ timeout: 5 });
  }

  console.log("→ re-applying migrations");
  const { migrate } = await import("../src/migrate.js");
  const result = await migrate(databaseUrl);
  console.log(`✓ applied ${result.applied.length} migration(s)`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
