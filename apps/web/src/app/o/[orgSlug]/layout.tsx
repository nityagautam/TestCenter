import { OrgAppShell } from "@/features/org-app-shell";

/**
 * Every org-scoped page renders inside this layout, which means every one of them passes
 * through `requirePageContext` — the authorisation gate — before anything is rendered.
 * Putting the check here rather than in each page makes it impossible to add a new page
 * that forgets it.
 */
export default async function OrgLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  return <OrgAppShell orgSlug={orgSlug}>{children}</OrgAppShell>;
}
