import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { readThemePreference, THEME_COOKIE, themeAttribute } from "@/lib/theme";
import "./globals.css";

export const metadata: Metadata = {
  /*
   * `%s · Test Center` on child pages, so a tab full of them stays distinguishable.
   *
   * A dashboard is a thing people keep open in several tabs at once — one per project, or a
   * run beside the test it came from — and every tab reading "Test Center" makes that
   * impossible to navigate. `default` covers pages that set no title of their own.
   */
  title: { default: "Test Center", template: "%s · Test Center" },
  description: "Test intelligence for every framework — ingest, triage, and trend test results.",
  icons: { icon: "/icon.svg" },
};

/**
 * Matches the header's chrome indigo, so mobile browser UI continues the header rather than
 * cutting it off with a strip of its own colour.
 */
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#232a52" },
    { media: "(prefers-color-scheme: dark)", color: "#2b3252" },
  ],
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
