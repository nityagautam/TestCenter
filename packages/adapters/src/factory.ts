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
    root: env.BLOB_LOCAL_DIR,
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
