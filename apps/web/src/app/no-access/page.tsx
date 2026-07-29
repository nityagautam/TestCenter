import { redirect } from "next/navigation";
import Link from "next/link";
import { createOrganization } from "@testcenter/db";
import { Card } from "@/components/ui";
import { getServices } from "@/lib/services";
import { currentOrgs, requireViewer } from "@/lib/viewer";

/**
 * The "you are signed in but cannot see anything yet" state.
 *
 * This exists because it is the single most likely place a real new user lands, and
 * the wrong version of this page is an empty dashboard that looks broken. It tells
 * them exactly what to ask for — their own email address, which is what an admin
 * needs to grant access — and offers the self-serve escape hatch.
 */
export const dynamic = "force-dynamic";

export default async function NoAccessPage() {
  const viewer = await requireViewer();
  const orgs = await currentOrgs();

  // Access arrived while they were sitting here.
  if (orgs.length > 0 && orgs[0]) redirect(`/o/${orgs[0].slug}`);

  return (
    <main className="mx-auto max-w-lg px-6 py-14">
      <header className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight">No organisations yet</h1>
        <p className="mt-2 text-xs leading-relaxed text-[var(--color-ink-muted)]">
          You are signed in as <span className="font-mono">{viewer.email}</span>, but your account
          does not have access to any organisation.
        </p>
      </header>

      <Card className="p-5">
        <h2 className="text-sm font-medium">Ask an administrator for access</h2>
        <p className="mt-1 text-xs leading-relaxed text-[var(--color-ink-muted)]">
          Send them this address and they can grant it from Settings → Members. Access takes effect
          immediately — just reload this page.
        </p>
        <div className="mt-3 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-2 font-mono text-xs">
          {viewer.email}
        </div>
        <Link
          href="/no-access"
          className="mt-3 inline-block text-xs text-[var(--color-ink-muted)] underline hover:text-[var(--color-ink)]"
        >
          Check again
        </Link>
      </Card>

      <div className="mt-6 rounded-xl border border-[var(--color-border-subtle)] px-5 py-4">
        <h2 className="text-sm font-medium">Or create your own</h2>
        <p className="mt-1 mb-3 text-xs leading-relaxed text-[var(--color-ink-muted)]">
          Useful for trying the product out with your own test results.
        </p>
        <form
          action={async (formData: FormData) => {
            "use server";
            const name = String(formData.get("name") ?? "").trim();
            if (!name) return;
            const { db } = getServices();
            const { requireViewer: resolve } = await import("@/lib/viewer");
            const created = await createOrganization(db, {
              name,
              createdBy: await resolve(),
              personal: true,
            });
            redirect(`/o/${created.slug}`);
          }}
          className="flex gap-2"
        >
          <input
            name="name"
            required
            placeholder="My Organisation"
            maxLength={120}
            className="flex-1 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-xs outline-none focus:border-[var(--color-ink-muted)]"
          />
          <button
            type="submit"
            className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs font-medium hover:border-[var(--color-ink-muted)]"
          >
            Create
          </button>
        </form>
      </div>

      {viewer.isPlatformAdmin ? (
        <p className="mt-6 text-xs text-[var(--color-ink-muted)]">
          You are a platform administrator, so every organisation should be visible. Seeing this
          page means none exist yet.
        </p>
      ) : null}
    </main>
  );
}
