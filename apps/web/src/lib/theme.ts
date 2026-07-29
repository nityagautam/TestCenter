/**
 * Theme preference, shared between the server layout and the client toggle.
 *
 * A plain module rather than the "use server" file: server-action files may only export
 * async functions, so a constant beside the action breaks the build at request time —
 * past both tsc and eslint. Learned once already.
 */
export const THEME_COOKIE = "tc_theme";

/**
 * "system" is a real choice, not the absence of one. Someone who deliberately follows
 * their OS wants that to keep working when they change it, which a stored light/dark
 * value would silently override.
 */
export type ThemePreference = "system" | "light" | "dark";

export function readThemePreference(value: string | undefined): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

/**
 * The attribute written on <html>. `system` writes nothing so the CSS media query
 * governs — see globals.css, where the dark block is scoped
 * `:not([data-theme="light"])` precisely so an explicit light choice can beat OS dark.
 */
export function themeAttribute(preference: ThemePreference): "light" | "dark" | undefined {
  return preference === "system" ? undefined : preference;
}
