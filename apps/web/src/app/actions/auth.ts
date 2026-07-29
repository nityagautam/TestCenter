"use server";

import { signOut } from "@/auth";

/**
 * Extracted so the app shell can be a client component while still submitting to a
 * server action. Sign-out must run on the server to clear the session cookie.
 */
export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/signin" });
}
