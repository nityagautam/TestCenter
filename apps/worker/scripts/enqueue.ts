import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { config as loadDotEnv } from "dotenv";
import { createQueueProducer } from "@testcenter/adapters";
import { loadEnv, QUEUES, type MaintenanceJobPayload } from "@testcenter/core";

/**
 * Smoke-test helper: enqueues a real maintenance job and reports queue depth.
 *
 *   pnpm --filter @testcenter/worker enqueue partitions
 *
 * Used by the Phase 0 verification to prove the producer → Redis → consumer path
 * works end to end, rather than asserting only that the process boots.
 */
function findDotEnv(): void {
  let dir = process.cwd();
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) {
      loadDotEnv({ path: candidate });
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

async function main(): Promise<void> {
  findDotEnv();
  const env = loadEnv();
  const task = (process.argv[2] ?? "partitions") as MaintenanceJobPayload["task"];

  const producer = createQueueProducer(env);
  try {
    const job = await producer.enqueue<MaintenanceJobPayload>(
      QUEUES.maintenance,
      task,
      { task },
      // Unique id so repeated smoke runs are not deduplicated away.
      { jobId: `${task}-manual-${Date.now()}`, attempts: 1 },
    );
    console.log(`✓ enqueued ${task} job ${job.id}`);
    console.log(`  maintenance queue: ${JSON.stringify(await producer.depth(QUEUES.maintenance))}`);
  } finally {
    await producer.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
