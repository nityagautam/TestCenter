import { redirect } from "next/navigation";
import { createOrganization } from "@testcenter/db";
import { setOrgScope } from "@/app/actions/ui";
import { getServices } from "@/lib/services";
import { requireViewer } from "@/lib/viewer";

/**
 * The one organisation-creation form used by onboarding and the authenticated create page.
 *
 * The route decides whether this is the viewer's initial personal space or an additional team
 * organisation. Keeping the mutation here prevents the two entry points from drifting on name
 * limits, ownership, remembered scope, or their post-create destination.
 */
export function OrganizationCreationForm({
  defaultName,
  personal,
  submitLabel = "Create organisation",
}: {
  defaultName?: string;
  personal: boolean;
  submitLabel?: string;
}) {
  return (
    <form
      action={async (formData: FormData) => {
        "use server";
        const name = String(formData.get("name") ?? "").trim();
        if (!name) return;

        const { db } = getServices();
        const created = await createOrganization(db, {
          name,
          createdBy: await requireViewer(),
          personal,
        });
        // The redirect reaches the new org before AppShell can persist it client-side. Write
        // now so `/help` and `/` already know the new selection on their first request.
        await setOrgScope(created.slug);
        redirect(`/o/${created.slug}`);
      }}
      className="space-y-3"
    >
      <div>
        <label
          htmlFor="organization-name"
          className="mb-1 block text-xs font-medium text-[var(--color-ink-muted)]"
        >
          Organisation name
        </label>
        <input
          id="organization-name"
          name="name"
          required
          defaultValue={defaultName}
          placeholder="Quality Engineering"
          maxLength={120}
          autoComplete="organization"
          className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-2 text-xs outline-none focus:border-[var(--color-ink-muted)]"
        />
      </div>
      <button
        type="submit"
        className="w-full rounded-md bg-[var(--color-ink)] px-4 py-2 text-sm font-medium text-[var(--color-surface)] transition-opacity hover:opacity-90"
      >
        {submitLabel}
      </button>
    </form>
  );
}
