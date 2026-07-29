import Link from "next/link";
import { Card } from "@/components/ui";

/**
 * Shown instead of throwing when a role lacks a capability.
 *
 * A raw thrown error would surface as a 500, which reads as "the product is broken"
 * rather than "you are not allowed to do this" — and the second is both true and
 * actionable. It names the required role so the reader knows exactly what to ask for.
 */
export function PermissionDenied({
  action,
  requires,
  role,
  orgName,
  backHref,
}: {
  action: string;
  requires: string;
  role: string;
  orgName: string;
  backHref: string;
}) {
  return (
    <main className="mx-auto max-w-lg px-6 py-14">
      <Card className="p-6 text-center">
        <h1 className="text-sm font-semibold">Not permitted</h1>
        <p className="mt-2 text-xs leading-relaxed text-[var(--color-ink-muted)]">
          {action} requires the <span className="font-medium">{requires}</span> role in {orgName}.
          Your role is <span className="font-medium">{role}</span>.
        </p>
        <p className="mt-2 text-xs leading-relaxed text-[var(--color-ink-muted)]">
          An administrator can change this under Settings → Members.
        </p>
        <Link href={backHref} className="mt-4 inline-block text-xs underline">
          Go back
        </Link>
      </Card>
    </main>
  );
}
