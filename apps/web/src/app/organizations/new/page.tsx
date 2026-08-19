import type { Metadata } from "next";
import Link from "next/link";
import { Card } from "@/components/ui";
import { OrganizationCreationForm } from "@/features/organization-creation-form";
import { requireViewer, resolveLandingPath } from "@/lib/viewer";

export const metadata: Metadata = { title: "New organisation" };
export const dynamic = "force-dynamic";

export default async function NewOrganizationPage() {
  const viewer = await requireViewer();
  const backHref = await resolveLandingPath();

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Create an organisation</h1>
          <p className="mt-0.5 text-xs text-[var(--color-ink-muted)]">
            Add a separate team space. You will be its owner.
          </p>
        </div>
        <Link href={backHref} className="text-xs underline">
          Cancel
        </Link>
      </div>

      <Card className="p-5">
        <h2 className="text-sm font-medium">Organisation details</h2>
        <p className="mt-1 mb-4 text-xs leading-relaxed text-[var(--color-ink-muted)]">
          Projects, members, API tokens and test history stay isolated inside this organisation. The
          name can be changed later; Test Center generates a unique URL slug automatically.
        </p>
        <OrganizationCreationForm
          personal={false}
          defaultName={viewer.name ? `${viewer.name.split(" ")[0]}'s Team` : undefined}
        />
      </Card>

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        {[
          ["1", "Create projects", "Each project gets its own runs, settings and CI tokens."],
          ["2", "Invite the team", "Owners and admins grant role-based access after creation."],
          [
            "3",
            "Publish from CI",
            "Upload JUnit or xUnit reports without changing the test runner.",
          ],
        ].map(([number, title, detail]) => (
          <div
            key={number}
            className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3"
          >
            <span className="font-mono text-[10px] text-[var(--color-ink-muted)]">{number}</span>
            <h2 className="mt-1 text-xs font-medium">{title}</h2>
            <p className="mt-1 text-[11px] leading-relaxed text-[var(--color-ink-muted)]">
              {detail}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
