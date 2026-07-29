/**
 * Job queue port.
 *
 * Ingest is asynchronous by design: the upload endpoint records metadata and
 * enqueues, so it answers in milliseconds regardless of report size, and the
 * parse happens in a long-running worker where a 300 MB streaming XML parse is
 * safe. Keeping this behind a port means BullMQ/Redis can become SQS or a managed
 * queue when the hosting decision lands, without touching call sites.
 */
export const QUEUES = {
  ingest: "ingest",
  rollup: "rollup",
  analyze: "analyze",
  notify: "notify",
  maintenance: "maintenance",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** Pipeline stages, run in order. Each is idempotent and independently retryable. */
export const INGEST_STAGES = [
  "detect",
  "parse",
  "normalize",
  "persist",
  "merge",
  "rollup",
  "analyze",
  "notify",
] as const;

export type IngestStage = (typeof INGEST_STAGES)[number];

export interface JobOptions {
  /**
   * Stable id for deduplication. CI retries the same upload more than you would
   * expect; at-least-once delivery plus this key is what keeps ingest idempotent.
   */
  jobId?: string;
  delayMs?: number;
  attempts?: number;
  priority?: number;
  backoff?: { type: "exponential" | "fixed"; delayMs: number };
}

export interface Job<TPayload> {
  id: string;
  name: string;
  payload: TPayload;
  attemptsMade: number;
  /** Progress reporting drives the live SSE parse indicator in the UI. */
  updateProgress(progress: number | Record<string, unknown>): Promise<void>;
}

export type JobHandler<TPayload> = (job: Job<TPayload>) => Promise<void>;

export interface QueueProducer {
  readonly driver: string;
  enqueue<TPayload>(
    queue: QueueName,
    name: string,
    payload: TPayload,
    options?: JobOptions,
  ): Promise<{ id: string }>;
  /** Queue depth is a primary SLI: ingest lag is how this system fails first. */
  depth(queue: QueueName): Promise<QueueDepth>;
  close(): Promise<void>;
}

export interface QueueConsumer {
  readonly driver: string;
  consume<TPayload>(
    queue: QueueName,
    handler: JobHandler<TPayload>,
    options?: { concurrency?: number },
  ): Promise<void>;
  /** Must drain in-flight jobs, not kill them — a half-persisted run is worse. */
  close(): Promise<void>;
}

export interface QueueDepth {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
}

/** Payload for the ingest pipeline. One artifact, one job. */
export interface IngestJobPayload {
  artifactId: string;
  runId: string;
  projectId: string;
  orgId: string;
  storageKey: string;
  /** Set when the uploader declared the format; otherwise detection decides. */
  declaredFormat?: string;
}

export interface RollupJobPayload {
  runId: string;
  projectId: string;
  orgId: string;
}

export interface MaintenanceJobPayload {
  task: "partitions" | "retention" | "reparse";
  /** For reparse: which artifacts to re-run through an improved parser. */
  scope?: Record<string, unknown>;
}
