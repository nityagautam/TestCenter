"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Live parse progress.
 *
 * Ingest is asynchronous, so a freshly uploaded run briefly has no results. Without
 * feedback that reads as an empty or broken run — the single most confusing moment in
 * the product. This subscribes to the run's SSE stream and refreshes the page once
 * parsing reaches a terminal state, so the placeholder becomes real data on its own.
 */
interface Snapshot {
  status: string;
  total: number;
  passed: number;
  failed: number;
  jobs: { stage: string; state: string; resultsWritten: number; error: string | null }[];
}

export function RunProgress({ runId }: { runId: string }) {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const source = new EventSource(`/api/v1/runs/${runId}/events`);

    source.addEventListener("progress", (event) => {
      try {
        setSnapshot(JSON.parse((event as MessageEvent<string>).data) as Snapshot);
      } catch {
        // A malformed frame is not worth tearing the stream down for.
      }
    });

    source.addEventListener("done", () => {
      source.close();
      // Pull the finished results in without a full reload.
      router.refresh();
    });

    source.addEventListener("error", () => {
      // EventSource retries on its own; surface it only if it never connects.
      if (source.readyState === EventSource.CLOSED) {
        setError("lost connection to the progress stream");
      }
    });

    return () => source.close();
  }, [runId, router]);

  const stage = snapshot?.jobs.find((job) => job.state === "running")?.stage;
  const failedJob = snapshot?.jobs.find((job) => job.state === "dead" || job.state === "failed");

  return (
    <div className="rounded-xl border border-sky-500/40 bg-sky-500/5 px-5 py-4">
      <div className="flex items-center gap-3">
        <span className="relative flex size-2.5">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-sky-500 opacity-60" />
          <span className="relative inline-flex size-2.5 rounded-full bg-sky-500" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            {failedJob ? "Ingest failed" : "Parsing report…"}
            {stage && !failedJob ? (
              <span className="ml-2 font-mono text-[11px] text-[var(--color-ink-muted)]">
                stage: {stage}
              </span>
            ) : null}
          </p>
          <p className="mt-0.5 font-mono text-[11px] text-[var(--color-ink-muted)]">
            {failedJob?.error
              ? failedJob.error
              : snapshot
                ? `${snapshot.total} result${snapshot.total === 1 ? "" : "s"} written` +
                  (snapshot.failed > 0 ? ` · ${snapshot.failed} failing` : "")
                : "connecting…"}
          </p>
          {error ? (
            <p className="mt-1 text-[11px] text-[var(--color-status-failed)]">
              {error} — reload to check the current state.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
