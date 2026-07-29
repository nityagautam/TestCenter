import { TestSearch, type TestSearchParams } from "@/features/test-search";

/** Test search across the whole organisation. Project scope lives at `/p/:key/tests`. */
export const dynamic = "force-dynamic";

export default async function TestsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<TestSearchParams>;
}) {
  const { orgSlug } = await params;
  const query = await searchParams;

  return (
    <TestSearch
      orgSlug={orgSlug}
      basePath={`/o/${orgSlug}/tests`}
      scopedProjectKey={null}
      query={query}
    />
  );
}
