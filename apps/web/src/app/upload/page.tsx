import { listProjects } from "@testcenter/db";
import { UploadForm } from "@/components/upload-form";
import { Card, CardHeader, EmptyState } from "@/components/ui";
import { getServices } from "@/lib/services";
import { currentOrgId } from "@/lib/session";

/**
 * Upload page.
 *
 * Browser upload exists so a team can see value before wiring CI — the fastest path
 * from "what is this tool" to "that is our nightly". The CI recipes are shown
 * alongside it because the browser path is for evaluation, not the steady state.
 */
export const dynamic = "force-dynamic";

export default async function UploadPage() {
  const orgId = await currentOrgId();
  if (!orgId) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-10">
        <EmptyState
          title="No organization provisioned"
          description="Run `pnpm db:migrate` to bootstrap the default organization and project."
        />
      </main>
    );
  }

  const { sql } = getServices();
  const projects = await listProjects(sql, orgId);

  return (
    <main className="mx-auto max-w-3xl px-6 py-8">
      <header className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight">Upload a report</h1>
        <p className="mt-1 text-xs leading-relaxed text-[var(--color-ink-muted)]">
          JUnit / xUnit XML from pytest, Playwright, Surefire, Gradle, jest-junit, Cypress, Robot or
          TestNG. Parsing happens in the background; you will be taken to the run as it lands.
        </p>
      </header>

      {projects.length === 0 ? (
        <EmptyState
          title="No projects yet"
          description="Create a project first — `pnpm db:migrate` bootstraps a demo project."
        />
      ) : (
        <UploadForm
          projects={projects.map((project) => ({ key: project.key, name: project.name }))}
        />
      )}

      <Card className="mt-8">
        <CardHeader title="From CI instead" />
        <div className="space-y-4 px-5 py-4">
          <div>
            <p className="mb-1.5 text-xs text-[var(--color-ink-muted)]">
              One command, no dependencies — good for trying it from any CI system:
            </p>
            <pre className="overflow-x-auto rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-2 font-mono text-[11px] leading-relaxed">
              {`curl -X POST "$TESTCENTER_URL/api/v1/ingest?project=demo&branch=$BRANCH&tag=suite:regression" \\
  -H "Authorization: Bearer $TESTCENTER_TOKEN" \\
  -F "report=@reports/junit.xml"`}
            </pre>
          </div>
          <div>
            <p className="mb-1.5 text-xs text-[var(--color-ink-muted)]">
              For large reports, request a presigned URL so bytes go straight to object storage and
              never through the API:
            </p>
            <pre className="overflow-x-auto rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-2 font-mono text-[11px] leading-relaxed">
              {`POST /api/v1/runs            → { runId, uploads: [{ uploadUrl }] }
PUT  <uploadUrl>             → the report bytes
POST /api/v1/runs/:id/complete → queues parsing`}
            </pre>
          </div>
          <p className="text-[11px] text-[var(--color-ink-muted)]">
            Mint a token with{" "}
            <span className="font-mono">
              pnpm --filter @testcenter/db mint-token &lt;project&gt;
            </span>
            .
          </p>
        </div>
      </Card>
    </main>
  );
}
