import { eq, sql as drizzleSql } from "drizzle-orm";
import {
  emptyTotals,
  type BlobStore,
  type Env,
  type IngestJobPayload,
  type Job,
  type Logger,
  type RunTotals,
} from "@testcenter/core";
import {
  addRunTotals,
  deleteRunResults,
  finalizeRun,
  persistResultBatch,
  refreshTestCaseStats,
  resetRunTotals,
  rollupProjectDay,
  schema,
  type Database,
  type Sql,
} from "@testcenter/db";
import {
  detectParser,
  findParserById,
  NoParserError,
  ParseError,
  peekHead,
} from "@testcenter/parsers";

/**
 * The ingest pipeline.
 *
 * Sequence: detect → parse (streaming) → persist per batch → rollup → finalize.
 *
 * Two design points do the heavy lifting:
 *
 *   Nothing is buffered. The artifact is read as a stream, the parser emits bounded
 *   batches, and each batch is written and discarded. Peak memory is a function of
 *   batch size, not report size, so a 300 MB XML costs the same as a 300 KB one.
 *
 *   Re-running is safe. A replayed job clears the run's prior results and counters
 *   first, so at-least-once delivery and manual re-parses converge on the same
 *   state instead of double-counting.
 */
export interface IngestContext {
  db: Database;
  sql: Sql;
  env: Env;
  blobStore: BlobStore;
  job: Job<IngestJobPayload>;
  logger: Logger;
}

/** Terminal: retrying cannot help, so the job is dead-lettered immediately. */
export class TerminalIngestError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "TerminalIngestError";
  }
}

const MAX_ATTEMPTS = 3;
const PERSIST_BATCH_SIZE = 500;

export async function handleIngest(context: IngestContext): Promise<void> {
  const { db, sql, job, logger, blobStore } = context;
  const { artifactId, runId, projectId, orgId } = job.payload;
  const timings: Record<string, number> = {};

  const jobRow = await claimIngestJob(context);
  if (!jobRow) {
    // The artifact was removed (project deleted, retention) between enqueue and
    // pickup. Dropping the job is correct — a retry could never succeed.
    logger.warn("no artifact for ingest job — dropping");
    return;
  }

  const artifact = await loadArtifact(db, artifactId);
  if (!artifact) {
    await markJob(
      context,
      jobRow.id,
      "dead",
      timings,
      new TerminalIngestError("artifact row disappeared during ingest", "artifact_missing"),
    );
    return;
  }

  try {
    await db.update(schema.runs).set({ status: "parsing" }).where(eq(schema.runs.id, runId));

    // ── detect ────────────────────────────────────────────────────────────────
    let started = Date.now();
    await setStage(context, jobRow.id, "detect");

    const headStream = await blobStore.getStream(artifact.storageKey);
    const { head } = await peekHead(headStream);
    headStream.destroy();

    const declared = artifact.declaredFormat ? findParserById(artifact.declaredFormat) : undefined;
    const detected = detectParser(head, artifact.filename);
    // A declared format wins: the uploader knows something we cannot sniff. It is
    // still recorded separately from what detection thought, so a wrong declaration
    // is diagnosable later.
    const parser = declared ?? detected?.parser;
    if (!parser) throw new NoParserError(artifact.filename);

    await db
      .update(schema.artifacts)
      .set({
        detectedFormat: detected?.parser.id ?? null,
        detectConfidence: detected ? String(detected.confidence) : null,
        parserVersion: parser.version,
      })
      .where(eq(schema.artifacts.id, artifactId));

    timings.detect = Date.now() - started;
    logger.info(
      { parser: parser.id, confidence: detected?.confidence, declared: artifact.declaredFormat },
      "format detected",
    );

    // ── re-parse safety ───────────────────────────────────────────────────────
    // Clearing prior state before writing is what makes a replay idempotent.
    if (job.attemptsMade > 0 || jobRow.attempts > 1) {
      const removed = await deleteRunResults(sql, runId);
      await resetRunTotals(sql, runId);
      if (removed > 0) logger.warn({ removed }, "cleared results from a previous attempt");
    }

    // ── parse + persist ───────────────────────────────────────────────────────
    started = Date.now();
    await setStage(context, jobRow.id, "parse");

    const run = await loadRun(db, runId);
    if (!run) throw new TerminalIngestError("run disappeared during ingest", "run_missing");
    const runStartedAt = run.startedAt ?? new Date();

    const accumulated: RunTotals = emptyTotals();
    let written = 0;
    let persistMs = 0;

    const stream = await blobStore.getStream(artifact.storageKey);
    const outcome = await parser.parse(
      stream,
      {
        projectId,
        filename: artifact.filename,
        batchSize: PERSIST_BATCH_SIZE,
        onProgress: (progress) => {
          void job.updateProgress({
            stage: "parse",
            bytesRead: progress.bytesRead,
            resultsParsed: progress.resultsParsed,
          });
        },
      },
      async (batch) => {
        const persistStarted = Date.now();
        const result = await persistResultBatch(sql, {
          orgId,
          projectId,
          runId,
          results: batch.results,
          runStartedAt,
        });
        persistMs += Date.now() - persistStarted;
        written += result.written;
        mergeTotals(accumulated, result.totals);
      },
    );

    timings.parse = Date.now() - started - persistMs;
    timings.persist = persistMs;

    // ── rollup ────────────────────────────────────────────────────────────────
    started = Date.now();
    await setStage(context, jobRow.id, "rollup");

    await addRunTotals(sql, runId, accumulated);

    const warnings = [...outcome.warnings];
    // A report that parsed but yielded nothing is reported as partial rather than
    // complete: silently showing an empty green run would be worse than a warning.
    const status = written === 0 ? "partial" : "complete";

    await finalizeRun(sql, {
      runId,
      status,
      durationMs: outcome.run.durationMs,
      framework: outcome.run.framework,
      warnings: warnings.map((warning) => ({ code: warning.code, message: warning.message })),
    });

    await rollupProjectDay(sql, {
      orgId,
      projectId,
      day: runStartedAt,
      branch: run.branch,
    });
    const statsUpdated = await refreshTestCaseStats(sql, { projectId, runId });

    timings.rollup = Date.now() - started;

    await db
      .update(schema.ingestJobs)
      .set({
        stage: "rollup",
        state: "succeeded",
        timings,
        resultsWritten: written,
        finishedAt: new Date(),
        errorMessage: null,
      })
      .where(eq(schema.ingestJobs.id, jobRow.id));

    await job.updateProgress({ stage: "complete", resultsParsed: written });

    logger.info(
      {
        parser: parser.id,
        written,
        statsUpdated,
        warnings: warnings.map((w) => w.code),
        timings,
      },
      "ingest complete",
    );
  } catch (error) {
    await handleFailure(context, jobRow, timings, error);
  }
}

function mergeTotals(target: RunTotals, source: RunTotals): void {
  target.total += source.total;
  target.passed += source.passed;
  target.failed += source.failed;
  target.skipped += source.skipped;
  target.errored += source.errored;
  target.blocked += source.blocked;
  target.flaky += source.flaky;
  target.durationMs += source.durationMs;
}

/**
 * Decides whether a failure is worth retrying.
 *
 * A malformed report will be just as malformed on the third attempt, so retrying it
 * only delays the feedback and burns queue capacity. Infrastructure failures
 * (storage timeout, dropped connection) are exactly what retries are for.
 */
function isTerminal(error: unknown): boolean {
  if (error instanceof TerminalIngestError) return true;
  if (error instanceof NoParserError) return true;
  if (error instanceof ParseError) {
    return ["xml_malformed", "not_junit_xml", "no_parser"].includes(error.code);
  }
  return false;
}

async function handleFailure(
  context: IngestContext,
  jobRow: { id: string; attempts: number },
  timings: Record<string, number>,
  error: unknown,
): Promise<void> {
  const { sql, job, logger } = context;
  const terminal = isTerminal(error);
  const exhausted = job.attemptsMade + 1 >= MAX_ATTEMPTS;
  const dead = terminal || exhausted;

  await markJob(context, jobRow.id, dead ? "dead" : "failed", timings, error);

  if (dead) {
    // The run must not sit in "parsing" forever; a failed run with the reason
    // attached is actionable, a spinner is not.
    await finalizeRun(sql, {
      runId: job.payload.runId,
      status: "failed",
      warnings: [
        {
          code: error instanceof ParseError ? error.code : "ingest_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    });
  }

  logger.error({ err: error, terminal, dead, timings }, "ingest failed");
  if (!dead) throw error;
}

async function setStage(
  context: IngestContext,
  jobId: string,
  stage: "detect" | "parse" | "normalize" | "persist" | "merge" | "rollup" | "analyze" | "notify",
): Promise<void> {
  await context.db
    .update(schema.ingestJobs)
    .set({ stage, state: "running" })
    .where(eq(schema.ingestJobs.id, jobId));
}

async function markJob(
  context: IngestContext,
  jobId: string,
  state: "failed" | "dead",
  timings: Record<string, number>,
  error: unknown,
): Promise<void> {
  await context.db
    .update(schema.ingestJobs)
    .set({
      state,
      errorMessage: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error ? (error.stack ?? null) : null,
      timings,
      finishedAt: new Date(),
    })
    .where(eq(schema.ingestJobs.id, jobId));
}

interface ArtifactRow {
  id: string;
  filename: string;
  storageKey: string;
  declaredFormat: string | null;
}

async function loadArtifact(db: Database, artifactId: string): Promise<ArtifactRow | null> {
  const rows = await db
    .select({
      id: schema.artifacts.id,
      filename: schema.artifacts.filename,
      storageKey: schema.artifacts.storageKey,
      declaredFormat: schema.artifacts.declaredFormat,
    })
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, artifactId))
    .limit(1);
  return rows[0] ?? null;
}

async function loadRun(
  db: Database,
  runId: string,
): Promise<{ startedAt: Date | null; branch: string | null } | null> {
  const rows = await db
    .select({ startedAt: schema.runs.startedAt, branch: schema.runs.branch })
    .from(schema.runs)
    .where(eq(schema.runs.id, runId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Records the attempt against the existing ingest_jobs row, creating one if the
 * enqueue path did not. Shaped as a read-then-upsert so a replayed job updates the
 * same row rather than accumulating duplicates.
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

  const artifactExists = await db
    .select({ id: schema.artifacts.id })
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, artifactId))
    .limit(1);
  if (!artifactExists[0]) return null;

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

/** Re-queues dead-lettered jobs. Backs the DLQ replay control in the admin UI. */
export async function listDeadLetterJobs(
  db: Database,
  input: { projectId?: string; limit?: number },
): Promise<
  { id: string; artifactId: string; runId: string | null; errorMessage: string | null }[]
> {
  const limit = input.limit ?? 50;
  const condition = input.projectId
    ? drizzleSql`${schema.ingestJobs.state} = 'dead' AND ${schema.ingestJobs.projectId} = ${input.projectId}`
    : drizzleSql`${schema.ingestJobs.state} = 'dead'`;

  return db
    .select({
      id: schema.ingestJobs.id,
      artifactId: schema.ingestJobs.artifactId,
      runId: schema.ingestJobs.runId,
      errorMessage: schema.ingestJobs.errorMessage,
    })
    .from(schema.ingestJobs)
    .where(condition)
    .limit(limit);
}

export { ParseError };
