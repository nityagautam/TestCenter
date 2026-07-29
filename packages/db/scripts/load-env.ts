import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { config } from "dotenv";

/**
 * Loads .env from the repo root regardless of the directory a script is invoked
 * from, so `pnpm db:migrate` behaves the same at the root and inside the package.
 */
export function loadDotEnv(): string | null {
  let dir = process.cwd();
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) {
      config({ path: candidate });
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function requireDatabaseUrl(): string {
  loadDotEnv();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      `DATABASE_URL is not set. Copy .env.example to .env (repo root: ${resolve(process.cwd())}).`,
    );
  }
  return databaseUrl;
}
