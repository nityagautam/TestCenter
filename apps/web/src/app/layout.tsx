import type { Metadata } from "next";
import { cookies } from "next/headers";
import { readThemePreference, THEME_COOKIE, themeAttribute } from "@/lib/theme";
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
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const store = await cookies();
  const preference = readThemePreference(store.get(THEME_COOKIE)?.value);
  const attribute = themeAttribute(preference);

  return (
    // data-theme is stamped during the server render so the chosen theme is correct in
    // the first painted frame rather than corrected after hydration.
    <html lang="en" {...(attribute ? { "data-theme": attribute } : {})}>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
