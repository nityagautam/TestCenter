import { redirect } from "next/navigation";
import { completeOnboarding, createOrganization } from "@testcenter/db";
import { Card } from "@/components/ui";
import { getServices } from "@/lib/services";
import { currentOrgs, requireViewer } from "@/lib/viewer";

/**
 * First-run onboarding.
 *
 * A brand-new user has no organisation, so there is nothing to show them. They get
 * an explicit choice: create their own space, or wait for an administrator to grant
 * access to an existing one. Skipping is a legitimate outcome, not an error — it
 * leads to a page that explains the situation rather than an empty dashboard.
 */
export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const viewer = await requireViewer();
  const orgs = await currentOrgs();

  // Already sorted out — either onboarded or granted access in the meantime.
  if (viewer.onboarded && orgs.length > 0 && orgs[0]) redirect(`/o/${orgs[0].slug}`);
  if (viewer.onboarded && orgs.length === 0) redirect("/no-access");

  const suggestedName = viewer.name
    ? `${viewer.name.split(" ")[0]}'s Organisation`
    : "My Organisation";

  return (
    <main className="mx-auto max-w-lg px-6 py-14">
      <header className="mb-8">
        <h1 className="text-xl font-semibold tracking-tight">Welcome to Test Center</h1>
        <p className="mt-2 text-xs leading-relaxed text-[var(--color-ink-muted)]">
          Signed in as <span className="font-mono">{viewer.email}</span>. Test results live inside
          an organisation, so you need one before you can upload anything.
        </p>
      </header>

      <Card className="p-5">
        <h2 className="text-sm font-medium">Create your own organisation</h2>
        <p className="mt-1 mb-4 text-xs leading-relaxed text-[var(--color-ink-muted)]">
          You will be its owner and can create projects, upload results and invite others. You can
          rename it or create more later.
        </p>

        <form
          action={async (formData: FormData) => {
            "use server";
            const name = String(formData.get("name") ?? "").trim();
            if (!name) return;

            const { db } = getServices();
            const { requireViewer: resolve } = await import("@/lib/viewer");
            const current = await resolve();
            const created = await createOrganization(db, {
              name,
              createdBy: current,
              // Flagged personal so the UI can distinguish "my space" from a team org.
              personal: true,
            });
            redirect(`/o/${created.slug}`);
          }}
          className="space-y-3"
        >
          <div>
            <label
              htmlFor="name"
              className="mb-1 block text-xs font-medium text-[var(--color-ink-muted)]"
            >
              Organisation name
            </label>
            <input
              id="name"
              name="name"
              required
              defaultValue={suggestedName}
              maxLength={120}
              className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-2 text-xs outline-none focus:border-[var(--color-ink-muted)]"
            />
          </div>
          <button
            type="submit"
            className="w-full rounded-md bg-[var(--color-ink)] px-4 py-2 text-sm font-medium text-[var(--color-surface)] transition-opacity hover:opacity-90"
          >
            Create organisation
          </button>
        </form>
      </Card>

      <div className="mt-6 rounded-xl border border-[var(--color-border-subtle)] px-5 py-4">
        <h2 className="text-sm font-medium">Joining a team instead?</h2>
        <p className="mt-1 text-xs leading-relaxed text-[var(--color-ink-muted)]">
          An administrator can grant your account access to an existing organisation. Skip this step
          and you will see a page explaining what to ask for.
        </p>
        <form
          action={async () => {
            "use server";
            const { db } = getServices();
            const { requireViewer: resolve } = await import("@/lib/viewer");
            await completeOnboarding(db, await resolve());
            redirect("/no-access");
          }}
        >
          <button
            type="submit"
            className="mt-3 text-xs text-[var(--color-ink-muted)] underline hover:text-[var(--color-ink)]"
          >
            Skip for now
          </button>
        </form>
      </div>
    </main>
  );
}
