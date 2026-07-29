import { redirect } from "next/navigation";

/**
 * The project run list is the org run list with a project filter applied.
 *
 * Redirecting rather than duplicating the page keeps one implementation of filtering,
 * pagination and tag facets. Two copies would drift, and the drift would show up as
 * "the project view disagrees with the org view".
 */
export default async function ProjectRunsPage({
  params,
}: {
  params: Promise<{ orgSlug: string; projectKey: string }>;
}) {
  const { orgSlug, projectKey } = await params;
  redirect(`/o/${orgSlug}/runs?project=${encodeURIComponent(projectKey)}`);
}
