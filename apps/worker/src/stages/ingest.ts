import { eq } from "drizzle-orm";
import type { Env, IngestJobPayload, IngestStage, Job, Logger } from "@testcenter/core";
import { INGEST_STAGES } from "@testcenter/core";
import { schema, type Database, type Sql } from "@testcenter/db";

/**
 * Ingest pipeline driver.
 *
 * The stage sequence, per-stage timing, and the failure/dead-letter bookkeeping
 * are all real in Phase 0 — only the stages themselves are unimplemented, because
 * parsers are Phase 1. Building the harness first means Phase 1 adds a parser to a
 * registry rather than inventing the surrounding machinery under time pressure,
 * and it makes ingest observability available from the first real upload.
 *
 * Every stage is idempotent so that at-least-once delivery is safe: CI retries
 * uploads, and a replayed job must converge on the same result rather than
 * duplicating one.
 */
export interface IngestContext {
  db: Database;
  sql: Sql;
  env: Env;
  job: Job<IngestJobPayload>;
  logger: Logger;
}

export class StageNotImplementedError extends Error {
  constructor(stage: IngestStage, phase: string) {
    super(`ingest stage "${stage}" is not implemented yet (${phase})`);
    this.name = "StageNotImplementedError";
  }
}

type StageHandler = (context: IngestContext) => Promise<void>;

/**
 * Stage registry. Phase 1 replaces `detect`/`parse`/`normalize`/`persist` with
 * real implementations; the driver below does not change.
 */
const STAGE_HANDLERS: Partial<Record<IngestStage, StageHandler>> = {
  // detect:    format sniffing over the first bytes of the artifact — Phase 1
  // parse:     streaming parser dispatch — Phase 1
  // normalize: fingerprint, failure signature, retry collapsing — Phase 1
  // persist:   bulk insert into partitioned test_results — Phase 1
  // merge:     sharded-run merging — Phase 2
  // rollup:    run counters and project_daily_stats — Phase 1
  // analyze:   clustering, flake scoring, quality gates — Phase 3
  // notify:    Slack/Teams/webhook/PR comment — Phase 4
};

const STAGE_PHASES: Record<IngestStage, string> = {
  detect: "Phase 1",
  parse: "Phase 1",
  normalize: "Phase 1",
  persist: "Phase 1",
  merge: "Phase 2",
  rollup: "Phase 1",
  analyze: "Phase 3",
  notify: "Phase 4",
};

/** After this many attempts a job is dead-lettered for manual inspection. */
const MAX_ATTEMPTS = 3;

export async function handleIngest(context: IngestContext): Promise<void> {
  const { db, job, logger } = context;
  const timings: Record<string, number> = {};

  const jobRow = await claimIngestJob(context);
  if (!jobRow) {
    // The artifact was deleted (project removal, retention) between enqueue and
    // pickup. Dropping the job is correct; retrying would never succeed.
    logger.warn("no ingest_jobs row for artifact — dropping job");
    return;
  }

  try {
    for (const stage of INGEST_STAGES) {
      const handler = STAGE_HANDLERS[stage];
      if (!handler) throw new StageNotImplementedError(stage, STAGE_PHASES[stage]);

      const startedAt = Date.now();
      await db
        .update(schema.ingestJobs)
        .set({ stage, state: "running" })
        .where(eq(schema.ingestJobs.id, jobRow.id));

      await handler(context);

      timings[stage] = Date.now() - startedAt;
      // Progress feeds the live parse indicator the upload UI shows in Phase 1.
      await job.updateProgress({
        stage,
        completed: INGEST_STAGES.indexOf(stage) + 1,
        total: INGEST_STAGES.length,
      });
    }

    await db
      .update(schema.ingestJobs)
      .set({ state: "succeeded", timings, finishedAt: new Date() })
      .where(eq(schema.ingestJobs.id, jobRow.id));
    logger.info({ timings }, "ingest complete");
  } catch (error) {
    const isTerminal = error instanceof StageNotImplementedError;
    const attemptsExhausted = job.attemptsMade + 1 >= MAX_ATTEMPTS;

    await db
      .update(schema.ingestJobs)
      .set({
        // Dead means "stop retrying, a human should look": either the work can
        // never succeed, or we have exhausted attempts. Both surface in the
        // dead-letter view rather than disappearing into queue logs.
        state: isTerminal || attemptsExhausted ? "dead" : "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? (error.stack ?? null) : null,
        timings,
        finishedAt: new Date(),
      })
      .where(eq(schema.ingestJobs.id, jobRow.id));

    logger.error({ err: error, timings, terminal: isTerminal }, "ingest failed");
    // Terminal failures must not be retried by the queue.
    if (!isTerminal) throw error;
  }
}

/**
 * Records the attempt against the existing ingest_jobs row, creating one if the
 * enqueue path did not. Written as an upsert-shaped read so a replayed job updates
 * the same row instead of accumulating duplicates.
 */
async function claimIngestJob(
  context: IngestContext,
): Promise<{ id: string; attempts: number } | null> {
  const { db, job } = context;
  const { artifactId, runId, projectId, orgId } = job.payload;

  const existing = await db
    .select({ id: schema.ingestJobs.id, attempts: schema.ingestJobs.attempts })
    .from(schema.ingestJobs)
    .where(eq(schema.ingestJobs.artifactId, artifactId))
    .limit(1);

  if (existing[0]) {
    const attempts = existing[0].attempts + 1;
    await db
      .update(schema.ingestJobs)
      .set({ attempts, state: "running", startedAt: new Date(), errorMessage: null })
      .where(eq(schema.ingestJobs.id, existing[0].id));
    return { id: existing[0].id, attempts };
  }

  const artifact = await db
    .select({ id: schema.artifacts.id })
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, artifactId))
    .limit(1);
  if (!artifact[0]) return null;

  const inserted = await db
    .insert(schema.ingestJobs)
    .values({
      orgId,
      projectId,
      artifactId,
      runId,
      state: "running",
      attempts: 1,
      startedAt: new Date(),
    })
    .returning({ id: schema.ingestJobs.id });

  const row = inserted[0];
  return row ? { id: row.id, attempts: 1 } : null;
}
