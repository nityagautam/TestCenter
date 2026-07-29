/**
 * Sidebar state shared between the server layout and the client shell.
 *
 * Deliberately a plain module, not the "use server" file: a server-action file may only
 * export async functions, so a constant living beside the action breaks the build — and
 * it breaks it at request time, past both tsc and eslint.
 */
export const SIDEBAR_COOKIE = "tc_sidebar";

export type SidebarState = "expanded" | "collapsed";

export function readSidebarState(value: string | undefined): SidebarState {
  return value === "collapsed" ? "collapsed" : "expanded";
}
