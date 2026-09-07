import { z } from "zod";
import { outputLimitsSchema } from "./limits.js";

/**
 * Config is validated once at startup and fails loudly.
 *
 * A misconfigured blob store or database URL that only surfaces during the first
 * 300 MB upload is a much worse failure than refusing to boot.
 */
const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((value) =>
    typeof value === "boolean" ? value : ["1", "true", "yes", "on"].includes(value.toLowerCase()),
  );

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  TESTCENTER_RETENTION_MONTHS: z.coerce.number().int().min(1).max(120).default(12),
  TESTCENTER_PARTITION_LOOKAHEAD: z.coerce.number().int().min(1).max(12).default(2),

  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),

  BLOB_DRIVER: z.enum(["fs", "s3"]).default("fs"),
  BLOB_BUCKET: z.string().min(1).default("testcenter-artifacts"),
  BLOB_LOCAL_DIR: z.string().min(1).default(".data/blobs"),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default("us-east-1"),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: booleanish.default(true),

  MAX_ARTIFACT_BYTES: z.coerce.number().int().positive().default(524_288_000),
  MAX_RUN_BYTES: z.coerce.number().int().positive().default(5_368_709_120),
  /**
   * Ceiling for the *single-shot* ingest endpoint, which is far lower than the others and has
   * to be.
   *
   * `/api/v1/runs` hands out a presigned URL and the bytes go client → object storage without
   * touching this process, so `MAX_ARTIFACT_BYTES` can be half a gigabyte. `/api/v1/ingest`
   * buffers the upload in the web process to keep the one-command curl recipe working, so this
   * limit is a memory budget, not a policy preference. Measured: a 191 MB upload took the
   * server from 187 MB to 1.34 GB of RSS — roughly 7×, because the body is materialised
   * several times over (stream → buffer → FormData part → Buffer copy).
   *
   * Raise it if your reports are genuinely larger and the container has the headroom for
   * `concurrent uploads × limit × ~7`. Past that, the presigned path is the answer rather than
   * a bigger number here.
   *
   * At the 100 MiB default that budget is roughly 700 MB of peak RSS for a single in-flight
   * upload, so a container under about 2 GB should either lower this or expect the second
   * concurrent large upload to be the one that OOMs it.
   */
  MAX_SINGLE_SHOT_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(100 * 1024 * 1024),

  // Spread rather than restated, so a service validates the same limits at boot that the
  // parser reads at runtime. Two copies of these bounds would drift the first time one moved.
  ...outputLimitsSchema.shape,

  OTEL_SERVICE_NAME: z.string().default("test-center"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  /*
   * A single-shot limit above the per-artifact limit is unreachable configuration: the upload
   * would clear this gate and then be rejected by `MAX_ARTIFACT_BYTES` on the way to storage,
   * which reads as the setting having been ignored. Caught at boot, where it is a typo, rather
   * than in CI, where it is a mystery.
   */
  if (parsed.data.MAX_SINGLE_SHOT_BYTES > parsed.data.MAX_ARTIFACT_BYTES) {
    throw new Error(
      `MAX_SINGLE_SHOT_BYTES (${parsed.data.MAX_SINGLE_SHOT_BYTES}) cannot exceed ` +
        `MAX_ARTIFACT_BYTES (${parsed.data.MAX_ARTIFACT_BYTES}) — an upload that passed the ` +
        `first limit would be rejected by the second`,
    );
  }

  // Fail at boot rather than at first upload.
  if (parsed.data.BLOB_DRIVER === "s3") {
    const missing = (
      ["S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const satisfies readonly (keyof Env)[]
    ).filter((key) => !parsed.data[key]);
    if (missing.length > 0) {
      throw new Error(`BLOB_DRIVER=s3 requires: ${missing.join(", ")}`);
    }
  }
  cached = parsed.data;
  return cached;
}

/** Test-only: clears the memoized config between cases. */
export function resetEnvCache(): void {
  cached = null;
}
