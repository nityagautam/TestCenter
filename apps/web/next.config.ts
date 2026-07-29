import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // Node-only dependencies used by route handlers and server components. Listing
  // them keeps the bundler from trying to trace/bundle native and driver code.
  serverExternalPackages: [
    "postgres",
    "drizzle-orm",
    "bullmq",
    "ioredis",
    "pino",
    "pino-pretty",
    "@aws-sdk/client-s3",
    "@aws-sdk/s3-request-presigner",
  ],
  experimental: {
    // Report uploads go direct to object storage via presigned URLs, so the API
    // itself only ever handles small JSON. This cap is a guard, not a throughput
    // requirement.
    serverActions: { bodySizeLimit: "2mb" },
  },
};

export default config;
