import type { Env, Job, MaintenanceJobPayload, Logger } from "@testcenter/core";
import { drainDefaultPartition, maintainPartitions, type Sql } from "@testcenter/db";

/**
 * Scheduled maintenance.
 *
 * Partition provisioning and retention are the operational reason test_results is
 * partitioned at all: dropping a month is instant DDL, whereas a DELETE over the
 * same rows would rewrite the table and hold locks while teams are using the
 * product.
 */
export interface MaintenanceContext {
  sql: Sql;
  env: Env;
  job: Job<MaintenanceJobPayload>;
  logger: Logger;
}

export async function handleMaintenance(context: MaintenanceContext): Promise<void> {
  const { sql, env, job, logger } = context;

  switch (job.payload.task) {
    case "partitions": {
      const plan = await maintainPartitions(sql, {
        lookaheadMonths: env.TESTCENTER_PARTITION_LOOKAHEAD,
        retentionMonths: env.TESTCENTER_RETENTION_MONTHS,
      });
      logger.info(
        {
          created: plan.created,
          dropped: plan.dropped,
          defaultPartitionRows: plan.defaultPartitionRows,
        },
        "partition maintenance complete",
      );

      // Rows in DEFAULT mean maintenance was not running: they are invisible to
      // partition pruning and immune to retention drops, so relocate them.
      if (plan.defaultPartitionRows > 0) {
        logger.warn(
          { rows: plan.defaultPartitionRows },
          "rows found in test_results_default — relocating",
        );
        const moved = await drainDefaultPartition(sql);
        logger.info({ moved }, "relocated rows out of DEFAULT partition");
      }
      return;
    }

    case "retention": {
      // Result retention is handled by dropping partitions above. Artifact
      // retention (object storage lifecycle) lands in Phase 5 together with the
      // cold-storage tier; see docs/test-center-plan.md Phase 5.
      logger.info("artifact retention is not implemented yet (Phase 5)");
      return;
    }

    case "reparse": {
      // The re-parse path is what makes stored raw artifacts valuable: when a
      // parser improves we replay history rather than asking teams to re-upload.
      // Implemented in Phase 2 alongside the second parser, when there is
      // actually a version to migrate between.
      logger.info({ scope: job.payload.scope }, "re-parse is not implemented yet (Phase 2)");
      return;
    }

    default: {
      const exhaustive: never = job.payload.task;
      throw new Error(`unknown maintenance task: ${String(exhaustive)}`);
    }
  }
}
