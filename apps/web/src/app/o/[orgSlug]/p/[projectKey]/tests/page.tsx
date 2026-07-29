import { TestSearch, type TestSearchParams } from "@/features/test-search";

/**
 * Test search within one project.
 *
 * Renders the same component as the org-wide route rather than redirecting to it. The
 * redirect kept one implementation but moved the URL out of `/p/:key/`, and the shell
 * reads the selected project from the path — so picking a project in the header and
 * clicking Tests looked like it had been ignored. See the note in `features/test-search`.
 */
export const dynamic = "force-dynamic";

export default async function ProjectTestsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; projectKey: string }>;
  searchParams: Promise<TestSearchParams>;
}) {
  const { orgSlug, projectKey } = await params;
  const query = await searchParams;

  return (
    <TestSearch
      orgSlug={orgSlug}
      basePath={`/o/${orgSlug}/p/${projectKey}/tests`}
      scopedProjectKey={projectKey}
      query={query}
    />
  );
}
