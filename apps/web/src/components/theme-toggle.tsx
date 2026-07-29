"use client";

import { useState, useTransition } from "react";
import { setThemePreference } from "@/app/actions/ui";
import type { ThemePreference } from "@/lib/theme";

/**
 * Theme toggle: system → light → dark → system.
 *
 * A three-state cycle rather than a two-state switch, because "follow my system" is a
 * real preference and not the absence of one. Someone who chooses it wants their theme
 * to keep tracking the OS when it changes at sunset; collapsing that into a stored
 * light/dark value silently takes it away.
 *
 * The attribute is applied optimistically to <html> so the change is instant, and
 * persisted server-side so the next page render already agrees. Without the local write
 * the theme would only change after the server round trip, which feels broken for
 * something this immediate.
 */
const ORDER: ThemePreference[] = ["system", "light", "dark"];

const LABEL: Record<ThemePreference, string> = {
  system: "Theme: following system",
  light: "Theme: light",
  dark: "Theme: dark",
};

export function ThemeToggle({ initial }: { initial: ThemePreference }) {
  const [preference, setPreference] = useState<ThemePreference>(initial);
  const [, startTransition] = useTransition();

  function cycle(): void {
    const next = ORDER[(ORDER.indexOf(preference) + 1) % ORDER.length] as ThemePreference;
    setPreference(next);

    // Mirror what the server render would produce, so the change lands immediately.
    const root = document.documentElement;
    if (next === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", next);

    startTransition(() => void setThemePreference(next));
  }

  return (
    <button
      type="button"
      onClick={cycle}
      title={`${LABEL[preference]} — click to change`}
      // The icon alone cannot say which of three states is active, and the state is the
      // information. aria-live announces the change to a screen reader on press.
      aria-label={`${LABEL[preference]}. Change theme.`}
      className="rounded-md p-1.5 text-[var(--color-ink-muted)] transition-colors hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-ink)]"
    >
      <span aria-live="polite" className="sr-only">
        {LABEL[preference]}
      </span>
      {preference === "system" ? (
        <SystemIcon />
      ) : preference === "light" ? (
        <SunIcon />
      ) : (
        <MoonIcon />
      )}
    </button>
  );
}

function SystemIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="2" y="3" width="12" height="8.5" rx="1.5" />
      <path d="M5.5 14h5" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      aria-hidden
    >
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.5v1.5M8 13v1.5M1.5 8h1.5M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M12.6 3.4l-1 1M4.4 11.6l-1 1" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M13 9.8A5.6 5.6 0 0 1 6.2 3a5.6 5.6 0 1 0 6.8 6.8Z" />
    </svg>
  );
}
