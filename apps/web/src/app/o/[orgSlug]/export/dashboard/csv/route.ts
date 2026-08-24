import type { NextRequest } from "next/server";
import { dashboardExportCsv } from "@/features/dashboard-export-csv";

/*
 * Inside the org segment, not under `/api/v1`, on purpose.
 *
 * This is a download a signed-in reader starts by clicking a button, so it authorises through
 * the session the way every other page in this segment does — `requirePageContext`, one
 * explicit `orgId`, no second auth path to keep in step. `/api/v1` is the token-authenticated
 * machine surface and answers a different question; putting a cookie-authorised CSV there
 * would mean two ways to read tenant data instead of one.
 */
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgSlug: string }> },
): Promise<Response> {
  const { orgSlug } = await params;
  return dashboardExportCsv({
    orgSlug,
    scopedProjectKey: null,
    params: { days: request.nextUrl.searchParams.get("days") ?? undefined },
  });
}
