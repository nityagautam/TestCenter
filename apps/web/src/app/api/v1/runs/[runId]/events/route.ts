import { and, eq } from "drizzle-orm";
import { schema } from "@testcenter/db";
import { authenticate } from "@/lib/api-auth";
import { getServices } from "@/lib/services";

/**
 * Live run progress over Server-Sent Events.
 *
 * SSE rather than WebSockets: the data only flows one way, it is plain HTTP so it
 * survives proxies and needs no separate server, and it reconnects on its own. A
 * WebSocket would buy bidirectionality we have no use for until collaborative
 * features exist.
 *
 * The stream polls the database rather than subscribing to Redis pub/sub. That is a
 * deliberate simplification for Phase 1: ingest state already lives in Postgres, and
 * polling one indexed row every second for the few seconds a parse takes is cheaper
 * in complexity than keeping a fan-out channel correct across worker restarts. If
 * many concurrent viewers ever make this measurable, the poll body is the only thing
 * that has to change.
 */
export const dynamic = "force-dynamic";

const POLL_INTERVAL_MS = 1000;
/** Parsing is seconds-to-minutes; a stuck stream must not live forever. */
const MAX_STREAM_MS = 10 * 60 * 1000;
const HEARTBEAT_EVERY_MS = 15_000;

interface Snapshot {
  status: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  errored: number;
  flaky: number;
  jobs: { stage: string; state: string; resultsWritten: number; error: string | null }[];
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const principal = await authenticate(request);
  const { runId } = await params;
  const { db } = getServices();

  const encoder = new TextEncoder();
  const startedAt = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let lastSerialized = "";
      let lastHeartbeat = Date.now();

      const send = (event: string, data: unknown): void => {
        if (closed) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      const close = (): void => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed by the client disconnecting; nothing to do.
        }
      };

      // Client navigated away or aborted: stop polling immediately rather than
      // holding a database connection for the full timeout.
      request.signal.addEventListener("abort", close);

      while (!closed) {
        if (Date.now() - startedAt > MAX_STREAM_MS) {
          send("timeout", { runId, reason: "stream exceeded maximum duration" });
          close();
          break;
        }

        let snapshot: Snapshot | null;
        try {
          snapshot = await loadSnapshot(db, principal.orgId, runId);
        } catch (error) {
          send("error", { message: error instanceof Error ? error.message : "query failed" });
          close();
          break;
        }

        if (!snapshot) {
          send("error", { message: "run not found" });
          close();
          break;
        }

        const serialized = JSON.stringify(snapshot);
        if (serialized !== lastSerialized) {
          lastSerialized = serialized;
          lastHeartbeat = Date.now();
          send("progress", { runId, ...snapshot });
        } else if (Date.now() - lastHeartbeat > HEARTBEAT_EVERY_MS) {
          // Comment-only frames keep proxies from closing an idle connection.
          if (!closed) controller.enqueue(encoder.encode(`: keep-alive\n\n`));
          lastHeartbeat = Date.now();
        }

        // Terminal states end the stream so the browser stops listening.
        if (["complete", "partial", "failed"].includes(snapshot.status)) {
          send("done", { runId, status: snapshot.status });
          close();
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Prevents buffering proxies from withholding events until the stream ends.
      "x-accel-buffering": "no",
    },
  });
}

async function loadSnapshot(
  db: ReturnType<typeof getServices>["db"],
  orgId: string,
  runId: string,
): Promise<Snapshot | null> {
  const runs = await db
    .select({
      status: schema.runs.status,
      total: schema.runs.total,
      passed: schema.runs.passed,
      failed: schema.runs.failed,
      skipped: schema.runs.skipped,
      errored: schema.runs.errored,
      flaky: schema.runs.flaky,
    })
    .from(schema.runs)
    .where(and(eq(schema.runs.id, runId), eq(schema.runs.orgId, orgId)))
    .limit(1);

  const run = runs[0];
  if (!run) return null;

  const jobs = await db
    .select({
      stage: schema.ingestJobs.stage,
      state: schema.ingestJobs.state,
      resultsWritten: schema.ingestJobs.resultsWritten,
      error: schema.ingestJobs.errorMessage,
    })
    .from(schema.ingestJobs)
    .where(eq(schema.ingestJobs.runId, runId));

  return { ...run, jobs };
}
