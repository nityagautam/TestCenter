"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Command palette (⌘K / Ctrl-K).
 *
 * For a tool with four projects and a hundred and fifty test identities, typing a
 * fragment beats navigating a tree. This is the primary way to move around once you know
 * what you are looking for, so it searches the things you actually name — organisations,
 * projects, tests — alongside the fixed destinations.
 *
 * It is a real modal, unlike the header dropdowns: focus is trapped, the background is
 * inert to Tab, and Escape closes and restores focus to wherever you were. A "modal" that
 * lets Tab wander behind it is worse than no modal, because keyboard users end up
 * operating a page they cannot see.
 */
export interface PaletteOrg {
  slug: string;
  name: string;
}

export interface PaletteProject {
  key: string;
  name: string;
}

interface RemoteResult {
  projects: { key: string; name: string }[];
  tests: {
    id: number;
    name: string;
    suite: string | null;
    projectKey: string;
    lastStatus: string | null;
    flakeScore: number;
  }[];
}

interface Item {
  id: string;
  label: string;
  hint?: string;
  group: string;
  href: string;
  /** Rendered before the label; status glyphs carry meaning here, not decoration. */
  badge?: { text: string; tone: "failed" | "flaky" | "neutral" };
}

export function CommandPalette({
  orgSlug,
  orgs,
  projects,
  canUpload,
  isPlatformAdmin,
}: {
  orgSlug: string;
  orgs: PaletteOrg[];
  projects: PaletteProject[];
  canUpload: boolean;
  isPlatformAdmin: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [remote, setRemote] = useState<RemoteResult>({ projects: [], tests: [] });
  const [loading, setLoading] = useState(false);

  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const restoreFocusTo = useRef<HTMLElement | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setRemote({ projects: [], tests: [] });
    // Returning focus is what makes a modal feel like a layer rather than a navigation.
    restoreFocusTo.current?.focus();
  }, []);

  // ⌘K is the established binding for this, so it is what people will try first.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const isToggle =
        (event.metaKey || event.ctrlKey) && (event.key === "k" || event.code === "KeyK");
      if (isToggle) {
        event.preventDefault();
        if (open) {
          close();
          return;
        }
        restoreFocusTo.current = document.activeElement as HTMLElement | null;
        setActiveIndex(0);
        setOpen(true);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, close]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Debounced remote search. Tests live in Postgres behind a trigram index; refetching
  // on every keystroke would issue a query per character for no extra information.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const handle = setTimeout(() => {
      setLoading(true);
      fetch(`/api/v1/search?org=${encodeURIComponent(orgSlug)}&q=${encodeURIComponent(query)}`, {
        signal: controller.signal,
      })
        .then((response) => (response.ok ? response.json() : { projects: [], tests: [] }))
        .then((data: RemoteResult) => setRemote(data))
        .catch(() => {
          /* aborted or offline — the local items below still work */
        })
        .finally(() => setLoading(false));
    }, 140);

    return () => {
      clearTimeout(handle);
      controller.abort();
    };
  }, [open, query, orgSlug]);

  const items = useMemo<Item[]>(() => {
    const needle = query.trim().toLowerCase();
    const matches = (text: string): boolean => !needle || text.toLowerCase().includes(needle);

    const navigation: Item[] = [
      { id: "nav-dash", label: "Dashboard", group: "Go to", href: `/o/${orgSlug}` },
      { id: "nav-runs", label: "Runs", group: "Go to", href: `/o/${orgSlug}/runs` },
      { id: "nav-tests", label: "Tests", group: "Go to", href: `/o/${orgSlug}/tests` },
      { id: "nav-flaky", label: "Flaky tests", group: "Go to", href: `/o/${orgSlug}/flaky` },
      { id: "nav-projects", label: "Projects", group: "Go to", href: `/o/${orgSlug}/projects` },
      {
        id: "nav-failing",
        label: "Runs with failures",
        group: "Go to",
        href: `/o/${orgSlug}/runs?failed=true`,
      },
      {
        id: "nav-tokens",
        label: "API tokens",
        group: "Go to",
        href: `/o/${orgSlug}/settings/tokens`,
      },
      // Reachable by three routes on purpose — the header button, `?`, and here — because
      // someone who cannot find something is equally likely to try any of them.
      { id: "nav-help", label: "Help — how Test Center works", group: "Go to", href: "/help" },
      ...(canUpload
        ? [
            {
              id: "nav-upload",
              label: "Upload a report",
              group: "Go to",
              href: `/o/${orgSlug}/projects`,
            },
          ]
        : []),
      ...(isPlatformAdmin
        ? [{ id: "nav-admin", label: "Platform admin", group: "Go to", href: "/admin" }]
        : []),
    ].filter((item) => matches(item.label));

    // Remote projects when the query is doing work, local ones otherwise, so the palette
    // is useful before the first fetch returns.
    const projectSource = remote.projects.length > 0 || needle ? remote.projects : projects;
    const projectItems: Item[] = projectSource.map((project) => ({
      id: `project-${project.key}`,
      label: project.name,
      hint: project.key,
      group: "Projects",
      href: `/o/${orgSlug}/p/${project.key}`,
    }));

    const testItems: Item[] = remote.tests.map((test) => ({
      id: `test-${test.id}`,
      label: test.name,
      hint: [test.projectKey, test.suite].filter(Boolean).join(" · "),
      group: "Tests",
      href: `/o/${orgSlug}/tests/${test.id}`,
      ...(test.flakeScore >= 20
        ? { badge: { text: `flake ${Math.round(test.flakeScore)}`, tone: "flaky" as const } }
        : test.lastStatus === "failed" || test.lastStatus === "error"
          ? { badge: { text: "failing", tone: "failed" as const } }
          : {}),
    }));

    const orgItems: Item[] = orgs
      .filter((org) => org.slug !== orgSlug && matches(`${org.name} ${org.slug}`))
      .map((org) => ({
        id: `org-${org.slug}`,
        label: org.name,
        hint: org.slug,
        group: "Switch organisation",
        href: `/o/${org.slug}`,
      }));

    return [...navigation, ...projectItems, ...testItems, ...orgItems];
  }, [query, remote, projects, orgs, orgSlug, canUpload, isPlatformAdmin]);

  useEffect(() => setActiveIndex(0), [query]);

  // Keep the highlighted row on screen when arrowing past the visible window.
  useEffect(() => {
    if (!open) return;
    const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    node?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  function choose(item: Item | undefined): void {
    if (!item) return;
    close();
    router.push(item.href);
  }

  function onKeyDown(event: React.KeyboardEvent): void {
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        close();
        break;
      case "ArrowDown":
        event.preventDefault();
        setActiveIndex((index) => (items.length === 0 ? 0 : (index + 1) % items.length));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((index) =>
          items.length === 0 ? 0 : (index - 1 + items.length) % items.length,
        );
        break;
      case "Home":
        event.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        event.preventDefault();
        setActiveIndex(Math.max(items.length - 1, 0));
        break;
      case "Enter":
        event.preventDefault();
        choose(items[activeIndex]);
        break;
      case "Tab": {
        // Focus trap. Only the input and the rows are focusable, so cycling is a matter
        // of keeping focus inside the dialog rather than tracking every candidate.
        event.preventDefault();
        inputRef.current?.focus();
        break;
      }
      default:
        break;
    }
  }

  if (!open) return null;

  let lastGroup: string | null = null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]"
      role="presentation"
      onMouseDown={(event) => {
        if (!dialogRef.current?.contains(event.target as Node)) close();
      }}
    >
      <div className="absolute inset-0 bg-black/50" aria-hidden />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Search and jump to"
        onKeyDown={onKeyDown}
        className="relative w-full max-w-xl overflow-hidden rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-[var(--color-border-subtle)] px-3">
          <svg
            viewBox="0 0 16 16"
            className="size-4 shrink-0 text-[var(--color-ink-muted)]"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            aria-hidden
          >
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5 14 14" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Jump to a project, test or page…"
            aria-label="Search projects, tests and pages"
            aria-controls="palette-results"
            aria-activedescendant={items[activeIndex] ? `palette-item-${activeIndex}` : undefined}
            className="w-full bg-transparent py-3 text-sm outline-none placeholder:text-[var(--color-ink-muted)]"
          />
          {loading ? (
            <span className="shrink-0 text-[10px] text-[var(--color-ink-muted)]">searching…</span>
          ) : null}
          <kbd className="shrink-0 rounded border border-[var(--color-border-subtle)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-ink-muted)]">
            esc
          </kbd>
        </div>

        <ul
          ref={listRef}
          id="palette-results"
          role="listbox"
          aria-label="Results"
          className="max-h-80 overflow-y-auto p-1.5"
        >
          {items.length === 0 ? (
            <li className="px-3 py-6 text-center text-xs text-[var(--color-ink-muted)]">
              {query.length === 1
                ? "Keep typing — test search needs two characters."
                : `Nothing matches “${query}”.`}
            </li>
          ) : null}

          {items.map((item, index) => {
            const showGroup = item.group !== lastGroup;
            lastGroup = item.group;
            const active = index === activeIndex;

            return (
              <li key={item.id}>
                {showGroup ? (
                  <div className="px-2 pt-2 pb-1 text-[10px] font-medium tracking-widest text-[var(--color-ink-muted)] uppercase">
                    {item.group}
                  </div>
                ) : null}
                <button
                  type="button"
                  id={`palette-item-${index}`}
                  data-index={index}
                  role="option"
                  aria-selected={active}
                  tabIndex={-1}
                  onMouseMove={() => setActiveIndex(index)}
                  onClick={() => choose(item)}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs ${
                    active ? "bg-[var(--color-surface)]" : ""
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{item.label}</span>
                    {item.hint ? (
                      <span className="block truncate font-mono text-[10px] text-[var(--color-ink-muted)]">
                        {item.hint}
                      </span>
                    ) : null}
                  </span>
                  {item.badge ? (
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] ${
                        item.badge.tone === "failed"
                          ? "bg-[var(--color-status-failed)]/10 text-[var(--color-status-failed)]"
                          : "bg-[var(--color-status-flaky)]/10 text-[var(--color-status-flaky)]"
                      }`}
                    >
                      {item.badge.text}
                    </span>
                  ) : null}
                  {active ? (
                    <kbd className="shrink-0 rounded border border-[var(--color-border-subtle)] px-1 font-mono text-[10px] text-[var(--color-ink-muted)]">
                      ↵
                    </kbd>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>

        <div className="flex items-center gap-3 border-t border-[var(--color-border-subtle)] px-3 py-2 text-[10px] text-[var(--color-ink-muted)]">
          <span>
            <kbd className="font-mono">↑↓</kbd> move
          </span>
          <span>
            <kbd className="font-mono">↵</kbd> open
          </span>
          <span>
            <kbd className="font-mono">esc</kbd> close
          </span>
          <span className="ml-auto">
            <kbd className="font-mono">[</kbd> toggle sidebar
          </span>
        </div>
      </div>
    </div>
  );
}
