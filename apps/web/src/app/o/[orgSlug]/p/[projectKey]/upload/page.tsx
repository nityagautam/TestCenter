import { CiSnippet } from "@/components/ci-snippet";
import { UploadForm } from "@/components/upload-form";
import { PermissionDenied } from "@/components/permission-denied";
import { Card, CardHeader } from "@/components/ui";
import { can, requirePageContext, requirePageProject } from "@/lib/viewer";

export const dynamic = "force-dynamic";

export default async function ProjectUploadPage({
  params,
}: {
  params: Promise<{ orgSlug: string; projectKey: string }>;
}) {
  const { orgSlug, projectKey } = await params;
  const context = await requirePageContext(orgSlug);
  const project = await requirePageProject(context, projectKey);
  if (!can(context, "run:upload")) {
    return (
      <PermissionDenied
        action="Uploading results"
        requires="member"
        role={context.org.role}
        orgName={context.org.name}
        backHref={`/o/${orgSlug}/p/${projectKey}`}
      />
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-6">
      <header className="mb-5">
        <h1 className="text-lg font-semibold tracking-tight">Upload to {project.name}</h1>
        <p className="mt-1 text-xs leading-relaxed text-[var(--color-ink-muted)]">
          JUnit / xUnit XML from pytest, Playwright, Surefire, Gradle, jest-junit, Cypress, Robot or
          TestNG. Parsing runs in the background and you will be taken to the run as it lands.
        </p>
      </header>

      <UploadForm
        projects={[{ key: project.key, name: project.name }]}
        orgSlug={orgSlug}
        defaultBranch={project.defaultBranch}
      />

      <Card className="mt-6">
        <CardHeader title="From CI instead" />
        <div className="px-5 py-4">
          <CiSnippet projectKey={project.key} token={null} />
        </div>
      </Card>
    </main>
  );
}
