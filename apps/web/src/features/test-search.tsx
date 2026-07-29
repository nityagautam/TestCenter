import Link from "next/link";
import { notFound } from "next/navigation";
import { listProjects, listSuites, searchTests } from "@testcenter/db";
import { Card, EmptyState, StatusBadge } from "@/components/ui";
import { FilterMenu } from "@/components/filter-menu";
import { SearchBox } from "@/components/search-box";
import {
  formatDuration,
  formatPercent,
  formatRelativeTime,
  truncateStart,
  formatInteger,
  basename,
  commonPrefix,
  dirname,
  truncateMiddle,
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

  /*
   * The opening every visible name shares, lifted out of the rows.
   *
   * Without this the list was fifty rows reading `On Cluster "SWADESHUAT", Negative Produc…`
   * — the same 25 characters repeated, with the ellipsis swallowing the only part that told
   * them apart. Computed from the rows actually on screen rather than from the whole result
   * set, so it always describes exactly what is being displayed.
   */
  const namePrefix = commonPrefix(results.tests.map((test) => test.name));

  /*
   * The secondary line shows whichever identifier actually tells the rows apart.
   *
   * A JUnit report gives three overlapping names and which one is informative depends on
   * the framework. Playwright and pytest put a path in `suite`, so its leaf is the useful
   * part. Cucumber puts the file-level report name in `suite` — identical on every row —
   * and the feature in `classname`, so the feature is the useful part. Showing `suite`
   * unconditionally meant fifty rows repeating "JCP Bulk Upload Ext feature for Bulk SEO —
   * Product Meta", a whole line of height carrying nothing.
   *
   * Whichever is chosen then gets the same shared-prefix treatment as the name, and if
   * nothing survives it the line is dropped rather than printed empty.
   */
  const facetOf = (test: (typeof results.tests)[number]): string =>
    test.suite?.includes("/") ? basename(test.suite) : (test.classname ?? test.suite ?? "");
  const facetPrefix = commonPrefix(results.tests.map(facetOf));

  return (
    <main className="mx-auto max-w-7xl px-6 py-6">
      {/*
       * One header block: what you are looking at, then how to narrow it.
       *
       * The filters were three rows of identically-styled chips — twenty-two boxes in which
       * a status, a project and a sort order were visually indistinguishable, so the top
       * third of the page was a wall you had to read carefully to use at all. Now status is
       * a single segmented control (one control, one choice), ordering is quiet text
       * because it is a preference rather than a filter, and the project chips are gone:
       * the header switcher does that job from every page and lands you on the same
       * section, so a second copy here was competing with it for the same click.
       */}
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h1 className="text-lg font-semibold tracking-tight">Tests</h1>
        <p className="font-mono text-[11px] text-[var(--color-ink-muted)] tabular-nums">
          {formatInteger(results.total)} test{results.total === 1 ? "" : "s"}
          {project ? ` in ${project.name}` : " across all projects"}
        </p>
      </div>

      <div className="mb-4 space-y-2.5">
        {/*
         * One toolbar: find, then narrow, then order — left to right in the sequence they
         * are used.
         *
         * The search field was full-width with the filters on a row beneath, which spent the
         * page's whole width on a field that usually holds one word and split a single job
         * across two bands. It is now sized to its content and the controls sit beside it.
         *
         * Status stays a segmented control rather than becoming a second dropdown: it is the
         * filter people reach for constantly, and a menu would make "show me the failing
         * tests" two clicks while hiding which state is active. Ordering is a menu because it
         * is one choice among five and its current value is worth stating on the trigger.
         */}
        <div className="flex flex-wrap items-center gap-2">
          <SearchBox
            action={basePath}
            defaultValue={query.q ?? ""}
            hidden={Object.fromEntries(
              Object.entries(query).filter(
                ([key, value]) =>
                  key !== "q" && key !== "page" && typeof value === "string" && value,
              ) as [string, string][],
            )}
            placeholder="Search name, class or suite…"
            /*
             * The elastic member of the row.
             *
             * Everything else here is sized by its content — six status options, one sort
             * label — so the search field is the only thing that can absorb whatever width
             * is left, and it is also the control that benefits from having it. A fixed
             * width left a ragged 70px of dead space at the end of the toolbar on a wide
             * screen; `flex-1` spends that on the field instead, at every viewport.
             *
             * `min-w-0` lets it shrink below its placeholder rather than forcing an
             * overflow, and `min-w-[14rem]` keeps it usable until the row genuinely has to
             * wrap, at which point it takes a line of its own.
             */
            className="min-w-0 flex-1 basis-[14rem]"
          />

          <Segmented
            label="Status"
            options={STATUS_FILTERS.map((option) => ({
              label: option.label,
              href: buildHref({ status: option.value || null }),
              active: (query.status ?? "") === option.value,
            }))}
          />

          <FilterMenu
            label="Sort"
            options={SORTS.map((option) => ({
              label: option.label,
              href: buildHref({ sort: option.value }),
              active: (query.sort ?? "recent") === option.value,
            }))}
            align="left"
          />
        </div>

        {/* Active narrowing, shown only when it exists, so the chrome stays quiet when it
            does not. Each one is removable where it sits. */}
        {scopedProjectKey || query.suite || namePrefix ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
            {scopedProjectKey ? (
              <>
                <ActiveFilter
                  label="project"
                  value={scopedProjectKey}
                  removeHref={`/o/${orgSlug}/tests`}
                  removeLabel={`Show tests across all projects instead of ${scopedProjectKey}`}
                />
              </>
            ) : null}
            {query.suite ? (
              <ActiveFilter
                label="suite"
                value={query.suite}
                removeHref={buildHref({ suite: null })}
                removeLabel={`Remove the suite filter ${query.suite}`}
              />
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
                  {results.tests.map((test) => {
                    // Strip the shared opening; it is stated once above the table.
                    const shown =
                      namePrefix && test.name.startsWith(namePrefix)
                        ? test.name.slice(namePrefix.length)
                        : test.name;
                    const rawFacet = facetOf(test);
                    const facet =
                      facetPrefix && rawFacet.startsWith(facetPrefix)
                        ? rawFacet.slice(facetPrefix.length)
                        : rawFacet;
                    const failRate = Number(test.failRate30d);
                    const flake = Number(test.flakeScore);
                    return (
                      <tr key={test.id} className="group hover:bg-[var(--color-surface-raised)]/70">
                        <td className="px-4 py-2">
                          {/* max-width on the <td> is inert under auto table layout — the
                              algorithm sizes the column to its content and ignores it, which
                              is why the column is sized by the header and the bound sits on
                              this block child instead. The full name stays available via the
                              title and on the detail page. */}
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
                              {facet && test.suite ? (
                                <Link
                                  href={buildHref({ suite: test.suite })}
                                  className="truncate hover:text-[var(--color-ink)] hover:underline"
                                  title={`Filter by suite: ${test.suite}`}
                                >
                                  {facet}
                                </Link>
                              ) : null}
                              {test.quarantined ? (
                                <span className="shrink-0 rounded bg-[var(--color-status-skipped)]/15 px-1 text-[var(--color-ink-muted)]">
                                  quarantined
                                </span>
                              ) : null}
                            </div>
                          ) : null}
                        </td>
                        <td className="px-3 py-2">
                          {test.lastStatus ? <StatusBadge status={test.lastStatus} /> : "—"}
                        </td>
                        <td className="px-3 py-2 text-right font-mono whitespace-nowrap tabular-nums">
                          {/* A rate of zero is the good case and does not need saying twice.
                              Muting it lets the eye land on the rows that are not zero. */}
                          <span
                            className={
                              failRate > 0
                                ? "text-[var(--color-status-failed)]"
                                : "text-[var(--color-ink-muted)]"
                            }
                          >
                            {formatPercent(test.failRate30d)}
                          </span>
                          <div className="text-[10px] text-[var(--color-ink-muted)]/70">
                            {test.failures30d}/{test.runs30d}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right font-mono whitespace-nowrap tabular-nums">
                          {flake > 0 ? (
                            <span className="text-[var(--color-status-flaky)]">
                              {flake.toFixed(0)}
                            </span>
                          ) : (
                            <span className="text-[var(--color-ink-muted)]/40">·</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right font-mono whitespace-nowrap text-[var(--color-ink-muted)] tabular-nums">
                          {formatDuration(test.p95DurationMs)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-[10px] whitespace-nowrap text-[var(--color-ink-muted)]">
                          {formatRelativeTime(test.lastSeenAt)}
                        </td>
                      </tr>
                    );
                  })}
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
              <div className="flex items-baseline justify-between border-b border-[var(--color-border-subtle)] px-4 py-2.5">
                <h2 className="text-[10px] font-medium tracking-widest uppercase">Suites</h2>
                {query.suite ? (
                  <Link
                    href={buildHref({ suite: null })}
                    className="text-[10px] text-[var(--color-ink-muted)] underline"
                  >
                    clear
                  </Link>
                ) : null}
              </div>
              <ul className="max-h-96 overflow-y-auto p-1.5">
                {suites.map((suite) => {
                  const active = query.suite === suite.suite;
                  return (
                    <li key={suite.suite}>
                      <Link
                        href={buildHref({ suite: active ? null : suite.suite })}
                        title={suite.suite}
                        aria-current={active ? "true" : undefined}
                        className={`flex items-baseline justify-between gap-2 rounded px-2 py-1 text-[11px] ${
                          active
                            ? "bg-[var(--color-surface-raised)] font-semibold"
                            : "hover:bg-[var(--color-surface-raised)]"
                        }`}
                      >
                        {/*
                         * File name first, directory second and muted.
                         *
                         * This was one truncated-from-the-left path per row, which cut both
                         * ends off — `…/scale/group-33.spec…` — so the entries were neither
                         * readable nor distinguishable, and every count read 125. The leaf is
                         * the identifying part and now gets the space; the path is context and
                         * gets what is left, with the whole thing on hover.
                         */}
                        <span className="min-w-0 truncate">
                          <span className="font-mono">{basename(suite.suite)}</span>
                          {dirname(suite.suite) ? (
                            <span className="ml-1 font-mono text-[9px] text-[var(--color-ink-muted)]">
                              {truncateStart(dirname(suite.suite), 18)}
                            </span>
                          ) : null}
                        </span>
                        <span className="shrink-0 font-mono text-[var(--color-ink-muted)] tabular-nums">
                          {formatInteger(suite.tests)}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </Card>
          ) : null}
        </aside>
      </div>
    </main>
  );
}

/**
 * One control, one choice.
 *
 * Six separate bordered chips read as six independent toggles; a segmented control reads
 * as a single question with one answer, which is what a status filter is. It is also a
 * radiogroup to a screen reader rather than six unrelated links.
 */
function Segmented({
  label,
  options,
}: {
  label: string;
  options: { label: string; href: string; active: boolean }[];
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex h-9 items-stretch overflow-hidden rounded-md border border-[var(--color-border-subtle)]"
    >
      {options.map((option, index) => (
        <Link
          key={option.label}
          href={option.href}
          role="radio"
          aria-checked={option.active}
          className={`inline-flex items-center px-3 text-xs transition-colors ${
            index > 0 ? "border-l border-[var(--color-border-subtle)]" : ""
          } ${
            option.active
              ? "bg-[var(--color-ink)] font-semibold text-[var(--color-surface)]"
              : "text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-ink)]"
          }`}
        >
          {option.label}
        </Link>
      ))}
    </div>
  );
}

/** An applied narrowing, with the way out attached to it. */
function ActiveFilter({
  label,
  value,
  removeHref,
  removeLabel,
}: {
  label: string;
  value: string;
  removeHref: string;
  removeLabel: string;
}) {
  return (
    <span className="inline-flex max-w-full items-baseline gap-1 rounded border border-[var(--color-border-subtle)] py-0.5 pr-1 pl-2">
      <span className="text-[var(--color-ink-muted)]">{label}</span>
      <span className="min-w-0 truncate font-mono text-[var(--color-ink)]" title={value}>
        {value}
      </span>
      <Link
        href={removeHref}
        aria-label={removeLabel}
        className="shrink-0 px-1 text-[var(--color-ink-muted)] hover:text-[var(--color-status-failed)]"
      >
        ×
      </Link>
    </span>
  );
}
