import { NextResponse } from "next/server";
import { QUEUES } from "@testcenter/core";
import { listPartitions, ping } from "@testcenter/db";
import { getServices } from "@/lib/services";

/**
 * Health endpoint.
 *
 * Reports the things that actually break in this system, in the order they break:
 * ingest lag (queue depth), then the database, then object storage. Partition
 * coverage is included because a missing partition is silent — inserts keep
 * succeeding into the DEFAULT partition while retention quietly stops working.
 *
 * `?deep=1` adds the checks that cost a round trip to object storage; the default
 * response is cheap enough for a load balancer to poll.
 */
export const dynamic = "force-dynamic";

interface Check {
  ok: boolean;
  latencyMs?: number;
  detail?: string;
}

export async function GET(request: Request): Promise<NextResponse> {
  const deep = new URL(request.url).searchParams.get("deep") === "1";
  const checks: Record<string, Check> = {};

  const { sql, queue, blobStore, env } = getServices();

  const database = await ping(sql);
  checks.database = { ok: database.ok, latencyMs: database.latencyMs };

  // Queue depth is the primary SLI: this system fails first as ingest backlog.
  try {
    const startedAt = Date.now();
    const depth = await queue.depth(QUEUES.ingest);
    checks.queue = {
      ok: true,
      latencyMs: Date.now() - startedAt,
      detail: `waiting=${depth.waiting} active=${depth.active} failed=${depth.failed}`,
    };
  } catch (error) {
    checks.queue = { ok: false, detail: errorMessage(error) };
  }

  if (database.ok) {
    try {
      const partitions = await listPartitions(sql);
      const monthly = partitions.filter((name) => /_\d{4}_\d{2}$/.test(name));
      const currentMonth = partitionNameForMonth(new Date());
      const hasCurrent = monthly.includes(currentMonth);
      checks.partitions = {
        ok: hasCurrent,
        detail: hasCurrent
          ? `${monthly.length} monthly partition(s)`
          : `missing partition ${currentMonth} — results are landing in test_results_default`,
      };
    } catch (error) {
      checks.partitions = { ok: false, detail: errorMessage(error) };
    }
  }

  if (deep) {
    try {
      const startedAt = Date.now();
      await blobStore.list("health-probe/", { limit: 1 });
      checks.blobStore = {
        ok: true,
        latencyMs: Date.now() - startedAt,
        detail: `driver=${blobStore.driver}`,
      };
    } catch (error) {
      checks.blobStore = { ok: false, detail: errorMessage(error) };
    }
  }

  const ok = Object.values(checks).every((check) => check.ok);
  return NextResponse.json(
    {
      status: ok ? "ok" : "degraded",
      service: env.OTEL_SERVICE_NAME,
      environment: env.NODE_ENV,
      blobDriver: blobStore.driver,
      checks,
      timestamp: new Date().toISOString(),
    },
    {
      status: ok ? 200 : 503,
      headers: { "cache-control": "no-store" },
    },
  );
}

function partitionNameForMonth(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `test_results_${year}_${month}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
