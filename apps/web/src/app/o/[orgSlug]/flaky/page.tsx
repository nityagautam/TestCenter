import Link from "next/link";
import { flakyLeaderboard, listProjects } from "@testcenter/db";
import { Card, CardHeader, EmptyState } from "@/components/ui";
import { formatDuration, formatPercent, truncateStart } from "@/lib/format";
import { getServices } from "@/lib/services";
import { requirePageContext } from "@/lib/viewer";

/**
 * Flaky test leaderboard.
 *
 * Ordered by flake score, which deliberately scores a consistently-failing test at
 * zero — that test is broken, not flaky, and mixing the two is what makes most flake
 * dashboards useless. The CI-time column exists because "this test has burned four
 * hours of CI" is the argument that actually gets a flake fixed.
 */
export const dynamic = "force-dynamic";

export default async function FlakyPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ project?: string; quarantined?: string }>;
}) {
  const { orgSlug } = await params;
  const query = await searchParams;
  const context = await requirePageContext(orgSlug);
  const { sql } = getServices();

  const projects = await listProjects(sql, context.org.id);
  const project = query.project
    ? projects.find((candidate) => candidate.key === query.project)
    : undefined;
  const includeQuarantined = query.quarantined === "true";

  const tests = await flakyLeaderboard(sql, {
    orgId: context.org.id,
    projectId: project?.id,
    limit: 50,
    includeQuarantined,
  });

  return (
    <main className="mx-auto max-w-5xl px-6 py-6">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Flaky tests</h1>
          <p className="mt-0.5 text-xs text-[var(--color-ink-muted)]">
            Tests that pass inconsistently — either passing on retry, or flipping outcome between
            runs. A test that always fails scores zero: it is broken, not flaky.
          </p>
        </div>
        <Link
          href={`/o/${orgSlug}/flaky?${new URLSearchParams({
            ...(project ? { project: project.key } : {}),
            ...(includeQuarantined ? {} : { quarantined: "true" }),
          }).toString()}`}
          className="rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1.5 text-xs hover:border-[var(--color-ink-muted)]"
        >
          {includeQuarantined ? "Hide quarantined" : "Include quarantined"}
        </Link>
      </div>

      <Card className="overflow-hidden">
        <CardHeader title={`${tests.length} flaky test${tests.length === 1 ? "" : "s"}`} />
        {tests.length === 0 ? (
          <EmptyState
            title="No flaky tests detected"
            description="Flakiness needs history to detect — a test has to be seen across several runs before an inconsistency is distinguishable from a one-off failure."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-[var(--color-border-subtle)] text-[10px] tracking-wide text-[var(--color-ink-muted)] uppercase">
                <tr>
                  <th className="px-4 py-2 font-medium">Test</th>
                  <th className="px-3 py-2 text-right font-medium">Flake</th>
                  <th className="px-3 py-2 text-right font-medium">Fail rate</th>
                  <th className="px-3 py-2 text-right font-medium">Runs</th>
                  <th className="px-3 py-2 text-right font-medium">CI time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border-subtle)]">
                {tests.map((test) => (
                  <tr key={test.id} className="hover:bg-[var(--color-surface)]/60">
                    <td className="max-w-lg px-4 py-2">
                      <Link
                        href={`/o/${orgSlug}/tests/${test.id}`}
                        className="font-medium hover:underline"
                      >
                        {test.name}
                      </Link>
                      <div className="mt-0.5 flex flex-wrap gap-x-2 font-mono text-[10px] text-[var(--color-ink-muted)]">
                        <span>{test.projectKey}</span>
                        {test.suite ? (
                          <span title={test.suite}>{truncateStart(test.suite, 36)}</span>
                        ) : null}
                        {test.quarantined ? (
                          <span className="rounded bg-[var(--color-status-skipped)]/15 px-1">
                            quarantined
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <span className="font-mono text-[var(--color-status-flaky)] tabular-nums">
                        {Number(test.flakeScore).toFixed(0)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-[var(--color-ink-muted)] tabular-nums">
                      {formatPercent(test.failRate30d)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-[var(--color-ink-muted)] tabular-nums">
                      {test.failures30d}/{test.runs30d}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-[var(--color-ink-muted)] tabular-nums">
                      {formatDuration(test.wastedMs)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </main>
  );
}
