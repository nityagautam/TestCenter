import { redirect } from "next/navigation";
import { createProject, generateApiToken, requireCapability, schema } from "@testcenter/db";
import { PermissionDenied } from "@/components/permission-denied";
import { Card } from "@/components/ui";
import { getServices } from "@/lib/services";
import { can, requirePageContext } from "@/lib/viewer";

/**
 * Create a project.
 *
 * Mints an API token in the same action and lands on the project's onboarding view
 * with the token visible once. That sequencing is deliberate: the moment right after
 * creating a project is when someone will actually wire up CI, and making them hunt
 * for a token in a settings screen is where adoption quietly dies.
 */
export const dynamic = "force-dynamic";

export default async function NewProjectPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const context = await requirePageContext(orgSlug);
  // Checked here as well as by hiding the nav link: the UI hiding a control is a
  // convenience, the server decision is the enforcement.
  if (!can(context, "project:create")) {
    return (
      <PermissionDenied
        action="Creating a project"
        requires="maintainer"
        role={context.org.role}
        orgName={context.org.name}
        backHref={`/o/${orgSlug}/projects`}
      />
    );
  }

  return (
    <main className="mx-auto max-w-lg px-6 py-8">
      <h1 className="text-lg font-semibold tracking-tight">New project</h1>
      <p className="mt-1 mb-5 text-xs leading-relaxed text-[var(--color-ink-muted)]">
        In {context.org.name}. The key is what CI sends, so keep it short and stable — renaming it
        later means updating every pipeline.
      </p>

      <Card className="p-5">
        <form
          action={async (formData: FormData) => {
            "use server";
            const name = String(formData.get("name") ?? "").trim();
            const rawKey = String(formData.get("key") ?? "").trim();
            if (!name) return;

            const { db } = getServices();
            const { requirePageContext: resolve } = await import("@/lib/viewer");
            const current = await resolve(orgSlug);
            requireCapability(current, "project:create");

            const created = await createProject(db, {
              context: current,
              key: rawKey || name,
              name,
              description: String(formData.get("description") ?? "") || undefined,
              defaultBranch: String(formData.get("defaultBranch") ?? "") || undefined,
            });

            // One token, shown once, so the CI snippet on the next screen is copyable.
            const token = generateApiToken();
            await db.insert(schema.apiTokens).values({
              orgId: current.org.id,
              projectId: created.projectId,
              name: "ci",
              tokenHash: token.hash,
              tokenPrefix: token.prefix,
              scopes: ["runs:write", "runs:read"],
              createdBy: current.viewer.userId,
            });

            redirect(
              `/o/${orgSlug}/p/${created.key}?created=1&token=${encodeURIComponent(token.plaintext)}`,
            );
          }}
          className="space-y-4"
        >
          <Field label="Name" hint="shown in the UI">
            <input
              name="name"
              required
              maxLength={120}
              placeholder="Checkout Web"
              className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-2 text-xs outline-none focus:border-[var(--color-ink-muted)]"
            />
          </Field>
          <Field label="Key" hint="optional — derived from the name if blank">
            <input
              name="key"
              maxLength={128}
              placeholder="checkout-web"
              className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-2 font-mono text-xs outline-none focus:border-[var(--color-ink-muted)]"
            />
          </Field>
          <Field label="Default branch">
            <input
              name="defaultBranch"
              defaultValue="main"
              maxLength={255}
              className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-2 font-mono text-xs outline-none focus:border-[var(--color-ink-muted)]"
            />
          </Field>
          <Field label="Description" hint="optional">
            <textarea
              name="description"
              rows={2}
              maxLength={500}
              className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-2 text-xs outline-none focus:border-[var(--color-ink-muted)]"
            />
          </Field>
          <button
            type="submit"
            className="w-full rounded-md bg-[var(--color-ink)] px-4 py-2 text-sm font-medium text-[var(--color-surface)] hover:opacity-90"
          >
            Create project
          </button>
        </form>
      </Card>
    </main>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium">
        {label}
        {hint ? (
          <span className="ml-1.5 font-normal text-[var(--color-ink-muted)]">({hint})</span>
        ) : null}
      </span>
      {children}
    </label>
  );
}
