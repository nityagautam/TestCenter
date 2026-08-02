import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

/**
 * Portability guardrail.
 *
 * The hosting target for Test Center is deliberately undecided (see
 * docs/test-center-plan.md §1b). That decision only stays open if infrastructure
 * SDKs never leak out of their adapter. These rules make the leak a CI failure
 * instead of something we discover during a migration.
 */
const infraModules = [
  {
    group: ["@aws-sdk/*", "@smithy/*"],
    message:
      "S3 SDK belongs in packages/adapters/src/blob/*. Depend on the BlobStore port from @testcenter/core instead.",
  },
  {
    group: ["ioredis", "bullmq", "redis"],
    message:
      "Redis/BullMQ belong in packages/adapters/src/queue/*. Depend on the Queue port from @testcenter/core instead.",
  },
  {
    group: ["pg", "postgres", "drizzle-orm/node-postgres", "drizzle-orm/postgres-js"],
    message: "Postgres drivers belong in packages/db. Import the exported db client instead.",
  },
  {
    group: ["@vercel/*", "@google-cloud/*", "@azure/*"],
    message:
      "Platform-specific SDKs are not allowed: they would pin the hosting decision. Add an adapter behind a port instead.",
  },
];

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/coverage/**",
      "**/.turbo/**",
      "**/*.sql",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "no-restricted-imports": ["error", { patterns: infraModules }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  // Adapters are the only place infrastructure SDKs may be imported.
  {
    files: ["packages/adapters/src/**/*.ts"],
    rules: { "no-restricted-imports": "off" },
  },
  // packages/db owns the Postgres driver.
  {
    files: ["packages/db/src/**/*.ts", "packages/db/scripts/**/*.ts"],
    rules: { "no-restricted-imports": "off" },
  },
  /*
   * CLI entrypoints and scripts legitimately write to stdout.
   *
   * `.mjs` is included as well as `.ts` because a script with no build step is still a
   * script — and plain ESM gets no ambient Node types from tsconfig, so `process` and
   * `console` have to be declared here or every one-off tool trips `no-undef`.
   */
  {
    files: ["**/scripts/**/*.{ts,mjs}", "apps/worker/src/index.ts", "packages/db/src/migrate.ts"],
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
    rules: { "no-console": "off" },
  },
  {
    files: ["**/*.test.ts"],
    rules: { "no-console": "off" },
  },
  prettier,
);
