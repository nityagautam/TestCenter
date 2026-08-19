import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { schema } from "@testcenter/db";
import { PermissionDenied } from "@/components/permission-denied";
import { Card } from "@/components/ui";
import { getServices } from "@/lib/services";
import { can, requirePageContext } from "@/lib/viewer";

/**
 * Organisation identity settings.
 *
 * Only the display name is editable. The slug is embedded in every shared URL and CI-facing
 * route; changing it would break links with no redirect target and make the failure look like an
 * access problem. A rename must change what people read without changing what integrations use.
 */
export const dynamic = "force-dynamic";

export default async function OrganizationSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { orgSlug } = await params;
  const { ok, error } = await searchParams;
  const context = await requirePageContext(orgSlug);

  if (!can(context, "org:edit")) {
    return (
      <PermissionDenied
        action="Editing organisation settings"
        requires="admin"
        role={context.org.role}
        orgName={context.org.name}
        backHref={`/o/${orgSlug}`}
      />
    );
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-6">
      <h1 className="text-lg font-semibold tracking-tight">Organisation settings</h1>
      <p className="mt-0.5 mb-5 text-xs text-[var(--color-ink-muted)]">
        Change how this organisation is named throughout Test Center.
      </p>

      {ok ? (
        <p className="mb-4 rounded-md border border-[var(--color-status-passed)]/40 bg-[var(--color-status-passed)]/5 px-3 py-2 text-xs text-[var(--color-status-passed)]">
          {ok}
        </p>
      ) : null}
      {error ? (
        <p className="mb-4 rounded-md border border-[var(--color-status-failed)]/40 bg-[var(--color-status-failed)]/5 px-3 py-2 text-xs text-[var(--color-status-failed)]">
          {error}
        </p>
      ) : null}

      <Card className="p-5">
        <h2 className="text-sm font-medium">Identity</h2>
        <p className="mt-1 mb-4 text-xs leading-relaxed text-[var(--color-ink-muted)]">
          The name appears in the header, scope switcher and reports. The URL slug stays fixed so
          existing links and CI configuration continue to work.
        </p>

        <form
          action={async (formData: FormData) => {
            "use server";
            const { requirePageContext: resolve, can: allows } = await import("@/lib/viewer");
            const current = await resolve(orgSlug);
            if (!allows(current, "org:edit")) {
              redirect(`/o/${orgSlug}/settings?error=Not+permitted`);
            }

            const name = String(formData.get("name") ?? "").trim();
            if (!name) {
              redirect(`/o/${orgSlug}/settings?error=Organisation+name+is+required`);
            }

            const { db } = getServices();
            await db
              .update(schema.organizations)
              .set({ name: name.slice(0, 120) })
              .where(eq(schema.organizations.id, current.org.id));

            // The org name is part of every shell instance and the platform-wide list.
            revalidatePath(`/o/${orgSlug}`, "layout");
            revalidatePath("/admin");
            redirect(`/o/${orgSlug}/settings?ok=Organisation+name+updated`);
          }}
          className="space-y-4"
        >
          <label className="block">
            <span className="mb-1 block text-xs font-medium">Name</span>
            <input
              name="name"
              required
              defaultValue={context.org.name}
              maxLength={120}
              autoComplete="organization"
              className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-2 text-xs outline-none focus:border-[var(--color-ink-muted)]"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium">
              URL slug
              <span className="ml-1.5 font-normal text-[var(--color-ink-muted)]">
                (not editable — shared links use this)
              </span>
            </span>
            <input
              value={context.org.slug}
              readOnly
              disabled
              className="w-full cursor-not-allowed rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-2 font-mono text-xs opacity-60"
            />
          </label>

          <button
            type="submit"
            className="rounded-md bg-[var(--color-ink)] px-4 py-2 text-sm font-medium text-[var(--color-surface)] hover:opacity-90"
          >
            Save changes
          </button>
        </form>
      </Card>
    </main>
  );
}
