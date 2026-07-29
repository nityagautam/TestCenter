import { z } from "zod";

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
