import Link from "next/link";
import { notFound } from "next/navigation";
import { listProjects, listSuites, searchTests } from "@testcenter/db";
import { Card, EmptyState, StatusBadge } from "@/components/ui";
import { SearchBox } from "@/components/search-box";
import {
  formatDuration,
  formatPercent,
  formatRelativeTime,
  truncateStart,
  formatInteger,
} from "@/lib/format";
import { getServices } from "@/lib/services";
import { requirePageContext } from "@/lib/viewer";

/**
 * Test search, rendered at two scopes.
 *
 * Searching by name is the fastest route to a specific test, and the filters answer
 * the questions people actually arrive with — what is failing, what is flaky, what is
 * slow. All of it runs in SQL against the per-test rollups, so the page cost does not
 * grow with result history.
 *
 * One component serves both `/o/:org/tests` and `/o/:org/p/:key/tests`, because the
 * project view *is* the org view with a project filter applied. The project route used to
 * be a `redirect()` to the org route carrying `?project=`, which kept the implementation
 * single but threw the URL out of the `/p/:key/` path — and the shell derives the selected
 * project from the path. Choosing a project in the header and clicking Tests therefore
 * appeared to drop straight back to org-wide: the results were filtered, but the project
 * dropdown reset to "All projects" and the project nav section vanished. Rendering the
 * same component under both paths keeps one implementation *and* keeps the scope.
 *
 * `scopedProjectKey` is the difference between them. When set, the project comes from the
 * URL and is not a filter the page can change, so the project chips give way to a single
 * "all projects" escape hatch.
 */
export interface TestSearchParams {
  q?: string;
  project?: string;
  status?: string;
  suite?: string;
  sort?: string;
  page?: string;
}

const STATUS_FILTERS = [
  { value: "", label: "All" },
  { value: "failing", label: "Failing" },
  { value: "flaky", label: "Flaky" },
  { value: "passing", label: "Passing" },
  { value: "skipped", label: "Skipped" },
  { value: "quarantined", label: "Quarantined" },
] as const;

const SORTS = [
  { value: "recent", label: "Recently seen" },
  { value: "most-failed", label: "Most failures" },
  { value: "flakiest", label: "Flakiest" },
  { value: "slowest", label: "Slowest" },
  { value: "name", label: "Name" },
] as const;

export async function TestSearch({
  orgSlug,
  basePath,
  scopedProjectKey,
  query,
}: {
  orgSlug: string;
  /** Where filter, sort and pagination links point. */
  basePath: string;
  /** Set when the project is fixed by the route rather than chosen by a filter. */
  scopedProjectKey: string | null;
  query: TestSearchParams;
}) {
  const context = await requirePageContext(orgSlug);
  const { sql } = getServices();

  const projects = await listProjects(sql, context.org.id);
  // A path-scoped project wins over ?project=, so a stray query parameter cannot
  // silently widen a view whose URL claims to be about one project.
  const projectKey = scopedProjectKey ?? query.project;
  const project = projectKey
    ? projects.find((candidate) => candidate.key === projectKey)
    : undefined;

  if (scopedProjectKey && !project) notFound();

  const page = Math.max(Number(query.page ?? 1), 1);
  const perPage = 50;

  const [results, suites] = await Promise.all([
    searchTests(
      sql,
      {
        orgId: context.org.id,
        projectId: project?.id,
        query: query.q,
        status: (query.status || undefined) as never,
        suite: query.suite,
        sort: (query.sort || "recent") as never,
      },
      { limit: perPage, offset: (page - 1) * perPage },
    ),
    listSuites(sql, { orgId: context.org.id, projectId: project?.id, limit: 25 }),
  ]);

  const buildHref = (changes: Record<string, string | null>): string => {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (key === "page") continue; // any filter change returns to page 1
      if (typeof value === "string" && value) next.set(key, value);
    }
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    // The project is carried by the path when scoped, so it must not also be a query
    // parameter — two sources for one value is how they end up disagreeing.
    if (scopedProjectKey) next.delete("project");
    const search = next.toString();
    return search ? `${basePath}?${search}` : basePath;
  };

  const totalPages = Math.max(Math.ceil(results.total / perPage), 1);

  return (
    <main className="mx-auto max-w-7xl px-6 py-6">
      <div className="mb-4">
        <h1 className="text-lg font-semibold tracking-tight">Tests</h1>
        <p className="mt-0.5 text-xs text-[var(--color-ink-muted)]">
          {formatInteger(results.total)} test{results.total === 1 ? "" : "s"}
          {project ? ` in ${project.name}` : " across all projects"}
        </p>
      </div>

      <div className="mb-4 space-y-3">
        <SearchBox
          action={basePath}
          defaultValue={query.q ?? ""}
          hidden={Object.fromEntries(
            Object.entries(query).filter(
              ([key, value]) => key !== "q" && key !== "page" && typeof value === "string" && value,
            ) as [string, string][],
          )}
          placeholder="Search test names, classes and suites…"
        />

        {/* Filters in one row above the results, per the interaction guidance. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <FilterGroup label="Status">
            {STATUS_FILTERS.map((option) => (
              <FilterChip
                key={option.value}
                href={buildHref({ status: option.value || null })}
                active={(query.status ?? "") === option.value}
              >
                {option.label}
              </FilterChip>
            ))}
          </FilterGroup>

          {scopedProjectKey ? (
            <FilterGroup label="Project">
              {/* Fixed by the route. The chip is not a filter to toggle, so the only
                  option offered is the one that actually changes scope — widening to the
                  organisation. Switching to a different project is the header dropdown's
                  job, which now keeps you on this section. */}
              <span className="rounded border border-[var(--color-ink-muted)] px-1.5 py-0.5 text-[11px] font-semibold">
                {scopedProjectKey}
              </span>
              <FilterChip href={`/o/${orgSlug}/tests`} active={false}>
                all projects
              </FilterChip>
            </FilterGroup>
          ) : projects.length > 1 ? (
            <FilterGroup label="Project">
              <FilterChip href={buildHref({ project: null })} active={!query.project}>
                All
              </FilterChip>
              {projects.slice(0, 6).map((candidate) => (
                <FilterChip
                  key={candidate.key}
                  href={`/o/${orgSlug}/p/${candidate.key}/tests`}
                  active={query.project === candidate.key}
                >
                  {candidate.key}
                </FilterChip>
              ))}
            </FilterGroup>
          ) : null}

          <FilterGroup label="Sort">
            {SORTS.map((option) => (
              <FilterChip
                key={option.value}
                href={buildHref({ sort: option.value })}
                active={(query.sort ?? "recent") === option.value}
              >
                {option.label}
              </FilterChip>
            ))}
          </FilterGroup>
        </div>

        {query.suite ? (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-[var(--color-ink-muted)]">Suite:</span>
            <Link
              href={buildHref({ suite: null })}
              className="inline-flex items-center gap-1 rounded border border-[var(--color-border-subtle)] px-1.5 py-0.5 font-mono text-[11px] hover:border-[var(--color-status-failed)]"
            >
              {query.suite}
              <span className="text-[var(--color-ink-muted)]">×</span>
            </Link>
          </div>
        ) : null}
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_220px]">
        <Card className="overflow-hidden">
          {results.tests.length === 0 ? (
            <EmptyState
              title="No tests match"
              description={
                query.q
                  ? `Nothing matches "${query.q}". Try a shorter fragment — search matches anywhere in the name.`
                  : "Upload a report and its tests will appear here."
              }
            />
          ) : (
            <div className="overflow-x-auto">
              {/* Fixed layout — see the note on the run results table. */}
              <table className="w-full table-fixed text-left text-xs">
                <thead className="tc-sticky border-b border-[var(--color-border-subtle)] text-[10px] tracking-wide text-[var(--color-ink-muted)] uppercase">
                  <tr>
                    <th className="px-4 py-2 font-medium">Test</th>
                    <th className="w-[6.5rem] px-3 py-2 font-medium whitespace-nowrap">Last</th>
                    <th className="w-[5.5rem] px-3 py-2 text-right font-medium whitespace-nowrap">
                      Fail rate
                    </th>
                    <th className="w-[4.5rem] px-3 py-2 text-right font-medium whitespace-nowrap">
                      Flake
                    </th>
                    <th className="w-[5rem] px-3 py-2 text-right font-medium whitespace-nowrap">
                      p95
                    </th>
                    <th className="w-[5rem] px-3 py-2 text-right font-medium whitespace-nowrap">
                      Seen
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border-subtle)]">
                  {results.tests.map((test) => (
                    <tr key={test.id} className="hover:bg-[var(--color-surface)]/60">
                      <td className="px-4 py-2">
                        {/* max-width on the <td> is inert under auto table layout — the
                            algorithm sizes the column to its content and ignores it. The bound
                            has to sit on a block child for `truncate` to have a width to work
                            against; without it a 200-character test name pushed straight
                            through the status and fail-rate columns. The full name stays
                            reachable via the title and on the detail page. */}
                        <Link
                          href={`/o/${orgSlug}/tests/${test.id}`}
                          className="block truncate font-medium hover:underline"
                          title={test.name}
                        >
                          {test.name}
                        </Link>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 font-mono text-[10px] text-[var(--color-ink-muted)]">
                          {/* Redundant when every row belongs to the same project. */}
                          {scopedProjectKey ? null : <span>{test.projectKey}</span>}
                          {test.suite ? (
                            <Link
                              href={buildHref({ suite: test.suite })}
                              className="truncate hover:underline"
                              title={test.suite}
                            >
                              {truncateStart(test.suite, 40)}
                            </Link>
                          ) : null}
                          {test.quarantined ? (
                            <span className="rounded bg-[var(--color-status-skipped)]/15 px-1">
                              quarantined
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        {test.lastStatus ? <StatusBadge status={test.lastStatus} /> : "—"}
                      </td>
                      <td className="px-3 py-2 text-right font-mono whitespace-nowrap tabular-nums">
                        <span
                          className={
                            Number(test.failRate30d) > 0
                              ? "text-[var(--color-status-failed)]"
                              : "text-[var(--color-ink-muted)]"
                          }
                        >
                          {formatPercent(test.failRate30d)}
                        </span>
                        <div className="text-[10px] text-[var(--color-ink-muted)]">
                          {test.failures30d}/{test.runs30d}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right font-mono whitespace-nowrap tabular-nums">
                        {Number(test.flakeScore) > 0 ? (
                          <span className="text-[var(--color-status-flaky)]">
                            {Number(test.flakeScore).toFixed(0)}
                          </span>
                        ) : (
                          <span className="text-[var(--color-ink-muted)]">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-[var(--color-ink-muted)] tabular-nums">
                        {formatDuration(test.p95DurationMs)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-[10px] whitespace-nowrap text-[var(--color-ink-muted)]">
                        {formatRelativeTime(test.lastSeenAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {totalPages > 1 ? (
            <div className="flex items-center justify-between border-t border-[var(--color-border-subtle)] px-4 py-2.5 text-xs">
              <span className="text-[var(--color-ink-muted)]">
                Page {page} of {totalPages}
              </span>
              <div className="flex gap-2">
                {page > 1 ? (
                  <Link href={buildHref({ page: String(page - 1) })} className="underline">
                    Previous
                  </Link>
                ) : null}
                {page < totalPages ? (
                  <Link href={buildHref({ page: String(page + 1) })} className="underline">
                    Next
                  </Link>
                ) : null}
              </div>
            </div>
          ) : null}
        </Card>

        <aside>
          {suites.length > 0 ? (
            <Card>
              <div className="border-b border-[var(--color-border-subtle)] px-4 py-2.5">
                <h2 className="text-[10px] font-medium tracking-widest uppercase">Suites</h2>
              </div>
              <ul className="max-h-96 overflow-y-auto p-2">
                {suites.map((suite) => (
                  <li key={suite.suite}>
                    <Link
                      href={buildHref({ suite: suite.suite })}
                      className={`flex items-center justify-between gap-2 rounded px-2 py-1 text-[11px] hover:bg-[var(--color-surface)] ${
                        query.suite === suite.suite ? "bg-[var(--color-surface)] font-semibold" : ""
                      }`}
                    >
                      <span className="truncate font-mono" title={suite.suite}>
                        {truncateStart(suite.suite, 24)}
                      </span>
                      <span className="shrink-0 text-[var(--color-ink-muted)] tabular-nums">
                        {suite.tests}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </aside>
      </div>
    </main>
  );
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] tracking-wide text-[var(--color-ink-muted)] uppercase">
        {label}
      </span>
      <div className="flex flex-wrap gap-1">{children}</div>
    </div>
  );
}

function FilterChip({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`rounded border px-1.5 py-0.5 text-[11px] transition-colors ${
        active
          ? "border-[var(--color-ink-muted)] font-semibold"
          : "border-[var(--color-border-subtle)] text-[var(--color-ink-muted)] hover:border-[var(--color-ink-muted)]"
      }`}
    >
      {children}
    </Link>
  );
}
