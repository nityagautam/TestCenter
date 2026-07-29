import { FlakyLeaderboard, type FlakyParams } from "@/features/flaky-leaderboard";

/**
 * Flaky tests within one project.
 *
 * Renders the shared component rather than redirecting to the organisation-wide route, so
 * the URL keeps naming the project and the header and nav stay in agreement with it. Same
 * reasoning as the project run list and test search.
 */
export const dynamic = "force-dynamic";

export default async function ProjectFlakyPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; projectKey: string }>;
  searchParams: Promise<FlakyParams>;
}) {
  const { orgSlug, projectKey } = await params;
  const query = await searchParams;

  return (
    <FlakyLeaderboard
      orgSlug={orgSlug}
      basePath={`/o/${orgSlug}/p/${projectKey}/flaky`}
      scopedProjectKey={projectKey}
      query={query}
    />
  );
}
