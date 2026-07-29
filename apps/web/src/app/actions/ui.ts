"use server";

import { cookies } from "next/headers";
import { SIDEBAR_COOKIE, type SidebarState } from "@/lib/sidebar";

/**
 * Sidebar state lives in a cookie, not in client state.
 *
 * The layout reads it during the server render, so a collapsed sidebar is already
 * collapsed in the first painted frame. Holding it only in React state would show the
 * expanded sidebar for a moment on every navigation and then snap shut — the kind of
 * flicker that makes an app feel unfinished.
 */
export async function setSidebarState(state: SidebarState): Promise<void> {
  const store = await cookies();
  store.set(SIDEBAR_COOKIE, state, {
    httpOnly: false,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}
