import { FlakyLeaderboard, type FlakyParams } from "@/features/flaky-leaderboard";

/** Flaky tests across the whole organisation. Project scope lives at `/p/:key/flaky`. */
export const dynamic = "force-dynamic";

export default async function FlakyPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<FlakyParams>;
}) {
  const { orgSlug } = await params;
  const query = await searchParams;

  return (
    <FlakyLeaderboard
      orgSlug={orgSlug}
      basePath={`/o/${orgSlug}/flaky`}
      scopedProjectKey={null}
      query={query}
    />
  );
}
