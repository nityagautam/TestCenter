import Link from "next/link";
import { flakyLeaderboard, listProjects } from "@testcenter/db";
import { Card, CardHeader, EmptyState } from "@/components/ui";
import { notFound } from "next/navigation";
import {
  basename,
  commonPrefix,
  formatDuration,
  formatPercent,
  truncateMiddle,
} from "@/lib/format";
import { getServices } from "@/lib/services";
import { requirePageContext } from "@/lib/viewer";

/**
 * Flaky test leaderboard, rendered at two scopes.
 *
 * Ordered by flake score, which deliberately scores a consistently-failing test at zero —
 * that test is broken, not flaky, and mixing the two is what makes most flake dashboards
 * useless. The CI-time column exists because "this test has burned four hours of CI" is
 * the argument that actually gets a flake fixed.
 *
 * One component serves both `/o/:org/flaky` and `/o/:org/p/:key/flaky`, the same way the
 * run list and test search do. Which project a flake belongs to matters more here than
 * almost anywhere else: flakiness is usually owned by one team, and a leaderboard mixing
 * every project's flakes is a list nobody feels responsible for.
 */
export interface FlakyParams {
  quarantined?: string;
  project?: string;
}

export async function FlakyLeaderboard({
  orgSlug,
  basePath,
  scopedProjectKey,
  query,
}: {
  orgSlug: string;
  /** Where the quarantine toggle points. */
  basePath: string;
  /** Set when the project is fixed by the route rather than chosen by a filter. */
  scopedProjectKey: string | null;
  query: FlakyParams;
}) {
  const context = await requirePageContext(orgSlug);
  const { sql } = getServices();

  const projects = await listProjects(sql, context.org.id);
  // A path-scoped project wins over ?project=, so a stray query parameter cannot widen a
  // view whose URL claims to be about one project.
  const projectKey = scopedProjectKey ?? query.project;
  const project = projectKey
    ? projects.find((candidate) => candidate.key === projectKey)
    : undefined;

  if (scopedProjectKey && !project) notFound();

  const includeQuarantined = query.quarantined === "true";

  const tests = await flakyLeaderboard(sql, {
    orgId: context.org.id,
    projectId: project?.id,
    limit: 50,
    includeQuarantined,
  });

  // Same reasoning as the test list: a shared opening repeated down every row hides the
  // part that differs, so it is stated once and dropped from the rows.
  const namePrefix = commonPrefix(tests.map((test) => test.name));
  const facetOf = (test: (typeof tests)[number]): string =>
    test.suite?.includes("/") ? basename(test.suite) : (test.suite ?? "");
  const facetPrefix = commonPrefix(tests.map(facetOf));

  const toggleHref = `${basePath}?${new URLSearchParams({
    ...(scopedProjectKey ? {} : project ? { project: project.key } : {}),
    ...(includeQuarantined ? {} : { quarantined: "true" }),
  }).toString()}`;

  return (
    <main className="mx-auto max-w-5xl px-6 py-6">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Flaky tests</h1>
          <p className="mt-0.5 max-w-2xl text-xs text-[var(--color-ink-muted)]">
            Tests that pass inconsistently — either passing on retry, or flipping outcome between
            runs. A test that always fails scores zero: it is broken, not flaky.
          </p>
        </div>
        <Link
          href={toggleHref}
          className="rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1.5 text-xs whitespace-nowrap hover:border-[var(--color-ink-muted)]"
        >
          {includeQuarantined ? "Hide quarantined" : "Include quarantined"}
        </Link>
      </div>

      {scopedProjectKey || namePrefix ? (
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
          {scopedProjectKey ? (
            <span className="inline-flex items-baseline gap-1 rounded border border-[var(--color-border-subtle)] py-0.5 pr-1 pl-2">
              <span className="text-[var(--color-ink-muted)]">project</span>
              <span className="font-mono text-[var(--color-ink)]">{scopedProjectKey}</span>
              <Link
                href={`/o/${orgSlug}/flaky`}
                aria-label={`Show flaky tests across all projects instead of ${scopedProjectKey}`}
                className="shrink-0 px-1 text-[var(--color-ink-muted)] hover:text-[var(--color-status-failed)]"
              >
                ×
              </Link>
            </span>
          ) : null}
          {namePrefix ? (
            <span
              className="text-[var(--color-ink-muted)]"
              title="Shared by every name below, hidden from the rows so the differences are readable"
            >
              names begin{" "}
              <span className="font-mono text-[var(--color-ink)]">{namePrefix.trim()}</span>
            </span>
          ) : null}
        </div>
      ) : null}

      <Card className="overflow-hidden">
        <CardHeader
          title={`${tests.length} flaky test${tests.length === 1 ? "" : "s"}${
            project ? ` in ${project.name}` : ""
          }`}
        />
        {tests.length === 0 ? (
          <EmptyState
            title="No flaky tests detected"
            description={
              project
                ? `Nothing in ${project.name} is flaking. Flakiness needs history to detect — a test has to be seen across several runs before an inconsistency is distinguishable from a one-off failure.`
                : "Flakiness needs history to detect — a test has to be seen across several runs before an inconsistency is distinguishable from a one-off failure."
            }
          />
        ) : (
          <div className="overflow-x-auto">
            {/* Fixed layout — see the note on the run results table. */}
            <table className="w-full table-fixed text-left text-xs">
              <thead className="tc-sticky border-b border-[var(--color-border-subtle)] text-[10px] tracking-wide text-[var(--color-ink-muted)] uppercase">
                <tr>
                  <th className="px-4 py-2 font-medium">Test</th>
                  <th className="w-[4.5rem] px-3 py-2 text-right font-medium whitespace-nowrap">
                    Flake
                  </th>
                  <th className="w-[5.5rem] px-3 py-2 text-right font-medium whitespace-nowrap">
                    Fail rate
                  </th>
                  <th className="w-[4.5rem] px-3 py-2 text-right font-medium whitespace-nowrap">
                    Runs
                  </th>
                  <th className="w-[5.5rem] px-3 py-2 text-right font-medium whitespace-nowrap">
                    CI time
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border-subtle)]">
                {tests.map((test) => {
                  const shown =
                    namePrefix && test.name.startsWith(namePrefix)
                      ? test.name.slice(namePrefix.length)
                      : test.name;
                  const rawFacet = facetOf(test);
                  const facet =
                    facetPrefix && rawFacet.startsWith(facetPrefix)
                      ? rawFacet.slice(facetPrefix.length)
                      : rawFacet;
                  return (
                    <tr key={test.id} className="group hover:bg-[var(--color-surface-raised)]/70">
                      <td className="px-4 py-2">
                        {/* Bound on the child, not the cell — see the note in features/test-search. */}
                        <Link
                          href={`/o/${orgSlug}/tests/${test.id}`}
                          className="block truncate font-medium group-hover:underline"
                          title={test.name}
                        >
                          {truncateMiddle(shown)}
                        </Link>
                        {facet || test.quarantined || !scopedProjectKey ? (
                          <div className="mt-0.5 flex items-center gap-x-2 font-mono text-[10px] text-[var(--color-ink-muted)]">
                            {/* Redundant when every row belongs to the same project. */}
                            {scopedProjectKey ? null : (
                              <span className="shrink-0">{test.projectKey}</span>
                            )}
                            {facet ? (
                              <span className="truncate" title={test.suite ?? ""}>
                                {facet}
                              </span>
                            ) : null}
                            {test.quarantined ? (
                              <span className="shrink-0 rounded bg-[var(--color-status-skipped)]/15 px-1">
                                quarantined
                              </span>
                            ) : null}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <span className="font-mono text-[var(--color-status-flaky)] tabular-nums">
                          {Number(test.flakeScore).toFixed(0)}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right font-mono whitespace-nowrap text-[var(--color-ink-muted)] tabular-nums">
                        {formatPercent(test.failRate30d)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono whitespace-nowrap text-[var(--color-ink-muted)] tabular-nums">
                        {test.failures30d}/{test.runs30d}
                      </td>
                      <td className="px-3 py-2 text-right font-mono whitespace-nowrap text-[var(--color-ink-muted)] tabular-nums">
                        {formatDuration(test.wastedMs)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </main>
  );
}
