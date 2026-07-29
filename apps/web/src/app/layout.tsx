import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Test Center",
  description: "Test intelligence for every framework — ingest, triage, and trend test results.",
};

/**
 * Deliberately minimal: navigation belongs to the org-scoped layout, because sign-in,
 * onboarding and the no-access page have no organisation to navigate within and
 * showing them a project switcher would be nonsense.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
