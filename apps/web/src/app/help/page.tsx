import type { Metadata } from "next";
import { cookies } from "next/headers";
import { RUN_VERDICTS, type RunVerdict } from "@testcenter/core";
import { Help } from "@/features/help";
import { readThemePreference, THEME_COOKIE } from "@/lib/theme";
import { resolveLandingPath } from "@/lib/viewer";

/**
 * `/help` — deliberately outside `/o/[orgSlug]`, and deliberately unauthenticated.
 *
 * Two reasons it does not live under the org layout. First, that layout is the
 * authorisation gate: everything beneath it passes through `requirePageContext`, which is
 * exactly right for pages about an organisation's data and exactly wrong for the page you
 * put in an invitation mail. Second, the page has no organisation — it explains the
 * product, not a tenant — so the shell's project switcher and failing-test counts would
 * have nothing to show.
 *
 * Nothing here reads tenant data. The one database touch is resolving where the "back to
 * the app" link should point, and that is wrapped: help must still render when the thing
 * the reader is trying to understand is an outage.
 */
export const metadata: Metadata = {
  title: "Help",
  description:
    "How Test Center works, in five acts — a run arrives, something is red, is it always red, how are we doing, and who can do what.",
};

export const dynamic = "force-dynamic";

export default async function HelpPage({
  searchParams,
}: {
  searchParams: Promise<{ verdict?: string; search?: string }>;
}) {
  const store = await cookies();
  const theme = readThemePreference(store.get(THEME_COOKIE)?.value);
  const query = await searchParams;
  const sampleVerdict: "all" | "todo" | RunVerdict =
    query.verdict === "all" ||
    query.verdict === "todo" ||
    RUN_VERDICTS.includes(query.verdict as RunVerdict)
      ? (query.verdict as "all" | "todo" | RunVerdict)
      : "todo";

  /*
   * Signed in, so the link says "open the app" and goes where they belong; signed out, so
   * it offers sign-in. Getting this wrong in either direction is a dead end for exactly the
   * reader this page exists for.
   */
  let landing = "/signin";
  try {
    landing = await resolveLandingPath();
  } catch {
    // Session or database unavailable. Sign-in is the safe destination — it is the one
    // page that works for both states — and the guide itself is unaffected.
  }
  const signedOut = landing === "/signin";

  return (
    <>
      {/* The root layout carries no shell, so the skip link belongs to the page. */}
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-[var(--color-ink)] focus:px-3 focus:py-2 focus:text-xs focus:font-medium focus:text-[var(--color-surface)]"
      >
        Skip to content
      </a>
      <Help
        appHref={landing}
        appLabel={signedOut ? "Sign in" : "Open Test Center"}
        theme={theme}
        sampleVerdict={sampleVerdict}
        sampleSearch={query.search ?? ""}
      />
    </>
  );
}
