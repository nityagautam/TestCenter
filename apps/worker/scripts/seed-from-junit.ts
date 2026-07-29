import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { junitXmlParser } from "@testcenter/parsers";
import type { CanonicalTestResult } from "@testcenter/core";
import {
  addRunTotals,
  createClient,
  finalizeRun,
  maintainPartitions,
  drainDefaultPartition,
  persistResultBatch,
  refreshTestCaseStats,
  rollupProjectDay,
  schema,
} from "@testcenter/db";

/**
 * Seeds a project from real JUnit XML, extrapolated across combinations and over time.
 *
 *   pnpm --filter @testcenter/worker seed-from-junit <dir> [--project=key] [--days=60]
 *                                                    [--runs-per-day=3] [--seed=1] [--replace]
 *
 * Why extrapolate rather than upload the reports as-is: four reports are four runs, and
 * almost nothing this product does is visible in four runs. Flake scores need repetition,
 * failure-mode grouping needs the same test failing differently on different days, trends
 * need a time axis, and the filters need more than one value per dimension. So the reports
 * are treated as a *corpus* — the real suites, scenario names, durations, Hamcrest
 * assertions and Cucumber stack traces — and replayed across clusters, branches,
 * environments and days with plausible dynamics layered on top.
 *
 * What is real: every suite, class, scenario name, duration, failure type, failure message
 * and stack trace originates in the uploaded reports. Nothing is invented prose.
 *
 * What is synthesised: which tests fail on which day, retry flakiness, regressions and
 * their fixes, timeouts, the occasional skipped feature or failed import, and the CI
 * metadata (branch, cluster, PR, shard) that the reports do not carry.
 *
 * Deterministic: the same directory and `--seed` produce the same history, so a UI change
 * can be compared against a fixed dataset rather than a moving one.
 */

/**
 * The parser needs a project id to fingerprint against, but corpus fingerprints are
 * discarded: `persistResultBatch` recomputes them against the real project on write. A
 * fixed placeholder keeps the read side deterministic and makes it obvious that nothing
 * downstream depends on it.
 */
const CORPUS_PROJECT_ID = "00000000-0000-7000-8000-000000000000";

/** Deterministic PRNG — history that changes on every run is useless for comparing UI. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Removes credentials from captured output.
 *
 * The uploaded reports carry live bearer tokens in `system-out` — the Cucumber steps log
 * `>>>>>> TOKEN::: oa-<40 hex>` on every scenario. Replaying reports verbatim would copy
 * real credentials into every generated row, multiplying one leak into thousands. Scrubbed
 * here on the way in; see the note in the run summary about the source reports themselves.
 */
function scrubSecrets(text: string): string {
  return text
    .replace(/(TOKEN:::\s*)\S+/g, "$1<redacted>")
    .replace(/(Bearer\s+)[\w.-]{16,}/gi, "$1<redacted>")
    .replace(/\b(oa-)[0-9a-f]{32,}\b/g, "$1<redacted>")
    .replace(
      /("(?:authorization|x-api-key|cookie|password|secret)"\s*:\s*")[^"]+/gi,
      "$1<redacted>",
    );
}

interface CorpusTest {
  suite: string;
  classname: string | undefined;
  name: string;
  /** The duration observed in the report; the basis for sampled durations. */
  durationMs: number;
  /** True when this test failed in the source report — it stays a usual suspect. */
  failedInSource: boolean;
  stdout: string | undefined;
  /** Cucumber @tags lifted from the scenario's own output. */
  cucumberTags: string[];
  /** The feature family, used to give a test a failure that belongs to it. */
  family: string;
}

interface FailureMode {
  family: string;
  type: string;
  message: string;
  stackTrace: string;
}

/**
 * Clusters to replay across.
 *
 * The source reports embed the cluster in both the scenario name (`On Cluster
 * "SWADESHUAT"`) and the fixture filenames, so replaying other clusters means rewriting
 * both — which is exactly what a real multi-cluster run of this suite would produce.
 * SWADESHUAT is the one that actually appears in the reports; the rest are stand-ins so
 * the environment and tag filters have more than one value to offer.
 */
const CLUSTERS = [
  { name: "SWADESHUAT", environment: "uat", weight: 5 },
  { name: "SWADESHSTAGE", environment: "staging", weight: 3 },
  { name: "JIOMARTUAT", environment: "uat", weight: 2 },
  { name: "SWADESHPROD", environment: "production", weight: 2 },
] as const;

const BRANCHES = [
  { name: "main", weight: 6, pr: false },
  { name: "release/24.9", weight: 2, pr: false },
  { name: "feature/bulk-upload-retry", weight: 2, pr: true },
  { name: "feature/seo-meta-validation", weight: 1, pr: true },
] as const;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith("--"));
  const opt = (name: string, fallback: string): string =>
    args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;

  if (!dir) {
    console.error(
      "usage: pnpm --filter @testcenter/worker seed-from-junit <dir> [--project=key] " +
        "[--days=60] [--runs-per-day=3] [--seed=1] [--replace]",
    );
    process.exit(1);
  }

  const projectKey = opt("project", "ext_api_test");
  const days = Number(opt("days", "60"));
  const runsPerDay = Number(opt("runs-per-day", "3"));
  const replace = args.includes("--replace");
  const seedValue = Number(opt("seed", "1"));
  const random = mulberry32(seedValue);

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("✗ DATABASE_URL is not set");
    process.exit(1);
  }

  // ── 1. Read the corpus out of the real reports ─────────────────────────────
  const files = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith(".xml")).sort();
  if (files.length === 0) {
    console.error(`✗ no .xml files in ${dir}`);
    process.exit(1);
  }

  const corpus = new Map<string, CorpusTest>();
  const failureModes: FailureMode[] = [];
  let sourceResults = 0;

  for (const file of files) {
    // The parser is a streaming one — results arrive in batches so a 2 MB Surefire report
    // never sits in memory whole. Collected here because building a corpus genuinely does
    // need all of it, and these reports are small enough for that to be honest.
    const collected: CanonicalTestResult[] = [];
    await junitXmlParser.parse(
      createReadStream(path.join(dir, file)),
      { projectId: CORPUS_PROJECT_ID, filename: file },
      async (batch) => {
        collected.push(...batch.results);
      },
    );
    sourceResults += collected.length;

    for (const result of collected) {
      // A scenario name is unique per feature, and the reports overlap — two of them
      // contain the same 14 On-Page SEO scenarios — so dedupe rather than double-count.
      const key = `${result.classname ?? ""}|${result.name}`;
      const family = familyOf(result.classname ?? result.suite ?? "");
      const failed = result.status === "failed" || result.status === "error";

      if (!corpus.has(key)) {
        corpus.set(key, {
          suite: result.suite ?? "unknown",
          classname: result.classname,
          name: result.name,
          durationMs: result.durationMs ?? 1000,
          failedInSource: failed,
          stdout: result.stdout ? scrubSecrets(result.stdout).slice(0, 4000) : undefined,
          cucumberTags: extractCucumberTags(result.stdout ?? ""),
          family,
        });
      }

      if (failed && result.failure) {
        failureModes.push({
          family,
          type: result.failure.type ?? "java.lang.AssertionError",
          message: scrubSecrets(result.failure.message ?? "assertion failed"),
          stackTrace: scrubSecrets(result.failure.stackTrace ?? ""),
        });
      }
    }
    console.log(`  read ${file} — ${collected.length} results`);
  }

  const tests = [...corpus.values()];
  console.log(
    `\n✓ corpus: ${tests.length} distinct tests from ${sourceResults} results in ${files.length} file(s)`,
  );
  console.log(
    `✓ failure modes: ${failureModes.length} real assertions across ${new Set(failureModes.map((m) => m.family)).size} families`,
  );

  // ── 2. Give every test-and-cluster pair a stable character ────────────────
  /*
   * Keyed on (test, cluster), and drawn from a hash of that pair rather than from the
   * sequential stream, so the draw does not depend on iteration order and a test behaves
   * consistently everywhere it runs. That consistency is the whole point: a fail rate or a
   * flake score only means something if the underlying test has a fixed character.
   *
   * The cluster decides *which* tests are broken, not whether a broken test fails on any
   * given night. Scaling a per-run failure probability by environment — the first attempt —
   * turned a consistently-broken test into a coin flip: at 0.4× on production a 97% failure
   * rate became 39%, which is 22 status flips across 41 runs, which is a maximal flake
   * score. 162 of 363 tests scored flaky and the flaky list stopped being distinguishable
   * from the failing list. A broken assertion is broken every time; what varies by cluster
   * is whether that code path is broken there at all.
   */
  interface Character {
    baseFailRate: number;
    flakeRate: number;
    /** Day index from which this test starts failing, if it regresses. */
    regressesOnDay: number | null;
    /** Day index from which a source failure is fixed. */
    fixedOnDay: number | null;
    timeoutProne: boolean;
    /*
     * The way this test breaks, chosen once.
     *
     * Sampling a failure independently per result gave one test twelve distinct failure
     * signatures — and since the On-Page SEO features have no failures in the source
     * reports at all, the sampler fell back to the whole pool and decorated SEO scenarios
     * with Brand-import assertions. Neither is how a broken test behaves: it fails the same
     * way every time until the cause changes. A fixed primary mode, plus an occasional
     * second one, gives the failure-mode grouping something true to group.
     */
    primaryMode: FailureMode;
    secondaryMode: FailureMode | null;
  }

  const characterCache = new Map<string, Character>();
  function characterFor(test: CorpusTest, clusterName: string): Character {
    const key = `${test.classname ?? ""}|${test.name}|${clusterName}`;
    const cached = characterCache.get(key);
    if (cached) return cached;

    const rand = mulberry32(hashString(`${seedValue}|${key}`));
    const flakeRoll = rand();
    // Production runs a subset of the broken paths: a broken import job on UAT is often
    // simply not exercised, or not yet deployed, on production.
    const brokenHere = test.failedInSource && !(clusterName.includes("PROD") && rand() < 0.6);

    const character: Character = {
      baseFailRate: brokenHere
        ? rand() < 0.1
          ? 0.4 + rand() * 0.3 // a minority of real failures genuinely are intermittent
          : 0.96 + rand() * 0.04 // the rest fail every time until fixed
        : rand() * 0.02,
      // A tenth of tests are genuinely flaky — the signal the flake score exists for.
      flakeRate:
        flakeRoll < 0.1 ? 0.12 + rand() * 0.3 : flakeRoll < 0.22 ? 0.02 + rand() * 0.04 : 0,
      regressesOnDay:
        !test.failedInSource && rand() < 0.08 ? Math.floor(days * (0.3 + rand() * 0.5)) : null,
      fixedOnDay: brokenHere && rand() < 0.35 ? Math.floor(days * (0.4 + rand() * 0.45)) : null,
      // The real reports show 600s and 1545s durations where a job never reached a
      // terminal state, so timeouts are part of this suite's nature.
      timeoutProne: test.durationMs > 300_000,
      primaryMode: pickFailureMode(failureModes, test.family, rand),
      // A quarter of failing tests break in two ways over their lifetime — an environment
      // problem on top of an assertion, typically — which is what makes the "distinct
      // failure modes" panel worth having.
      secondaryMode: rand() < 0.25 ? pickFailureMode(failureModes, test.family, rand) : null,
    };
    characterCache.set(key, character);
    return character;
  }

  // ── 3. Write the history ───────────────────────────────────────────────────
  const { sql, db } = createClient({
    databaseUrl,
    maxConnections: 4,
    statementTimeoutMs: 300_000,
    applicationName: "testcenter-seed-junit",
  });

  try {
    const projects = await db
      .select({ id: schema.projects.id, orgId: schema.projects.orgId, name: schema.projects.name })
      .from(schema.projects)
      .where(eq(schema.projects.key, projectKey))
      .limit(1);
    const project = projects[0];
    if (!project) {
      console.error(`✗ no project with key "${projectKey}"`);
      process.exit(1);
    }
    console.log(`\n→ ${project.name} (${projectKey})`);

    await maintainPartitions(sql, { lookaheadMonths: 2, retentionMonths: 24 });

    if (replace) {
      const deleted = await sql<{ n: number }[]>`
        WITH gone AS (DELETE FROM runs WHERE project_id = ${project.id} RETURNING 1)
        SELECT count(*)::int AS n FROM gone
      `;
      /*
       * Deleting runs cascades their results but not the test_cases rows.
       *
       * That is right in production — a test case is the project's identity for a test and
       * outlives any single run, so deleting one run must not forget that the test exists.
       * It is wrong for a replace, which left 65 test cases with no results behind: they
       * still appeared in the Tests list, with a zero fail rate and no history, describing
       * runs that no longer existed. Removing only the now-childless ones keeps the
       * production behaviour intact while making --replace actually replace.
       */
      const orphaned = await sql<{ n: number }[]>`
        WITH gone AS (
          DELETE FROM test_cases tc
          WHERE tc.project_id = ${project.id}
            AND NOT EXISTS (SELECT 1 FROM test_results tr WHERE tr.test_case_id = tc.id)
          RETURNING 1
        )
        SELECT count(*)::int AS n FROM gone
      `;
      console.log(
        `  replaced: removed ${deleted[0]?.n ?? 0} run(s) and ${orphaned[0]?.n ?? 0} orphaned test case(s)`,
      );
    }

    let runsCreated = 0;
    let resultsWritten = 0;
    let failedImports = 0;
    let partialImports = 0;
    const touchedDays = new Set<string>();

    for (let dayOffset = days - 1; dayOffset >= 0; dayOffset -= 1) {
      const dayIndex = days - 1 - dayOffset;
      const dayStart = new Date();
      dayStart.setUTCHours(0, 0, 0, 0);
      dayStart.setUTCDate(dayStart.getUTCDate() - dayOffset);

      // Weekends are quieter, which is what makes a volume chart look like a team's
      // week rather than a sine wave.
      const weekend = dayStart.getUTCDay() === 0 || dayStart.getUTCDay() === 6;
      const runsToday = weekend
        ? random() < 0.5
          ? 1
          : 0
        : Math.max(1, Math.round(runsPerDay * (0.6 + random() * 0.8)));

      for (let runIndex = 0; runIndex < runsToday; runIndex += 1) {
        const cluster = pickWeighted(CLUSTERS, random);
        const branch = pickWeighted(BRANCHES, random);
        const startedAt = new Date(dayStart);
        startedAt.setUTCHours(2 + Math.floor(random() * 18), Math.floor(random() * 60), 0, 0);

        // A failed import: the report never parsed. Rare, but the UI has a state for it
        // and it should not only be reachable from the scenario seeder.
        const importFailed = random() < 0.015;
        // A partial import: parsed, but the document was truncated or dirty.
        const importPartial = !importFailed && random() < 0.04;

        const cucumberTagPool = new Set<string>();
        const results: CanonicalTestResult[] = [];

        // One feature is occasionally unavailable on a cluster, which is how a real
        // suite produces skips rather than failures.
        const skippedFamily =
          random() < 0.12
            ? [...new Set(tests.map((t) => t.family))][
                Math.floor(random() * new Set(tests.map((t) => t.family)).size)
              ]
            : null;

        for (const test of tests) {
          const char = characterFor(test, cluster.name);
          for (const tag of test.cucumberTags) cucumberTagPool.add(tag);

          // Cluster substitution: the name and the fixture filenames both carry it.
          const name = test.name.replaceAll("SWADESHUAT", cluster.name);
          const suite = test.suite;

          if (skippedFamily && test.family === skippedFamily) {
            results.push({
              name,
              status: "skipped",
              suite,
              ...(test.classname ? { classname: test.classname } : {}),
              message: `${test.family} is not deployed on ${cluster.name}`,
            });
            continue;
          }

          /*
           * The rate already accounts for the cluster, so only time changes it here. A
           * regression is a step change to consistently failing, and a fix is a step change
           * back — both are what a history view should be able to show, and neither is a
           * per-run probability tweak.
           */
          let failRate = char.baseFailRate;
          if (char.regressesOnDay !== null && dayIndex >= char.regressesOnDay) failRate = 0.97;
          if (char.fixedOnDay !== null && dayIndex >= char.fixedOnDay) failRate = 0.01;

          const failing = random() < failRate;
          const flaked = !failing && char.flakeRate > 0 && random() < char.flakeRate;
          const timedOut = failing && char.timeoutProne && random() < 0.6;

          // Durations track the source value with jitter; a timeout is the long tail the
          // real reports show when a job never reaches a terminal state.
          const durationMs = timedOut
            ? Math.round(600_000 + random() * 950_000)
            : Math.max(1, Math.round(test.durationMs * (0.75 + random() * 0.6)));

          const result: CanonicalTestResult = {
            name,
            status: failing ? "failed" : "passed",
            suite,
            durationMs,
            ...(test.classname ? { classname: test.classname } : {}),
            // Parameters the scenario name already encodes, made queryable.
            parameters: {
              cluster: cluster.name,
              ...(extractCaseNo(test.name) ? { case: extractCaseNo(test.name) as string } : {}),
            },
          };

          if (failing) {
            // The secondary mode, when the test has one, appears in a minority of runs.
            const mode =
              char.secondaryMode && random() < 0.3 ? char.secondaryMode : char.primaryMode;
            result.failure = {
              type: mode.type,
              message: mode.message.replaceAll("SWADESHUAT", cluster.name),
              stackTrace: mode.stackTrace,
            };
          }

          if (flaked) {
            // Failed then passed inside the run: the highest-confidence flake signal. The
            // transient failure is the test's own mode, not a fresh random one.
            const mode = char.primaryMode;
            result.retries = [
              { attempt: 1, status: "failed", failure: { type: mode.type, message: mode.message } },
              { attempt: 2, status: "passed" },
            ];
          }

          // Captured output only on a sample: every row carrying 4 KB of Cucumber step
          // logs would be most of the database and none of the value.
          if (test.stdout && (failing || random() < 0.05)) {
            result.stdout = test.stdout.replaceAll("SWADESHUAT", cluster.name);
          }

          results.push(result);
        }

        const tags: Record<string, string> = {
          cluster: cluster.name,
          env: cluster.environment,
          suite: branch.pr ? "pr" : "regression",
          ...(cucumberTagPool.size > 0
            ? { feature: [...cucumberTagPool].sort()[0]?.replace(/^@/, "") ?? "jcp" }
            : {}),
        };

        const inserted = await db
          .insert(schema.runs)
          .values({
            orgId: project.orgId,
            projectId: project.id,
            name: `${branch.pr ? "PR" : "Nightly"} · ${cluster.name} · ${startedAt.toISOString().slice(0, 10)}`,
            framework: "cucumber-jvm",
            status: importFailed ? "failed" : "parsing",
            startedAt,
            branch: branch.name,
            environment: cluster.environment,
            commitSha: hexSha(random),
            ...(branch.pr ? { prNumber: 4700 + Math.floor(random() * 400) } : {}),
            ciProvider: "github",
            ciBuildId: String(88000 + runsCreated),
            ciJobUrl: `https://github.example.com/jcp/rattle-terminator/actions/runs/${88000 + runsCreated}`,
            attempt: random() < 0.05 ? 2 : 1,
            tags,
            createdByUserId: null,
          })
          .returning({ id: schema.runs.id });
        const runId = inserted[0]?.id as string;
        runsCreated += 1;

        if (importFailed) {
          failedImports += 1;
          await finalizeRun(sql, {
            runId,
            status: "failed",
            framework: "cucumber-jvm",
            durationMs: 0,
            finishedAt: startedAt,
            warnings: [
              {
                code: "xml_malformed",
                message:
                  "malformed JUnit XML: unclosed tag: testsuite — the Surefire report was " +
                  "truncated, usually because the JVM was killed mid-run",
              },
            ],
          });
          continue;
        }

        // Chunked exactly as a real ingest would batch it.
        let testDurationMs = 0;
        const BATCH = 500;
        for (let offset = 0; offset < results.length; offset += BATCH) {
          const outcome = await persistResultBatch(sql, {
            orgId: project.orgId,
            projectId: project.id,
            runId,
            results: results.slice(offset, offset + BATCH),
            runStartedAt: startedAt,
          });
          await addRunTotals(sql, runId, outcome.totals);
          testDurationMs += outcome.totals.durationMs;
          resultsWritten += outcome.written;
        }

        if (importPartial) partialImports += 1;
        await finalizeRun(sql, {
          runId,
          status: importPartial ? "partial" : "complete",
          framework: "cucumber-jvm",
          durationMs: testDurationMs + 4_000,
          finishedAt: new Date(startedAt.getTime() + testDurationMs + 4_000),
          warnings: importPartial
            ? [
                {
                  code: "illegal_xml_chars",
                  message:
                    "removed 1,284 character(s) that are illegal in XML 1.0 — ANSI colour " +
                    "codes captured in Cucumber step output",
                },
              ]
            : [],
        });

        await rollupProjectDay(sql, {
          orgId: project.orgId,
          projectId: project.id,
          day: startedAt,
          branch: branch.name,
        });
        touchedDays.add(startedAt.toISOString().slice(0, 10));

        if (runsCreated % 25 === 0) {
          console.log(`  ${runsCreated} runs, ${resultsWritten.toLocaleString()} results…`);
        }
      }
    }

    // Rollups from every run that has results, so no test is left with zero history.
    console.log(`\n→ refreshing per-test rollups`);
    const withResults = await sql<{ id: string }[]>`
      SELECT id FROM runs WHERE project_id = ${project.id} AND total > 0 ORDER BY started_at
    `;
    for (const run of withResults) {
      await refreshTestCaseStats(sql, { projectId: project.id, runId: run.id, windowDays: 90 });
    }

    const moved = await drainDefaultPartition(sql);
    if (moved > 0) console.log(`✓ relocated ${moved} backdated row(s) into monthly partitions`);

    console.log(
      `\n✓ ${runsCreated} runs · ${resultsWritten.toLocaleString()} results · ` +
        `${touchedDays.size} active days · ${failedImports} failed import(s) · ${partialImports} partial`,
    );

    const shape = await sql<{ label: string; value: string }[]>`
      SELECT 'test cases'      AS label, count(*)::text AS value FROM test_cases WHERE project_id = ${project.id}
      UNION ALL SELECT 'flaky >= 20',    count(*)::text FROM test_cases WHERE project_id = ${project.id} AND flake_score >= 20
      UNION ALL SELECT 'failing now',    count(*)::text FROM test_cases WHERE project_id = ${project.id} AND fail_rate_30d > 0
      UNION ALL SELECT 'distinct sigs',  count(DISTINCT failure_signature)::text FROM test_results WHERE project_id = ${project.id} AND failure_signature IS NOT NULL
      UNION ALL SELECT 'clusters',       count(DISTINCT tags->>'cluster')::text FROM runs WHERE project_id = ${project.id}
      UNION ALL SELECT 'branches',       count(DISTINCT branch)::text FROM runs WHERE project_id = ${project.id}
      UNION ALL SELECT 'leaked tokens',  count(*)::text FROM test_results WHERE project_id = ${project.id} AND stdout LIKE '%TOKEN:::%' AND stdout NOT LIKE '%<redacted>%'
    `;
    console.log("");
    for (const row of shape) console.log(`  ${row.label.padEnd(15)} ${row.value}`);
  } finally {
    await sql.end({ timeout: 10 });
  }
}

/** FNV-1a. Seeds a per-pair PRNG so a draw does not depend on iteration order. */
function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** `JCP Bulk Upload Ext feature for Bulk Brand` → `Bulk Brand`; the failure family. */
function familyOf(classname: string): string {
  const match = /for\s+(.+?)(?:\s+#\d+)?$/.exec(classname);
  if (match?.[1]) return match[1].trim();
  return classname.replace(/\s+#\d+$/, "").trim() || "unknown";
}

/** Cucumber writes its scenario tags into system-out; they make good run tags. */
function extractCucumberTags(stdout: string): string[] {
  const firstLine = stdout.split("\n").find((line) => line.trim().startsWith("@"));
  if (!firstLine) return [];
  return firstLine
    .trim()
    .split(/\s+/)
    .filter((token) => token.startsWith("@"));
}

/** `…, case no "4"` → `4`. Already in the name; lifted so it can be filtered on. */
function extractCaseNo(name: string): string | null {
  return /case no "([^"]+)"/.exec(name)?.[1] ?? null;
}

/**
 * Picks a failure that belongs to the test's own feature where one exists.
 *
 * A Brand scenario failing with a Brand assertion is the difference between data that
 * exercises failure-mode grouping and data that just looks random.
 */
function pickFailureMode(modes: FailureMode[], family: string, random: () => number): FailureMode {
  const own = modes.filter((mode) => mode.family === family);
  const pool = own.length > 0 ? own : modes;
  return pool[Math.floor(random() * pool.length)] as FailureMode;
}

function pickWeighted<T extends { weight: number }>(items: readonly T[], random: () => number): T {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let roll = random() * total;
  for (const item of items) {
    roll -= item.weight;
    if (roll <= 0) return item;
  }
  return items[items.length - 1] as T;
}

function hexSha(random: () => number): string {
  let out = "";
  while (out.length < 40) out += Math.floor(random() * 16).toString(16);
  return out.slice(0, 40);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
