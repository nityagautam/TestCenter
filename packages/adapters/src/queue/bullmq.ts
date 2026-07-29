import { Queue, Worker, type ConnectionOptions, type Job as BullJob } from "bullmq";
import { Redis } from "ioredis";
import type {
  Job,
  JobHandler,
  JobOptions,
  QueueConsumer,
  QueueDepth,
  QueueName,
  QueueProducer,
} from "@testcenter/core";
import { QUEUES } from "@testcenter/core";

/**
 * BullMQ/Redis implementation of the queue ports.
 *
 * Chosen because ingest needs a long-running consumer: a 300 MB streaming XML
 * parse is exactly the workload a short-lived serverless invocation handles worst.
 * Behind the port, so this can become SQS or a managed queue once the hosting
 * decision lands.
 */
export interface BullMqConfig {
  redisUrl: string;
  prefix?: string;
}

/**
 * BullMQ treats a connection it did not create as externally owned and will not
 * disconnect it on close(). Passing an instance in and then only closing the queue
 * leaves the socket open, so a CLI that enqueues one job never exits and the
 * worker's graceful shutdown stalls until its drain timeout fires. Because we
 * create the client here, we are responsible for quitting it — hence the handle is
 * kept rather than discarded.
 */
function createConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, {
    // Required by BullMQ: it must not give up on a blocking command.
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
}

/**
 * quit() waits for pending replies; a hung Redis would otherwise block shutdown
 * forever, so fall back to a hard disconnect.
 */
async function closeConnection(redis: Redis): Promise<void> {
  try {
    await Promise.race([
      redis.quit(),
      new Promise((resolve) => setTimeout(resolve, 5000)).then(() => {
        redis.disconnect();
      }),
    ]);
  } catch {
    redis.disconnect();
  }
}

const DEFAULT_ATTEMPTS = 3;

export class BullMqProducer implements QueueProducer {
  readonly driver = "bullmq";
  private readonly queues = new Map<QueueName, Queue>();
  private readonly redis: Redis;
  private readonly connection: ConnectionOptions;
  private readonly prefix: string;

  constructor(config: BullMqConfig) {
    this.redis = createConnection(config.redisUrl);
    this.connection = this.redis as unknown as ConnectionOptions;
    this.prefix = config.prefix ?? "testcenter";
  }

  private queueFor(name: QueueName): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, { connection: this.connection, prefix: this.prefix });
      this.queues.set(name, queue);
    }
    return queue;
  }

  async enqueue<TPayload>(
    queue: QueueName,
    name: string,
    payload: TPayload,
    options?: JobOptions,
  ): Promise<{ id: string }> {
    const job = await this.queueFor(queue).add(name, payload, {
      // jobId gives us deduplication: CI retries the same upload more often than
      // you would expect, and at-least-once delivery makes replays normal.
      ...(options?.jobId ? { jobId: options.jobId } : {}),
      ...(options?.delayMs ? { delay: options.delayMs } : {}),
      ...(options?.priority ? { priority: options.priority } : {}),
      attempts: options?.attempts ?? DEFAULT_ATTEMPTS,
      backoff: options?.backoff
        ? { type: options.backoff.type, delay: options.backoff.delayMs }
        : { type: "exponential", delay: 2000 },
      // Keep a bounded history: enough to debug, not enough to fill Redis.
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 7 * 24 * 3600, count: 5000 },
    });
    return { id: String(job.id) };
  }

  async depth(queue: QueueName): Promise<QueueDepth> {
    const counts = await this.queueFor(queue).getJobCounts(
      "waiting",
      "active",
      "delayed",
      "failed",
      "completed",
    );
    return {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      failed: counts.failed ?? 0,
      completed: counts.completed ?? 0,
    };
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    this.queues.clear();
    await closeConnection(this.redis);
  }
}

export class BullMqConsumer implements QueueConsumer {
  readonly driver = "bullmq";
  private readonly workers: Worker[] = [];
  private readonly redis: Redis;
  private readonly connection: ConnectionOptions;
  private readonly prefix: string;

  constructor(config: BullMqConfig) {
    this.redis = createConnection(config.redisUrl);
    this.connection = this.redis as unknown as ConnectionOptions;
    this.prefix = config.prefix ?? "testcenter";
  }

  async consume<TPayload>(
    queue: QueueName,
    handler: JobHandler<TPayload>,
    options?: { concurrency?: number },
  ): Promise<void> {
    const worker = new Worker(
      queue,
      async (bullJob: BullJob) => {
        const job: Job<TPayload> = {
          id: String(bullJob.id),
          name: bullJob.name,
          payload: bullJob.data as TPayload,
          attemptsMade: bullJob.attemptsMade,
          updateProgress: (progress) => bullJob.updateProgress(progress),
        };
        await handler(job);
      },
      {
        connection: this.connection,
        prefix: this.prefix,
        // Ingest is CPU-bound during parse; more than a handful of concurrent
        // parses on one worker just makes them all slower.
        concurrency: options?.concurrency ?? 4,
      },
    );
    this.workers.push(worker);
  }

  /**
   * Waits for in-flight jobs rather than killing them: a job interrupted midway
   * through persisting results leaves a half-written run, which is worse than a
   * slightly slower deploy.
   */
  async close(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.close()));
    this.workers.length = 0;
    await closeConnection(this.redis);
  }
}

/** Convenience for health checks: depth across every queue. */
export async function allQueueDepths(
  producer: QueueProducer,
): Promise<Record<QueueName, QueueDepth>> {
  const names = Object.values(QUEUES);
  const entries = await Promise.all(
    names.map(async (name) => [name, await producer.depth(name)] as const),
  );
  return Object.fromEntries(entries) as Record<QueueName, QueueDepth>;
}
