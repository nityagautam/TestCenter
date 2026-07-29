/**
 * Reading and rewriting the scope carried in the URL.
 *
 * Scope lives in the path — `/o/:org` and `/o/:org/p/:project` — so every view is
 * shareable and the back button behaves. The cost is that the shell has to *parse* the
 * path to know what is selected, and a parser that quietly returns the wrong answer
 * produces a UI that ignores the user: choosing a project and then finding yourself
 * looking at the whole organisation. That happened, which is why these live in a plain
 * module with tests rather than inline in the client component.
 */

/** `/o/acme/p/checkout-web/runs` → `checkout-web` */
export function projectKeyFromPath(pathname: string, orgSlug: string): string | null {
  const prefix = `/o/${orgSlug}/p/`;
  if (!pathname.startsWith(prefix)) return null;
  return pathname.slice(prefix.length).split("/")[0] || null;
}

/**
 * Sections that exist at both organisation and project scope.
 *
 * Only these can survive a scope change. `settings` means something different at each
 * level, and `upload` has no organisation-wide equivalent at all, so carrying either
 * across would land on a page that does not exist or does not mean the same thing.
 */
const SHARED_SECTIONS = new Set(["runs", "tests", "flaky"]);

/**
 * The section of the current path, when it is one both scopes have.
 *
 * This is what lets the switcher preserve where you are. Picking a project while reading
 * the test list should take you to *that project's* test list; jumping to the project
 * overview instead discards the reason the dropdown was opened and makes the user
 * navigate back to where they already were.
 */
export function sharedSectionFromPath(pathname: string, orgSlug: string): string | null {
  const projectKey = projectKeyFromPath(pathname, orgSlug);
  const prefix = projectKey ? `/o/${orgSlug}/p/${projectKey}/` : `/o/${orgSlug}/`;
  if (!pathname.startsWith(prefix)) return null;
  const section = pathname.slice(prefix.length).split("/")[0] ?? "";
  return SHARED_SECTIONS.has(section) ? section : null;
}

/** Where the project switcher's rows lead, keeping the current section where possible. */
export function projectScopeHref(pathname: string, orgSlug: string, projectKey: string): string {
  const section = sharedSectionFromPath(pathname, orgSlug);
  return section ? `/o/${orgSlug}/p/${projectKey}/${section}` : `/o/${orgSlug}/p/${projectKey}`;
}

/** Where "All projects" leads: the same section, widened to the organisation. */
export function orgScopeHref(pathname: string, orgSlug: string): string {
  const section = sharedSectionFromPath(pathname, orgSlug);
  return section ? `/o/${orgSlug}/${section}` : `/o/${orgSlug}`;
}
