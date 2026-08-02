import { Reports, type ReportsParams } from "@/features/reports";

/**
 * Project-scoped reports.
 *
 * Rendered by the same component as the org view under a different path, for the reason
 * documented on the run list: the shell derives the selected project from the path, so a
 * redirect carrying `?project=` would silently reset the header scope.
 */
export const dynamic = "force-dynamic";

export default async function ProjectReportsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; projectKey: string }>;
  searchParams: Promise<ReportsParams>;
}) {
  const { orgSlug, projectKey } = await params;
  const query = await searchParams;

  return (
    <Reports
      orgSlug={orgSlug}
      basePath={`/o/${orgSlug}/p/${projectKey}/reports`}
      scopedProjectKey={projectKey}
      params={query}
    />
  );
}
