import Link from "next/link";
import { listProjects, listSuites, searchTests } from "@testcenter/db";
import { Card, EmptyState, StatusBadge } from "@/components/ui";
import { SearchBox } from "@/components/search-box";
import { formatDuration, formatPercent, formatRelativeTime, truncateStart } from "@/lib/format";
import { getServices } from "@/lib/services";
import { requirePageContext } from "@/lib/viewer";

/**
 * Test search.
 *
 * Searching by name is the fastest route to a specific test, and the filters answer
 * the questions people actually arrive with — what is failing, what is flaky, what is
 * slow. All of it runs in SQL against the per-test rollups, so the page cost does not
 * grow with result history.
 */
export const dynamic = "force-dynamic";

interface SearchParams {
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

export default async function TestsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { orgSlug } = await params;
  const query = await searchParams;
  const context = await requirePageContext(orgSlug);
  const { sql } = getServices();

  const projects = await listProjects(sql, context.org.id);
  const project = query.project
    ? projects.find((candidate) => candidate.key === query.project)
    : undefined;

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
    const search = next.toString();
    return search ? `/o/${orgSlug}/tests?${search}` : `/o/${orgSlug}/tests`;
  };

  const totalPages = Math.max(Math.ceil(results.total / perPage), 1);

  return (
    <main className="mx-auto max-w-7xl px-6 py-6">
      <div className="mb-4">
        <h1 className="text-lg font-semibold tracking-tight">Tests</h1>
        <p className="mt-0.5 text-xs text-[var(--color-ink-muted)]">
          {results.total.toLocaleString()} test{results.total === 1 ? "" : "s"}
          {project ? ` in ${project.name}` : " across all projects"}
        </p>
      </div>

      <div className="mb-4 space-y-3">
        <SearchBox
          action={`/o/${orgSlug}/tests`}
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

          {projects.length > 1 ? (
            <FilterGroup label="Project">
              <FilterChip href={buildHref({ project: null })} active={!query.project}>
                All
              </FilterChip>
              {projects.slice(0, 6).map((candidate) => (
                <FilterChip
                  key={candidate.key}
                  href={buildHref({ project: candidate.key })}
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

      <div className="grid gap-5 lg:grid-cols-[1fr_220px]">
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
              <table className="w-full text-left text-xs">
                <thead className="tc-sticky border-b border-[var(--color-border-subtle)] text-[10px] tracking-wide text-[var(--color-ink-muted)] uppercase">
                  <tr>
                    <th className="px-4 py-2 font-medium">Test</th>
                    <th className="px-3 py-2 font-medium">Last</th>
                    <th className="px-3 py-2 text-right font-medium">Fail rate</th>
                    <th className="px-3 py-2 text-right font-medium">Flake</th>
                    <th className="px-3 py-2 text-right font-medium">p95</th>
                    <th className="px-3 py-2 text-right font-medium">Seen</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border-subtle)]">
                  {results.tests.map((test) => (
                    <tr key={test.id} className="hover:bg-[var(--color-surface)]/60">
                      <td className="max-w-md px-4 py-2">
                        <Link
                          href={`/o/${orgSlug}/tests/${test.id}`}
                          className="font-medium hover:underline"
                        >
                          {test.name}
                        </Link>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 font-mono text-[10px] text-[var(--color-ink-muted)]">
                          <span>{test.projectKey}</span>
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
                      <td className="px-3 py-2 text-right font-mono tabular-nums">
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
                      <td className="px-3 py-2 text-right font-mono tabular-nums">
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
