import { redirect } from "next/navigation";

/** Same reasoning as the project run list: one search implementation, scoped. */
export default async function ProjectTestsPage({
  params,
}: {
  params: Promise<{ orgSlug: string; projectKey: string }>;
}) {
  const { orgSlug, projectKey } = await params;
  redirect(`/o/${orgSlug}/tests?project=${encodeURIComponent(projectKey)}`);
}
