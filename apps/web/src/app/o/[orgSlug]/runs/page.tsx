import Link from "next/link";
import { normalizeTags, type Tags } from "@testcenter/core";
import { findProjectByKey, listRuns, runFilterOptions, tagFacets } from "@testcenter/db";
import { Button, Card, EmptyState, ResultBar, StatusBadge, TagChip } from "@/components/ui";
import { formatDuration, formatPercent, formatRelativeTime, shortSha } from "@/lib/format";
import { getServices } from "@/lib/services";
import { can, requirePageContext } from "@/lib/viewer";

/**
 * Run list.
 *
 * Filters live in the URL, which makes every view shareable ("here's the failing
 * staging runs on main") and lets the browser and CDN cache pages naturally. It also
 * means filter state survives a reload, which people expect from a dashboard they
 * keep open all day.
 *
 * All filtering, ordering and counting happens in Postgres — the page never receives
 * rows it does not display.
 */
export const dynamic = "force-dynamic";

interface SearchParams {
  project?: string;
  branch?: string;
  environment?: string;
  framework?: string;
  status?: string;
  search?: string;
  tag?: string | string[];
  failed?: string;
  cursor?: string;
}

function parseTagParams(tag: string | string[] | undefined): Tags {
  const entries = (Array.isArray(tag) ? tag : tag ? [tag] : [])
    .map((raw) => {
      const match = /^([^:=]+)[:=](.*)$/.exec(raw);
      return match ? ([match[1] as string, match[2] as string] as const) : null;
    })
    .filter((pair): pair is readonly [string, string] => pair !== null);
  return normalizeTags(Object.fromEntries(entries));
}

/** Builds a URL with one parameter changed, preserving everything else. */
function buildHref(
  base: string,
  current: SearchParams,
  changes: Record<string, string | null>,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(current)) {
    if (key === "cursor") continue; // any filter change resets pagination
    if (Array.isArray(value)) value.forEach((entry) => params.append(key, entry));
    else if (value) params.set(key, value);
  }
  for (const [key, value] of Object.entries(changes)) {
    params.delete(key);
    if (value !== null) params.append(key, value);
  }
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

function addTagHref(base: string, current: SearchParams, key: string, value: string): string {
  const params = new URLSearchParams();
  for (const [paramKey, paramValue] of Object.entries(current)) {
    if (paramKey === "cursor") continue;
    if (Array.isArray(paramValue)) paramValue.forEach((entry) => params.append(paramKey, entry));
    else if (paramValue) params.set(paramKey, paramValue);
  }
  const existing = params.getAll("tag");
  const candidate = `${key}:${value}`;
  if (!existing.includes(candidate)) params.append("tag", candidate);
  return `${base}?${params.toString()}`;
}

function decodeCursor(value: string | undefined): { startedAt: Date; id: string } | null {
  if (!value) return null;
  try {
    const [startedAt, id] = Buffer.from(value, "base64url").toString("utf8").split("|");
    if (!startedAt || !id) return null;
    const date = new Date(startedAt);
    return Number.isNaN(date.getTime()) ? null : { startedAt: date, id };
  } catch {
    return null;
  }
}

function encodeCursor(cursor: { startedAt: Date; id: string }): string {
  return Buffer.from(`${cursor.startedAt.toISOString()}|${cursor.id}`).toString("base64url");
}

export default async function RunsPage({
  params: routeParams,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const { orgSlug } = await routeParams;
  const context = await requirePageContext(orgSlug);
  const orgId = context.org.id;
  const { sql } = getServices();
  const base = `/o/${orgSlug}/runs`;
  const tags = parseTagParams(params.tag);
  // Upload needs a project, so send them to pick one when the list is unfiltered.
  const uploadHref = params.project
    ? `/o/${orgSlug}/p/${params.project}/upload`
    : `/o/${orgSlug}/projects`;

  const project = params.project
    ? await findProjectByKey(sql, { orgId, key: params.project })
    : null;

  const filter = {
    orgId,
    projectId: project?.id,
    branch: params.branch,
    environment: params.environment,
    framework: params.framework,
    status: params.status ? params.status.split(",") : undefined,
    search: params.search,
    tags: Object.keys(tags).length > 0 ? tags : undefined,
    onlyFailed: params.failed === "true",
  };

  const [page, facets, options] = await Promise.all([
    listRuns(sql, filter, { limit: 25, cursor: decodeCursor(params.cursor) }),
    tagFacets(sql, filter, { limit: 24 }),
    runFilterOptions(sql, filter),
  ]);

  const activeFilters = [
    params.branch
      ? { label: `branch:${params.branch}`, href: buildHref(base, params, { branch: null }) }
      : null,
    params.environment
      ? { label: `env:${params.environment}`, href: buildHref(base, params, { environment: null }) }
      : null,
    params.framework
      ? {
          label: `framework:${params.framework}`,
          href: buildHref(base, params, { framework: null }),
        }
      : null,
    params.failed === "true"
      ? { label: "has failures", href: buildHref(base, params, { failed: null }) }
      : null,
    params.search
      ? { label: `"${params.search}"`, href: buildHref(base, params, { search: null }) }
      : null,
    ...Object.entries(tags).map(([key, value]) => ({
      label: `${key}:${value}`,
      href: (() => {
        const remaining = Object.entries(tags).filter(([k]) => k !== key);
        const search = new URLSearchParams();
        for (const [paramKey, paramValue] of Object.entries(params)) {
          if (paramKey === "tag" || paramKey === "cursor") continue;
          if (typeof paramValue === "string" && paramValue) search.set(paramKey, paramValue);
        }
        remaining.forEach(([k, v]) => search.append("tag", `${k}:${v}`));
        const query = search.toString();
        return query ? `/o/${orgSlug}/runs?${query}` : "/runs";
      })(),
    })),
  ].filter((entry): entry is { label: string; href: string } => entry !== null);

  return (
    <main className="mx-auto max-w-7xl px-6 py-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Runs</h1>
          <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
            {project ? `Project ${project.name}` : "All projects"} · newest first
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            href={buildHref(base, params, { failed: params.failed === "true" ? null : "true" })}
          >
            {params.failed === "true" ? "Showing failures" : "Only failures"}
          </Button>
          {can(context, "run:upload") ? (
            <Button href={uploadHref} variant="primary">
              Upload report
            </Button>
          ) : null}
        </div>
      </div>

      {activeFilters.length > 0 ? (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="text-xs text-[var(--color-ink-muted)]">Filters:</span>
          {activeFilters.map((entry) => (
            <Link
              key={entry.label}
              href={entry.href}
              className="inline-flex items-center gap-1 rounded border border-[var(--color-border-subtle)] px-1.5 py-0.5 font-mono text-[11px] hover:border-[var(--color-status-failed)]"
            >
              {entry.label}
              <span className="text-[var(--color-ink-muted)]">×</span>
            </Link>
          ))}
          <Link
            href={`/o/${orgSlug}/runs`}
            className="text-[11px] text-[var(--color-ink-muted)] underline"
          >
            clear all
          </Link>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1fr_240px]">
        <Card className="overflow-hidden">
          {page.runs.length === 0 ? (
            <EmptyState
              title="No runs match"
              description={
                activeFilters.length > 0
                  ? "Try removing a filter, or upload a report to get started."
                  : "Upload a JUnit XML report, or POST one to /api/v1/ingest from CI."
              }
              action={
                can(context, "run:upload") ? (
                  <Button href={uploadHref} variant="primary">
                    Upload a report
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <ul className="divide-y divide-[var(--color-border-subtle)]">
              {page.runs.map((run) => {
                const failing = run.failed + run.errored;
                return (
                  <li key={run.id} className="px-5 py-3.5 hover:bg-[var(--color-surface)]/60">
                    <div className="flex items-start gap-4">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Link
                            href={`/o/${orgSlug}/runs/${run.id}`}
                            className="text-sm font-medium hover:underline"
                          >
                            {run.name ?? run.framework ?? "Run"}
                          </Link>
                          <StatusBadge status={run.status} />
                          {run.flaky > 0 ? (
                            <StatusBadge status="flaky">{run.flaky} flaky</StatusBadge>
                          ) : null}
                          {run.warningCount > 0 ? (
                            <span className="rounded bg-[var(--color-status-flaky)]/10 px-1.5 py-0.5 text-[11px] text-[var(--color-status-flaky)]">
                              {run.warningCount} warning{run.warningCount === 1 ? "" : "s"}
                            </span>
                          ) : null}
                        </div>

                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-[var(--color-ink-muted)]">
                          <span>{run.projectKey}</span>
                          {run.branch ? <span>{run.branch}</span> : null}
                          {shortSha(run.commitSha) ? <span>{shortSha(run.commitSha)}</span> : null}
                          {run.environment ? <span>{run.environment}</span> : null}
                          <span>{formatDuration(run.durationMs)}</span>
                          <span>{formatRelativeTime(run.startedAt)}</span>
                        </div>

                        {Object.keys(run.tags).length > 0 ? (
                          <div className="mt-2 flex flex-wrap gap-1">
                            {Object.entries(run.tags)
                              .slice(0, 6)
                              .map(([key, value]) => (
                                <TagChip
                                  key={key}
                                  tagKey={key}
                                  value={value}
                                  href={addTagHref(base, params, key, value)}
                                />
                              ))}
                          </div>
                        ) : null}
                      </div>

                      <div className="w-44 shrink-0">
                        <div className="flex items-baseline justify-between font-mono text-xs tabular-nums">
                          <span
                            className={
                              failing > 0
                                ? "text-[var(--color-status-failed)]"
                                : "text-[var(--color-status-passed)]"
                            }
                          >
                            {formatPercent(run.passRate)}
                          </span>
                          <span className="text-[var(--color-ink-muted)]">
                            {run.total} test{run.total === 1 ? "" : "s"}
                          </span>
                        </div>
                        <div className="mt-1.5">
                          <ResultBar
                            passed={run.passed}
                            failed={failing}
                            skipped={run.skipped}
                            flaky={run.flaky}
                            total={run.total}
                          />
                        </div>
                        <div className="mt-1.5 font-mono text-[11px] text-[var(--color-ink-muted)]">
                          {failing > 0 ? `${failing} failing · ` : ""}
                          {run.skipped > 0 ? `${run.skipped} skipped` : `${run.passed} passed`}
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {page.nextCursor ? (
            <div className="border-t border-[var(--color-border-subtle)] px-5 py-3">
              <Button href={buildHref(base, params, { cursor: encodeCursor(page.nextCursor) })}>
                Load older runs
              </Button>
            </div>
          ) : null}
        </Card>

        <aside className="space-y-4">
          {facets.length > 0 ? (
            <Card>
              <div className="border-b border-[var(--color-border-subtle)] px-4 py-2.5">
                <h2 className="text-xs font-medium tracking-wide uppercase">Tags</h2>
              </div>
              <ul className="max-h-80 overflow-y-auto p-2">
                {facets.map((facet) => (
                  <li key={`${facet.key}:${facet.value}`}>
                    <Link
                      href={addTagHref(base, params, facet.key, facet.value)}
                      className="flex items-center justify-between gap-2 rounded px-2 py-1 text-[11px] hover:bg-[var(--color-surface)]"
                    >
                      <span className="truncate font-mono">
                        <span className="text-[var(--color-ink-muted)]">{facet.key}</span>:
                        {facet.value}
                      </span>
                      <span className="shrink-0 text-[var(--color-ink-muted)] tabular-nums">
                        {facet.count}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          {options.branches.length > 0 ? (
            <FacetList
              title="Branch"
              values={options.branches}
              active={params.branch}
              hrefFor={(value) => buildHref(base, params, { branch: value })}
              clearHref={buildHref(base, params, { branch: null })}
            />
          ) : null}

          {options.frameworks.length > 0 ? (
            <FacetList
              title="Framework"
              values={options.frameworks}
              active={params.framework}
              hrefFor={(value) => buildHref(base, params, { framework: value })}
              clearHref={buildHref(base, params, { framework: null })}
            />
          ) : null}

          {options.environments.length > 0 ? (
            <FacetList
              title="Environment"
              values={options.environments}
              active={params.environment}
              hrefFor={(value) => buildHref(base, params, { environment: value })}
              clearHref={buildHref(base, params, { environment: null })}
            />
          ) : null}
        </aside>
      </div>
    </main>
  );
}

function FacetList({
  title,
  values,
  active,
  hrefFor,
  clearHref,
}: {
  title: string;
  values: string[];
  active: string | undefined;
  hrefFor: (value: string) => string;
  clearHref: string;
}) {
  return (
    <Card>
      <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-4 py-2.5">
        <h2 className="text-xs font-medium tracking-wide uppercase">{title}</h2>
        {active ? (
          <Link href={clearHref} className="text-[11px] text-[var(--color-ink-muted)] underline">
            clear
          </Link>
        ) : null}
      </div>
      <ul className="max-h-56 overflow-y-auto p-2">
        {values.map((value) => (
          <li key={value}>
            <Link
              href={hrefFor(value)}
              className={`block truncate rounded px-2 py-1 font-mono text-[11px] hover:bg-[var(--color-surface)] ${
                active === value ? "bg-[var(--color-surface)] font-semibold" : ""
              }`}
            >
              {value}
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
