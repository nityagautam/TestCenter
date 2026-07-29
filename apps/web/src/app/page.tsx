import { redirect } from "next/navigation";
import { resolveLandingPath } from "@/lib/viewer";

/**
 * The root is a router, not a page.
 *
 * Four distinct states each have a different correct destination — signed out,
 * mid-onboarding, signed in with no access, and signed in with organisations.
 * Conflating them is how users end up staring at an empty screen wondering whether
 * the product is broken or they simply have nothing yet.
 */
export const dynamic = "force-dynamic";

export default async function RootPage() {
  redirect(await resolveLandingPath());
}
