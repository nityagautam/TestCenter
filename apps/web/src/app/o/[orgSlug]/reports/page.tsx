import { Reports, type ReportsParams } from "@/features/reports";

/** Organisation-wide reports. Project scope lives at `/p/:key/reports`. */
export const dynamic = "force-dynamic";

export default async function OrgReportsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<ReportsParams>;
}) {
  const { orgSlug } = await params;
  const query = await searchParams;

  return (
    <Reports
      orgSlug={orgSlug}
      basePath={`/o/${orgSlug}/reports`}
      scopedProjectKey={null}
      params={query}
    />
  );
}
