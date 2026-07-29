import { RunList, type RunListParams } from "@/features/run-list";

/**
 * The project run list is the org run list with a project filter applied.
 *
 * Rendering the shared component keeps one implementation of filtering, pagination and
 * tag facets — two copies would drift, and the drift would show as "the project view
 * disagrees with the org view". This used to achieve that by redirecting to the org route
 * with `?project=`, which also moved the URL out of `/p/:key/` and so silently discarded
 * the project scope the header had just been used to select.
 */
export const dynamic = "force-dynamic";

export default async function ProjectRunsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; projectKey: string }>;
  searchParams: Promise<RunListParams>;
}) {
  const { orgSlug, projectKey } = await params;
  const query = await searchParams;

  return (
    <RunList
      orgSlug={orgSlug}
      basePath={`/o/${orgSlug}/p/${projectKey}/runs`}
      scopedProjectKey={projectKey}
      params={query}
    />
  );
}
