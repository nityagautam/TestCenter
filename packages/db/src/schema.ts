import {
  bigint,
  bigserial,
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { Tags } from "@testcenter/core";

/**
 * Drizzle schema — typed query surface over the schema defined in sql/.
 *
 * DDL deliberately lives in hand-written migrations (partitioning, partial
 * indexes, generated columns, plpgsql), so this file must mirror them rather than
 * generate them. `pnpm --filter @testcenter/db test` asserts the two stay in sync
 * against a real database.
 */

/** sha256 digests and token hashes: bytea is half the size of hex text. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const organizations = pgTable("organizations", {
  id: uuid("id")
    .primaryKey()
    .default(sql`uuidv7()`),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  /** Set when this org was auto-created as a user's personal space. */
  personalForUserId: uuid("personal_for_user_id"),
  createdBy: uuid("created_by"),
  maxProjects: integer("max_projects").notNull().default(50),
  maxRunsPerDay: integer("max_runs_per_day").notNull().default(5000),
  ...timestamps,
});

export const users = pgTable("users", {
  id: uuid("id")
    .primaryKey()
    .default(sql`uuidv7()`),
  email: text("email").notNull(),
  name: text("name"),
  avatarUrl: text("avatar_url"),
  googleSub: text("google_sub").unique(),
  status: text("status").notNull().default("active"),
  /**
   * Platform admins see and grant access to every org. Seeded from
   * TESTCENTER_ADMIN_EMAILS at login, never grantable from inside the app.
   */
  isPlatformAdmin: boolean("is_platform_admin").notNull().default(false),
  onboardedAt: timestamp("onboarded_at", { withTimezone: true }),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  ...timestamps,
});

export const teams = pgTable(
  "teams",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    chatChannel: text("chat_channel"),
    ...timestamps,
  },
  (table) => [uniqueIndex("teams_org_slug_key").on(table.orgId, table.slug)],
);

export type MembershipRole = "owner" | "admin" | "maintainer" | "member" | "viewer";

export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }),
    role: text("role").$type<MembershipRole>().notNull(),
    /**
     * Set instead of userId when access was granted to someone who has not signed
     * in yet; bound to the account on first login.
     */
    invitedEmail: text("invited_email"),
    grantedBy: uuid("granted_by"),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [index("memberships_user_idx").on(table.userId)],
);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "set null" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    defaultBranch: text("default_branch").notNull().default("main"),
    repositoryUrl: text("repository_url"),
    retentionDays: integer("retention_days").notNull().default(365),
    artifactRetentionDays: integer("artifact_retention_days").notNull().default(90),
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    createdBy: uuid("created_by"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("projects_org_key_key").on(table.orgId, table.key),
    index("projects_team_idx").on(table.orgId, table.teamId),
  ],
);

export const apiTokens = pgTable(
  "api_tokens",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: bytea("token_hash").notNull().unique(),
    tokenPrefix: text("token_prefix").notNull(),
    scopes: text("scopes").array().notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (table) => [index("api_tokens_org_idx").on(table.orgId, table.projectId)],
);

export type RunStatus = "pending" | "parsing" | "complete" | "partial" | "failed";

export const runs = pgTable(
  "runs",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name"),
    framework: text("framework"),
    frameworkVersion: text("framework_version"),
    status: text("status").$type<RunStatus>().notNull().default("pending"),

    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),

    environment: text("environment"),
    branch: text("branch"),
    commitSha: text("commit_sha"),
    prNumber: integer("pr_number"),

    ciProvider: text("ci_provider"),
    ciBuildId: text("ci_build_id"),
    ciBuildNumber: text("ci_build_number"),
    ciJobName: text("ci_job_name"),
    ciJobUrl: text("ci_job_url"),

    runGroupId: text("run_group_id"),
    shardIndex: integer("shard_index"),
    shardTotal: integer("shard_total"),
    attempt: integer("attempt").notNull().default(1),

    total: integer("total").notNull().default(0),
    passed: integer("passed").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    skipped: integer("skipped").notNull().default(0),
    errored: integer("errored").notNull().default(0),
    blocked: integer("blocked").notNull().default(0),
    flaky: integer("flaky").notNull().default(0),
    passRate: numeric("pass_rate", { precision: 5, scale: 2 }).notNull().default("0"),

    tags: jsonb("tags").$type<Tags>().notNull().default({}),
    warnings: jsonb("warnings").$type<{ code: string; message: string }[]>().notNull().default([]),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdByTokenId: uuid("created_by_token_id").references(() => apiTokens.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (table) => [
    index("runs_project_started_idx").on(table.projectId, table.startedAt.desc()),
    index("runs_project_branch_started_idx").on(
      table.projectId,
      table.branch,
      table.startedAt.desc(),
    ),
    index("runs_project_status_idx").on(table.projectId, table.status, table.startedAt.desc()),
    index("runs_org_started_idx").on(table.orgId, table.startedAt.desc()),
  ],
);

export const artifacts = pgTable(
  "artifacts",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    storageKey: text("storage_key").notNull().unique(),
    bytes: bigint("bytes", { mode: "number" }),
    contentType: text("content_type"),
    sha256: bytea("sha256"),
    declaredFormat: text("declared_format"),
    detectedFormat: text("detected_format"),
    detectConfidence: numeric("detect_confidence", { precision: 3, scale: 2 }),
    parserVersion: text("parser_version"),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("artifacts_run_idx").on(table.runId),
    index("artifacts_project_created_idx").on(table.projectId, table.createdAt.desc()),
  ],
);

export type IngestStage =
  "detect" | "parse" | "normalize" | "persist" | "merge" | "rollup" | "analyze" | "notify";
export type IngestState = "queued" | "running" | "succeeded" | "failed" | "dead";

export const ingestJobs = pgTable(
  "ingest_jobs",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "cascade" }),
    stage: text("stage").$type<IngestStage>().notNull().default("detect"),
    state: text("state").$type<IngestState>().notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    errorMessage: text("error_message"),
    errorStack: text("error_stack"),
    timings: jsonb("timings").$type<Record<string, number>>().notNull().default({}),
    resultsWritten: integer("results_written").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("ingest_jobs_state_idx").on(table.state, table.createdAt.desc()),
    index("ingest_jobs_artifact_idx").on(table.artifactId),
  ],
);

export const testCases = pgTable(
  "test_cases",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    fingerprint: bytea("fingerprint").notNull(),
    fingerprintVersion: smallint("fingerprint_version").notNull().default(1),

    suite: text("suite"),
    classname: text("classname"),
    name: text("name").notNull(),
    parameters: jsonb("parameters").$type<Record<string, unknown>>(),

    ownerTeamId: uuid("owner_team_id").references(() => teams.id, { onDelete: "set null" }),

    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastStatus: text("last_status"),

    runs30d: integer("runs_30d").notNull().default(0),
    failures30d: integer("failures_30d").notNull().default(0),
    failRate30d: numeric("fail_rate_30d", { precision: 5, scale: 2 }).notNull().default("0"),
    flakeScore: numeric("flake_score", { precision: 5, scale: 2 }).notNull().default("0"),
    avgDurationMs: integer("avg_duration_ms"),
    p95DurationMs: integer("p95_duration_ms"),

    quarantined: boolean("quarantined").notNull().default(false),
    quarantinedAt: timestamp("quarantined_at", { withTimezone: true }),
    quarantineReason: text("quarantine_reason"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("test_cases_fingerprint_key").on(
      table.projectId,
      table.fingerprint,
      table.fingerprintVersion,
    ),
    index("test_cases_project_seen_idx").on(table.projectId, table.lastSeenAt.desc()),
  ],
);

export type TestResultStatus = "passed" | "failed" | "skipped" | "error" | "blocked";

/**
 * Partitioned by range on started_at (monthly). Drizzle has no partitioning DSL,
 * so the table shape is mirrored here for queries while sql/0001_init.sql owns the
 * PARTITION BY clause and the DEFAULT partition.
 */
export const testResults = pgTable(
  "test_results",
  {
    // Mirrors `DEFAULT nextval('test_results_id_seq')`. An explicit sequence is
    // used instead of an identity column because identity on partitioned tables
    // has had version-specific restrictions; declaring the default here is what
    // makes `id` optional on insert.
    id: bigint("id", { mode: "number" })
      .notNull()
      .default(sql`nextval('test_results_id_seq')`),
    orgId: uuid("org_id").notNull(),
    projectId: uuid("project_id").notNull(),
    runId: uuid("run_id").notNull(),
    testCaseId: bigint("test_case_id", { mode: "number" }).notNull(),

    status: text("status").$type<TestResultStatus>().notNull(),
    durationMs: integer("duration_ms"),
    retryCount: smallint("retry_count").notNull().default(0),
    wasFlaky: boolean("was_flaky").notNull().default(false),

    failureType: text("failure_type"),
    failureMessage: text("failure_message"),
    failureSignature: bytea("failure_signature"),
    stackTrace: text("stack_trace"),
    stdout: text("stdout"),
    stderr: text("stderr"),
    message: text("message"),

    tags: jsonb("tags").$type<Tags>().notNull().default({}),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id, table.startedAt] }),
    index("test_results_run_idx").on(table.runId, table.status),
    index("test_results_case_time_idx").on(table.testCaseId, table.startedAt.desc()),
  ],
);

export const attachments = pgTable(
  "attachments",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    testCaseId: bigint("test_case_id", { mode: "number" }).references(() => testCases.id, {
      onDelete: "cascade",
    }),
    testResultId: bigint("test_result_id", { mode: "number" }),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    storageKey: text("storage_key").notNull(),
    contentType: text("content_type"),
    bytes: bigint("bytes", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("attachments_run_idx").on(table.runId)],
);

export const projectDailyStats = pgTable(
  "project_daily_stats",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    branch: text("branch").notNull().default(""),
    runs: integer("runs").notNull().default(0),
    tests: integer("tests").notNull().default(0),
    passed: integer("passed").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    skipped: integer("skipped").notNull().default(0),
    flaky: integer("flaky").notNull().default(0),
    passRate: numeric("pass_rate", { precision: 5, scale: 2 }).notNull().default("0"),
    avgDurationMs: integer("avg_duration_ms"),
    totalDurationMs: bigint("total_duration_ms", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.day, table.branch] })],
);

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    requestHash: bytea("request_hash").notNull(),
    response: jsonb("response").$type<Record<string, unknown>>(),
    statusCode: integer("status_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.orgId, table.key] })],
);

export const schemaMigrations = pgTable("schema_migrations", {
  name: text("name").primaryKey(),
  checksum: text("checksum").notNull(),
  appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
  durationMs: integer("duration_ms"),
});
