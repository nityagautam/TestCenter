import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { computeFingerprint } from "@testcenter/core";
import { createClient, type Database, type Sql } from "./client.js";
import { drainDefaultPartition, listPartitions, maintainPartitions } from "./partitions.js";
import { persistResultBatch } from "./ingest.js";
import { bootstrap, generateApiToken, hashApiToken, resolveApiToken } from "./bootstrap.js";
import * as schema from "./schema.js";

/**
 * Integration tests against a real Postgres.
 *
 * These exist because the schema deliberately uses features an ORM cannot express
 * — range partitioning, partial and expression indexes, a generated tsvector
 * column, a plpgsql uuidv7 shim — so the only trustworthy check is applying the
 * migration and interrogating the result. They also guard the two decisions from
 * docs/test-center-plan.md §1b that are cheap now and expensive later:
 * org_id everywhere, and monthly partitioning for retention.
 *
 * Skipped when DATABASE_URL is unset so `pnpm test` still works offline.
 */
const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

/**
 * Letters only, deliberately.
 *
 * `Date.now()` and UUIDs cannot be used to make a test name unique here: the
 * fingerprint normalizer scrubs long digit runs and UUIDs precisely so that a test
 * whose name embeds generated data keeps one identity across runs. A digit-based
 * suffix would collapse to the same fingerprint on every run and collide.
 */
function uniqueName(prefix: string): string {
  const letters = Array.from(
    { length: 10 },
    () => "abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 26)],
  ).join("");
  return `${prefix} ${letters}`;
}

/** Every table holding tenant data must carry org_id. */
const TENANT_SCOPED_TABLES = [
  "teams",
  "memberships",
  "projects",
  "api_tokens",
  "runs",
  "artifacts",
  "ingest_jobs",
  "test_cases",
  "test_results",
  "attachments",
  "project_daily_stats",
  "idempotency_keys",
] as const;

/*
 * Each suite bootstraps into its own throwaway organisation and drops it at the end.
 *
 * They used to share the default org, which had two costs. The tests were coupled — one
 * suite's leftovers were visible to the other's queries — and, because bootstrap is
 * idempotent by slug, running them against a development database silently recreated
 * that organisation and its project. An org deliberately deleted would quietly reappear
 * the next time anyone ran the suite. Deleting the org here cascades through every
 * tenant-scoped table, which is the guarantee the org_id column exists to provide.
 */
const testOrgSlug = `test-schema-${Math.random().toString(36).slice(2, 10)}`;

describeIfDb("schema", () => {
  let sql: Sql;
  let db: Database;
  let orgId: string;
  let projectId: string;

  beforeAll(async () => {
    const client = createClient({ databaseUrl: databaseUrl as string, maxConnections: 3 });
    sql = client.sql;
    db = client.db;
    const boot = await bootstrap(db, {
      orgSlug: testOrgSlug,
      orgName: "Schema Test Org",
      projectKey: "schema-test",
      projectName: "Schema Test",
    });
    orgId = boot.orgId;
    projectId = boot.projectId;
  });

  afterAll(async () => {
    if (!sql) return;
    await db.delete(schema.organizations).where(eq(schema.organizations.slug, testOrgSlug));
    await sql.end({ timeout: 5 });
  });

  it("applied the migration and recorded a checksum", async () => {
    const rows = await sql<{ name: string; checksum: string }[]>`
      SELECT name, checksum FROM schema_migrations ORDER BY name
    `;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.name).toBe("0001_init.sql");
    expect(rows[0]?.checksum).toHaveLength(64);
  });

  it("carries org_id on every tenant-scoped table", async () => {
    // The single cheap thing that keeps multi-tenancy a config flip rather than a
    // retrofit. A new table missing org_id fails here instead of in a year.
    const rows = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'org_id'
    `;
    const withOrgId = new Set(rows.map((row) => row.table_name));
    const missing = TENANT_SCOPED_TABLES.filter((table) => !withOrgId.has(table));
    expect(missing).toEqual([]);
  });

  it("generates version-7 UUIDs whose timestamp prefix advances", async () => {
    const first = (await sql<{ id: string }[]>`SELECT uuidv7() AS id`)[0]?.id as string;
    // Two ids minted in the same millisecond are ordered only by their random
    // bits, so the ordering claim is about the 48-bit timestamp prefix, not about
    // any two consecutive values.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = (await sql<{ id: string }[]>`SELECT uuidv7() AS id`)[0]?.id as string;

    // Version nibble is the first character of the third group.
    expect(first.split("-")[2]?.[0]).toBe("7");
    expect(second.split("-")[2]?.[0]).toBe("7");

    const timestampOf = (id: string) => parseInt(id.replace(/-/g, "").slice(0, 12), 16);
    expect(timestampOf(second)).toBeGreaterThan(timestampOf(first));
    // Prefix really is a millisecond epoch, not random bytes.
    expect(Math.abs(timestampOf(first) - Date.now())).toBeLessThan(60_000);
  });

  describe("partitioning", () => {
    it("partitions test_results by range on started_at", async () => {
      // partattrs is an int2vector, which is zero-indexed unlike normal arrays.
      const rows = await sql<{ partstrat: string; attname: string }[]>`
        SELECT p.partstrat, a.attname
        FROM pg_partitioned_table p
        JOIN pg_class c ON c.oid = p.partrelid
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = p.partattrs[0]
        WHERE c.relname = 'test_results'
      `;
      expect(rows[0]?.partstrat).toBe("r");
      expect(rows[0]?.attname).toBe("started_at");
    });

    it("provisioned the current month plus lookahead", async () => {
      const monthly = (await listPartitions(sql)).filter((name) => /_\d{4}_\d{2}$/.test(name));
      const now = new Date();
      const current = `test_results_${now.getUTCFullYear()}_${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
      expect(monthly).toContain(current);
      expect(monthly.length).toBeGreaterThanOrEqual(3);
    });

    it("keeps a DEFAULT partition so an out-of-range insert never fails ingest", async () => {
      const rows = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM pg_class WHERE relname = 'test_results_default'
      `;
      expect(Number(rows[0]?.count)).toBe(1);
    });

    it("is idempotent — re-running maintenance changes nothing", async () => {
      // Scheduled maintenance runs repeatedly; if it churned partitions it would
      // be dropping and recreating live data ranges.
      const second = await maintainPartitions(sql, { lookaheadMonths: 2, retentionMonths: 12 });
      expect(second.created).toEqual([]);
      expect(second.dropped).toEqual([]);
    });

    it("relocates backdated rows out of the DEFAULT partition", async () => {
      // Backdated results are normal: a re-upload of an old CI run, a backfill, or
      // a seed spanning months. They land in DEFAULT because only the current month
      // plus lookahead are provisioned.
      //
      // Draining them is order-sensitive in a way that is easy to get backwards:
      // attaching a partition makes Postgres verify DEFAULT holds no rows in the new
      // range, so creating the partition first fails exactly when there is work to
      // do. The rows must leave DEFAULT first, inside a transaction so a failure
      // cannot lose them.
      const backdated = new Date(Date.UTC(2020, 4, 15));
      const caseName = uniqueName("backdated");
      const fingerprint = computeFingerprint({ projectId, name: caseName });
      const testCase = await db
        .insert(schema.testCases)
        .values({ orgId, projectId, fingerprint: fingerprint.digest, name: caseName })
        .returning({ id: schema.testCases.id });
      const testCaseId = testCase[0]?.id as number;

      const run = await db
        .insert(schema.runs)
        .values({ orgId, projectId, framework: "junit", status: "complete", startedAt: backdated })
        .returning({ id: schema.runs.id });
      const runId = run[0]?.id as string;

      await db.insert(schema.testResults).values({
        orgId,
        projectId,
        runId,
        testCaseId,
        status: "passed",
        startedAt: backdated,
      });

      const landed = await sql<{ partition: string }[]>`
        SELECT tableoid::regclass::text AS partition FROM test_results WHERE run_id = ${runId}
      `;
      expect(landed[0]?.partition).toBe("test_results_default");

      const moved = await drainDefaultPartition(sql);
      expect(moved).toBeGreaterThanOrEqual(1);

      const relocated = await sql<{ partition: string }[]>`
        SELECT tableoid::regclass::text AS partition FROM test_results WHERE run_id = ${runId}
      `;
      expect(relocated[0]?.partition).toBe("test_results_2020_05");

      await db.delete(schema.runs).where(eq(schema.runs.id, runId));
      await db.delete(schema.testCases).where(eq(schema.testCases.id, testCaseId));
      await sql.unsafe("DROP TABLE IF EXISTS test_results_2020_05");
    });

    it("routes an inserted result into the partition for its month", async () => {
      const caseName = uniqueName("routes to partition");
      const fingerprint = computeFingerprint({
        projectId,
        suite: "tests/checkout/payment.spec.ts",
        name: caseName,
      });
      const testCase = await db
        .insert(schema.testCases)
        .values({
          orgId,
          projectId,
          fingerprint: fingerprint.digest,
          suite: "tests/checkout/payment.spec.ts",
          name: caseName,
        })
        .returning({ id: schema.testCases.id });
      const testCaseId = testCase[0]?.id as number;

      const run = await db
        .insert(schema.runs)
        .values({ orgId, projectId, framework: "junit", status: "complete" })
        .returning({ id: schema.runs.id });
      const runId = run[0]?.id as string;

      const startedAt = new Date();
      await db.insert(schema.testResults).values({
        orgId,
        projectId,
        runId,
        testCaseId,
        status: "failed",
        durationMs: 1200,
        failureType: "AssertionError",
        failureMessage: "expected 'Approved' to equal 'Declined'",
        startedAt,
      });

      const expectedPartition = `test_results_${startedAt.getUTCFullYear()}_${String(
        startedAt.getUTCMonth() + 1,
      ).padStart(2, "0")}`;
      const located = await sql<{ partition: string }[]>`
        SELECT tableoid::regclass::text AS partition
        FROM test_results WHERE run_id = ${runId}
      `;
      expect(located[0]?.partition).toBe(expectedPartition);

      // And nothing fell through to DEFAULT.
      const fallback = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM test_results_default WHERE run_id = ${runId}
      `;
      expect(Number(fallback[0]?.count)).toBe(0);

      // Clean up so the suite is re-runnable against the same database.
      await db.delete(schema.runs).where(eq(schema.runs.id, runId));
      await db.delete(schema.testCases).where(eq(schema.testCases.id, testCaseId));
    });
  });

  it("enforces one test_case per fingerprint per project", async () => {
    const name = uniqueName("duplicate guard");
    const fingerprint = computeFingerprint({ projectId, name });
    const values = { orgId, projectId, fingerprint: fingerprint.digest, name };

    const inserted = await db
      .insert(schema.testCases)
      .values(values)
      .returning({ id: schema.testCases.id });
    // A second insert of the same identity must be rejected: this constraint is
    // what makes upsert-on-fingerprint safe during concurrent shard ingest.
    await expect(db.insert(schema.testCases).values(values)).rejects.toThrow();

    await db.delete(schema.testCases).where(eq(schema.testCases.id, inserted[0]?.id as number));
  });

  it("indexes test names for full-text search", async () => {
    const rows = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'test_cases' AND indexname = 'test_cases_search_idx'
    `;
    expect(rows).toHaveLength(1);
  });

  it("rejects invalid tag-like project keys at the database level", async () => {
    await expect(
      db.insert(schema.projects).values({ orgId, key: "Not A Valid Key", name: "bad" }),
    ).rejects.toThrow();
  });

  describe("api tokens", () => {
    it("stores only a hash and resolves a valid token", async () => {
      const token = generateApiToken();
      await db.insert(schema.apiTokens).values({
        orgId,
        projectId,
        name: "ci",
        tokenHash: token.hash,
        tokenPrefix: token.prefix,
        scopes: ["runs:write"],
      });

      const resolved = await resolveApiToken(db, token.plaintext);
      expect(resolved?.orgId).toBe(orgId);
      expect(resolved?.scopes).toContain("runs:write");

      // The plaintext must not be recoverable from the row.
      const stored = await sql<{ token_hash: Buffer }[]>`
        SELECT token_hash FROM api_tokens WHERE token_prefix = ${token.prefix}
      `;
      expect(
        Buffer.from(stored[0]?.token_hash as Buffer).equals(hashApiToken(token.plaintext)),
      ).toBe(true);
    });

    it("refuses a revoked token", async () => {
      const token = generateApiToken();
      await db.insert(schema.apiTokens).values({
        orgId,
        name: "revoked",
        tokenHash: token.hash,
        tokenPrefix: token.prefix,
        scopes: ["runs:write"],
        revokedAt: new Date(),
      });
      expect(await resolveApiToken(db, token.plaintext)).toBeNull();
    });

    it("refuses an expired token", async () => {
      const token = generateApiToken();
      await db.insert(schema.apiTokens).values({
        orgId,
        name: "expired",
        tokenHash: token.hash,
        tokenPrefix: token.prefix,
        scopes: ["runs:write"],
        expiresAt: new Date(Date.now() - 1000),
      });
      expect(await resolveApiToken(db, token.plaintext)).toBeNull();
    });

    it("refuses a token that does not exist", async () => {
      expect(await resolveApiToken(db, "tc_not-a-real-token")).toBeNull();
    });
  });

  it("binds a Date through raw SQL even though drizzle shares the database", async () => {
    // Regression guard. drizzle(sql) mutates the postgres.js instance it is given,
    // installing its own type handling; a side effect is that raw template queries
    // on that same instance can no longer serialize a Date. Because the ingest hot
    // path uses raw SQL for bulk inserts while the rest of the app uses drizzle,
    // sharing one instance silently broke every multi-row write with
    // "Buffer.byteLength received an instance of Date". createClient now gives each
    // its own pool.
    const now = new Date();
    const rows = await sql<{ ts: Date }[]>`SELECT ${now}::timestamptz AS ts`;
    expect(rows[0]?.ts.getTime()).toBe(now.getTime());

    // The multi-row helper is the shape that actually failed.
    const name = uniqueName("date binding");
    const fingerprint = computeFingerprint({ projectId, name });
    const inserted = await sql<{ id: string }[]>`
      INSERT INTO test_cases ${sql(
        [
          {
            org_id: orgId,
            project_id: projectId,
            fingerprint: fingerprint.digest,
            fingerprint_version: 1,
            name,
            first_seen_at: now,
            last_seen_at: now,
            last_status: "passed",
          },
        ],
        "org_id",
        "project_id",
        "fingerprint",
        "fingerprint_version",
        "name",
        "first_seen_at",
        "last_seen_at",
        "last_status",
      )}
      RETURNING id
    `;
    // postgres.js returns int8 as a string rather than narrowing to a JS number.
    const newId = Number(inserted[0]?.id);
    expect(newId).toBeGreaterThan(0);
    await db.delete(schema.testCases).where(eq(schema.testCases.id, newId));
  });

  it("stores jsonb columns as objects, not double-encoded strings", async () => {
    // Regression guard. postgres.js JSON-encodes a value bound to a jsonb column or
    // an explicit ::jsonb cast, so pre-stringifying it stores a JSON *string* scalar.
    // Everything still inserts without error, but `@>` containment never matches and
    // jsonb_array_length() fails with "cannot get array length of a scalar" — so tag
    // filtering silently returns nothing. sql.json() encodes exactly once.
    const run = await db
      .insert(schema.runs)
      .values({ orgId, projectId, framework: "junit", status: "complete" })
      .returning({ id: schema.runs.id });
    const runId = run[0]?.id as string;

    await persistResultBatch(sql, {
      orgId,
      projectId,
      runId,
      runStartedAt: new Date(),
      results: [
        {
          name: uniqueName("jsonb encoding"),
          status: "failed",
          suite: "tests/encoding.spec.ts",
          tags: { severity: "p1", owner: "payments" },
          failure: { type: "AssertionError", message: "boom" },
        },
      ],
    });

    const types = await sql<{ tag_type: string }[]>`
      SELECT jsonb_typeof(tags) AS tag_type FROM test_results WHERE run_id = ${runId}
    `;
    expect(types[0]?.tag_type).toBe("object");

    // The query that actually depends on it: containment must match.
    const matched = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM test_results
      WHERE run_id = ${runId} AND tags @> ${sql.json({ severity: "p1" })}
    `;
    expect(matched[0]?.n).toBe(1);

    const runTypes = await sql<{ warn_type: string; tag_type: string }[]>`
      SELECT jsonb_typeof(warnings) AS warn_type, jsonb_typeof(tags) AS tag_type
      FROM runs WHERE id = ${runId}
    `;
    expect(runTypes[0]?.warn_type).toBe("array");
    expect(runTypes[0]?.tag_type).toBe("object");

    // jsonb_array_length is what the run list calls for the warning badge.
    const lengths = await sql<{ n: number }[]>`
      SELECT jsonb_array_length(warnings) AS n FROM runs WHERE id = ${runId}
    `;
    expect(lengths[0]?.n).toBe(0);

    await db.delete(schema.runs).where(eq(schema.runs.id, runId));
  });

  it("bootstraps idempotently", async () => {
    const again = await bootstrap(db, {
      orgSlug: testOrgSlug,
      orgName: "Schema Test Org",
      projectKey: "schema-test",
      projectName: "Schema Test",
    });
    expect(again.created).toEqual({ org: false, project: false });
    expect(again.projectId).toBe(projectId);
  });
});
