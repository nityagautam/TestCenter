/**
 * The project the user last selected, remembered across navigation.
 *
 * The selected project used to be derived purely from the URL path, which meant it was
 * only true on pages that carry it. Open a test from a project's list and the URL becomes
 * `/o/:org/tests/:id` — no project in the path — so the header dropdown snapped back to
 * "All projects" and the project's nav section vanished, even though the test being
 * displayed belongs to that project. Same for a run. Nothing had changed except that the
 * next page's URL happened not to mention where you were.
 *
 * So selection is a preference, and preferences persist: it is stored in a cookie, read by
 * the layout during the server render, and only cleared when the user actually chooses
 * "All projects". The path still wins when it has an opinion — visiting a project URL
 * directly selects that project — so a shared link is never overridden by whatever the
 * recipient last looked at.
 *
 * A plain module rather than the "use server" file, because a server-action file may only
 * export async functions; a constant beside the action breaks the build at request time,
 * past both tsc and eslint.
 */
export const PROJECT_SCOPE_COOKIE = "tc_project";

/**
 * The value is `orgSlug:projectKey`.
 *
 * Qualified by organisation because a bare key would leak across them: two organisations
 * can each have a `web` project, and selecting one would silently select the other's on
 * switching. An org that does not match is treated as no selection at all.
 */
export function encodeProjectScope(orgSlug: string, projectKey: string): string {
  return `${orgSlug}:${projectKey}`;
}

export function readProjectScope(value: string | undefined, orgSlug: string): string | null {
  if (!value) return null;
  const separator = value.indexOf(":");
  if (separator <= 0) return null;
  const org = value.slice(0, separator);
  const key = value.slice(separator + 1);
  if (org !== orgSlug || !key) return null;
  return key;
}
