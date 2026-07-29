import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { BlobStore, Env, QueueConsumer, QueueProducer } from "@testcenter/core";
import { FsBlobStore } from "./blob/fs.js";
import { S3BlobStore } from "./blob/s3.js";
import { BullMqConsumer, BullMqProducer } from "./queue/bullmq.js";

/**
 * Single place where configuration picks an implementation.
 *
 * Every other module receives a BlobStore / QueueProducer and cannot tell which
 * driver it got — that is the whole point of the port boundary, and it is what
 * makes the deferred hosting decision a packaging step rather than a port.
 */
/**
 * Anchors a relative blob directory at the workspace root.
 *
 * The web app and the worker run with different working directories (`apps/web`
 * and the repo root respectively), so a relative `BLOB_LOCAL_DIR` silently resolves
 * to two different folders: the API writes an artifact the worker then cannot find,
 * and ingest fails with ENOENT on a file that was definitely uploaded. Anchoring on
 * a marker file makes the same config mean the same directory in every process.
 */
export function resolveLocalBlobRoot(configured: string, startFrom = process.cwd()): string {
  if (isAbsolute(configured)) return configured;

  let directory = startFrom;
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(directory, "pnpm-workspace.yaml"))) {
      return resolve(directory, configured);
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  // No marker found (a deployed image that ships only one app). cwd is then the
  // only sensible anchor, and it is stable for that process.
  return resolve(startFrom, configured);
}

export interface BlobStoreFactoryOptions {
  /** Base URL of the web app; only the fs driver needs it, to build local URLs. */
  publicBaseUrl?: string;
  /** Signing secret for local presigned URLs; only the fs driver needs it. */
  signingSecret?: string;
}

export function createBlobStore(env: Env, options: BlobStoreFactoryOptions = {}): BlobStore {
  if (env.BLOB_DRIVER === "s3") {
    // loadEnv() already refuses to boot without credentials when driver is s3.
    return new S3BlobStore({
      bucket: env.BLOB_BUCKET,
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT,
      accessKeyId: env.S3_ACCESS_KEY_ID as string,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY as string,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
    });
  }

  const signingSecret = options.signingSecret ?? process.env.AUTH_SECRET;
  if (!signingSecret) {
    throw new Error(
      "BLOB_DRIVER=fs requires AUTH_SECRET (or an explicit signingSecret) to sign local upload URLs",
    );
  }
  return new FsBlobStore({
    root: resolveLocalBlobRoot(env.BLOB_LOCAL_DIR),
    publicBaseUrl: options.publicBaseUrl ?? process.env.AUTH_URL ?? "http://localhost:3000",
    signingSecret,
  });
}

export function createQueueProducer(env: Env): QueueProducer {
  return new BullMqProducer({ redisUrl: env.REDIS_URL });
}

export function createQueueConsumer(env: Env): QueueConsumer {
  return new BullMqConsumer({ redisUrl: env.REDIS_URL });
}
