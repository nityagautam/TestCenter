"use server";

import { cookies } from "next/headers";
import { SIDEBAR_COOKIE, type SidebarState } from "@/lib/sidebar";
import { THEME_COOKIE, type ThemePreference } from "@/lib/theme";

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

/**
 * Stored server-side for the same reason as the sidebar: the root layout reads it during
 * render and stamps <html data-theme>, so the correct theme is present in the first
 * painted frame. A client-only toggle would paint the wrong theme and then correct
 * itself — the flash of light that makes dark-mode users wince.
 */
export async function setThemePreference(preference: ThemePreference): Promise<void> {
  const store = await cookies();
  store.set(THEME_COOKIE, preference, {
    httpOnly: false,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}
