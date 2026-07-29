import { RunList, type RunListParams } from "@/features/run-list";

/** Run list across the whole organisation. Project scope lives at `/p/:key/runs`. */
export const dynamic = "force-dynamic";

export default async function RunsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<RunListParams>;
}) {
  const { orgSlug } = await params;
  const query = await searchParams;

  return (
    <RunList
      orgSlug={orgSlug}
      basePath={`/o/${orgSlug}/runs`}
      scopedProjectKey={null}
      params={query}
    />
  );
}
