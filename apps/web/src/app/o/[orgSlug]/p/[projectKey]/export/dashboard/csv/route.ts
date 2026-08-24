import type { NextRequest } from "next/server";
import { dashboardExportCsv } from "@/features/dashboard-export-csv";

/** Project-scoped twin of the org route — see the note there on why this is not `/api/v1`. */
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgSlug: string; projectKey: string }> },
): Promise<Response> {
  const { orgSlug, projectKey } = await params;
  return dashboardExportCsv({
    orgSlug,
    scopedProjectKey: projectKey,
    params: { days: request.nextUrl.searchParams.get("days") ?? undefined },
  });
}
