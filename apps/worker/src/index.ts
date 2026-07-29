import { createQueueConsumer, createQueueProducer } from "@testcenter/adapters";
import {
  loadEnv,
  QUEUES,
  childLogger,
  logger,
  type IngestJobPayload,
  type MaintenanceJobPayload,
} from "@testcenter/core";
import { closeClient, getClient } from "@testcenter/db";
import { handleIngest } from "./stages/ingest.js";
import { handleMaintenance } from "./stages/maintenance.js";

/**
 * Ingest worker.
 *
 * A long-running process rather than a serverless function, because the core
 * workload — streaming a report that can be hundreds of megabytes through a SAX
 * parser — is exactly what short-lived invocations handle worst. It is packaged as
 * a container so it runs unchanged on a VM, on Kubernetes, or alongside a managed
 * web tier, keeping the hosting decision open (docs/test-center-plan.md §1b).
 */
const env = loadEnv();
const { sql, db } = getClient({
  databaseUrl: env.DATABASE_URL,
  // Few connections, long-lived work — the opposite profile from the web tier.
  maxConnections: 5,
  statementTimeoutMs: 120_000,
  applicationName: "test-center-worker",
});

const consumer = createQueueConsumer(env);
const producer = createQueueProducer(env);

const MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1000;
let maintenanceTimer: NodeJS.Timeout | undefined;

async function main(): Promise<void> {
  logger.info(
    { blobDriver: env.BLOB_DRIVER, retentionMonths: env.TESTCENTER_RETENTION_MONTHS },
    "worker starting",
  );

  await consumer.consume<IngestJobPayload>(
    QUEUES.ingest,
    async (job) => {
      const log = childLogger({
        jobId: job.id,
        runId: job.payload.runId,
        artifactId: job.payload.artifactId,
        projectId: job.payload.projectId,
        stage: "ingest",
      });
      await handleIngest({ db, sql, env, job, logger: log });
    },
    // Parsing is CPU-bound; running many at once on one process just makes each
    // slower and risks memory pressure on large reports.
    { concurrency: 4 },
  );

  await consumer.consume<MaintenanceJobPayload>(
    QUEUES.maintenance,
    async (job) => {
      const log = childLogger({ jobId: job.id, stage: "maintenance" });
      await handleMaintenance({ sql, env, job, logger: log });
    },
    { concurrency: 1 },
  );

  // Partition provisioning must not depend on someone remembering to run a CLI:
  // a missing partition is silent, and retention quietly stops working.
  await scheduleMaintenance();
  maintenanceTimer = setInterval(() => {
    void scheduleMaintenance();
  }, MAINTENANCE_INTERVAL_MS);

  logger.info({ queues: [QUEUES.ingest, QUEUES.maintenance] }, "worker ready");
}

async function scheduleMaintenance(): Promise<void> {
  try {
    await producer.enqueue<MaintenanceJobPayload>(
      QUEUES.maintenance,
      "partitions",
      { task: "partitions" },
      // Date-stamped id makes this idempotent: several worker replicas booting on
      // the same day enqueue one job between them, not one each.
      { jobId: `partitions-${new Date().toISOString().slice(0, 10)}`, attempts: 3 },
    );
  } catch (error) {
    logger.error({ err: error }, "failed to schedule partition maintenance");
  }
}

/**
 * Graceful shutdown: drain in-flight jobs instead of killing them. A job
 * interrupted midway through persisting results would leave a half-written run,
 * which is worse than a slightly slower deploy.
 */
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "worker shutting down — draining in-flight jobs");

  if (maintenanceTimer) clearInterval(maintenanceTimer);
  const timeout = setTimeout(() => {
    logger.error("drain timed out after 30s — exiting");
    process.exit(1);
  }, 30_000);

  try {
    await consumer.close();
    await producer.close();
    await closeClient();
    clearTimeout(timeout);
    logger.info("worker stopped cleanly");
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, "error during shutdown");
    process.exit(1);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "unhandled rejection");
});

main().catch((error: unknown) => {
  logger.error({ err: error }, "worker failed to start");
  process.exit(1);
});
