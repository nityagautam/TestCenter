"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { PROJECT_SCOPE_COOKIE, encodeProjectScope } from "@/lib/project-scope";
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

/**
 * Remembers the selected project, or forgets it when passed null.
 *
 * Read by the org layout during the server render, so a page whose URL does not mention a
 * project still renders with that project selected in the first painted frame — no flash of
 * "All projects" before the client corrects itself.
 *
 * Shorter-lived than the sidebar and theme cookies. Those are settings; this is closer to
 * "where was I", and a project selected a month ago is more likely to mislead than to help.
 */
/**
 * Forgets the selected project and navigates, in one server round trip.
 *
 * A plain link plus a fire-and-forget cookie delete would race: the destination's server
 * render can read the cookie before the delete lands, so choosing "All projects" would
 * arrive on an organisation-wide page still showing the project selected — the precise
 * confusion this is meant to remove. Doing both here makes the order guaranteed.
 */
export async function clearProjectScope(orgSlug: string, destination: string): Promise<void> {
  const store = await cookies();
  store.delete(PROJECT_SCOPE_COOKIE);
  // The destination arrives from the client, so it is confined to an in-app org path
  // rather than trusted — an action that redirects anywhere it is told is an open redirect.
  const safe = destination.startsWith(`/o/${orgSlug}`) ? destination : `/o/${orgSlug}`;
  redirect(safe);
}

export async function setProjectScope(orgSlug: string, projectKey: string | null): Promise<void> {
  const store = await cookies();
  if (projectKey === null) {
    store.delete(PROJECT_SCOPE_COOKIE);
    return;
  }
  store.set(PROJECT_SCOPE_COOKIE, encodeProjectScope(orgSlug, projectKey), {
    httpOnly: false,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}
