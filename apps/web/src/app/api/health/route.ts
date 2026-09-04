import { NextResponse } from "next/server";
import { QUEUES } from "@testcenter/core";
import { listPartitions, ping, resultStorageFootprint } from "@testcenter/db";
import { formatBytes } from "@/lib/format";
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
 *
 * Storage figures ride along under `metrics`, deliberately *outside* `checks`. Nothing in
 * there may influence `status`: a table growing is a capacity signal, not a liveness failure,
 * and letting it return 503 would pull the app out of the load balancer for something that
 * needs a purchase order rather than a restart. Keeping the two apart is what makes it safe to
 * report a number nobody has agreed a threshold for.
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

  /*
   * Catalog-only, so it is cheap enough to run unconditionally rather than behind `?deep=1`.
   * `resultStorageFootprint` reads `pg_class` — O(partitions), a dozen buffers — where the
   * row-scanning version of this metric would read the whole table. Wrapped anyway: a metric
   * that cannot be collected must not take the endpoint down with it.
   */
  let metrics: Record<string, unknown> | undefined;
  if (database.ok) {
    try {
      const footprint = await resultStorageFootprint(sql);
      metrics = {
        /*
         * Advertised so a publisher can pick its upload path *before* transferring anything.
         * Without this the only way to learn the ceiling is to exceed it and read the 413, which
         * means every oversized run pays for a failed request first — and any client that
         * hardcodes the old 32 MiB default is wrong the moment an operator changes it.
         */
        ingest: {
          maxSingleShotBytes: env.MAX_SINGLE_SHOT_BYTES,
          maxSingleShot: formatBytes(env.MAX_SINGLE_SHOT_BYTES),
          maxArtifactBytes: env.MAX_ARTIFACT_BYTES,
          singleShotPath: "/api/v1/ingest",
          presignedPath: "/api/v1/runs",
        },
        results: {
          totalBytes: footprint.totalBytes,
          total: formatBytes(footprint.totalBytes),
          // Split out because the two grow for different reasons: heap tracks how many tests
          // ran, TOAST tracks how much they printed. See resultStorageFootprint.
          capturedOutput: formatBytes(footprint.toastBytes),
          capturedOutputShare: `${Math.round(footprint.toastShare * 100)}%`,
          currentMonth: footprint.currentMonth
            ? {
                partition: footprint.currentMonth.partition,
                total: formatBytes(footprint.currentMonth.totalBytes),
                capturedOutput: formatBytes(footprint.currentMonth.toastBytes),
              }
            : null,
          partitions: footprint.partitions.length,
          retentionMonths: env.TESTCENTER_RETENTION_MONTHS,
          // The knobs that decide the ceiling, echoed so a surprising figure above can be
          // traced to configuration without shelling into the container.
          limits: {
            maxOutputChars: env.MAX_OUTPUT_CHARS,
            outputReadChars: env.OUTPUT_READ_CHARS,
          },
        },
      };
    } catch (error) {
      metrics = { results: { error: errorMessage(error) } };
    }
  }

  if (deep) {
    try {
      const startedAt = Date.now();
      await blobStore.list("health-probe/", { limit: 1 });
      checks.blobStore = {
        ok: true,
        latencyMs: Date.now() - startedAt,
        // The root is included because web and worker must resolve it identically;
        // a divergence shows up here instead of as a mysterious ENOENT at ingest.
        detail:
          `driver=${blobStore.driver}` +
          ("root" in blobStore ? ` root=${String((blobStore as { root: unknown }).root)}` : ""),
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
      ...(metrics ? { metrics } : {}),
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
