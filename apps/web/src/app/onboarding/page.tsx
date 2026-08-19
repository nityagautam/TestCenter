import { redirect } from "next/navigation";
import Link from "next/link";
import { completeOnboarding } from "@testcenter/db";
import { Card } from "@/components/ui";
import { OrganizationCreationForm } from "@/features/organization-creation-form";
import { getServices } from "@/lib/services";
import { currentOrgs, requireViewer, resolveLandingPath } from "@/lib/viewer";

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

  // Once an org exists, onboarding has done its job. Returning users with no org may revisit
  // this route from `/no-access` to use the creation path they previously skipped.
  if (orgs.length > 0) redirect(await resolveLandingPath());

  const suggestedName = viewer.name
    ? `${viewer.name.split(" ")[0]}'s Organisation`
    : "My Organisation";

  return (
    <main className="mx-auto max-w-lg px-6 py-14">
      <header className="mb-8">
        <h1 className="text-xl font-semibold tracking-tight">
          {viewer.onboarded ? "Create an organisation" : "Welcome to Test Center"}
        </h1>
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

        <OrganizationCreationForm personal defaultName={suggestedName} />
      </Card>

      {viewer.onboarded ? (
        <p className="mt-6 text-xs text-[var(--color-ink-muted)]">
          <Link href="/no-access" className="underline hover:text-[var(--color-ink)]">
            Back to access instructions
          </Link>
        </p>
      ) : (
        <div className="mt-6 rounded-xl border border-[var(--color-border-subtle)] px-5 py-4">
          <h2 className="text-sm font-medium">Joining a team instead?</h2>
          <p className="mt-1 text-xs leading-relaxed text-[var(--color-ink-muted)]">
            An administrator can grant your account access to an existing organisation. Skip this
            step and you will see a page explaining what to ask for.
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
      )}
    </main>
  );
}
