import "server-only";
import { createBlobStore, createQueueProducer } from "@testcenter/adapters";
import { loadEnv, type BlobStore, type Env, type QueueProducer } from "@testcenter/core";
import { getClient, type Database, type Sql } from "@testcenter/db";

/**
 * Server-side service container.
 *
 * Held in module scope and reused across requests. In development Next.js
 * re-evaluates modules on every hot reload, which without the globalThis cache
 * would leak a Postgres pool and a Redis connection per edit until the machine
 * runs out of file descriptors.
 */
export interface Services {
  env: Env;
  db: Database;
  sql: Sql;
  blobStore: BlobStore;
  queue: QueueProducer;
}

declare global {
  var __testcenterServices: Services | undefined;
}

export function getServices(): Services {
  if (globalThis.__testcenterServices) return globalThis.__testcenterServices;

  const env = loadEnv();
  const { db, sql } = getClient({
    databaseUrl: env.DATABASE_URL,
    // The web tier issues many short queries; the worker gets its own pool.
    maxConnections: 10,
    applicationName: "test-center-web",
  });

  const services: Services = {
    env,
    db,
    sql,
    blobStore: createBlobStore(env, {
      publicBaseUrl: process.env.AUTH_URL ?? "http://localhost:3000",
      signingSecret: process.env.AUTH_SECRET ?? "",
    }),
    queue: createQueueProducer(env),
  };

  globalThis.__testcenterServices = services;
  return services;
}
