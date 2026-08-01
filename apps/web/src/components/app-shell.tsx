"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { orgScopeHref, projectKeyFromPath, projectScopeHref } from "@/lib/scope";
import { useCallback, useEffect, useState, useTransition, type ReactNode } from "react";
import { signOutAction } from "@/app/actions/auth";
import { clearProjectScope, setProjectScope, setSidebarState } from "@/app/actions/ui";
import type { SidebarState } from "@/lib/sidebar";
import { CREDIT } from "@/lib/credit";
import { CommandPalette } from "@/components/command-palette";
import { NavLink } from "@/components/nav-link";
import { ScopeSwitcher, type ScopeOption } from "@/components/scope-switcher";
import { ThemeToggle } from "@/components/theme-toggle";
import type { ThemePreference } from "@/lib/theme";

/**
 * Application shell.
 *
 * Design intent: this is an instrument panel, not a marketing page. It is read many
 * times a day by people who already know where things are, so the chrome stays quiet
 * and gives its space to the data. The one deliberate flourish is the collapsed rail —
 * it keeps failure and flake counts as badges, so narrowing the nav costs you the
 * labels but never the signal. A nav that still monitors at 56px wide.
 *
 * Header and sidebar are fixed; only the content column scrolls. That matters on the
 * run and test tables, where scrolling a thousand rows previously carried the org and
 * project switchers off the top of the screen.
 *
 * It is a client component because the current project comes from the URL — a Next.js
 * layout cannot read its child route's params, and duplicating the shell into every
 * project layout would guarantee the copies drift.
 */
export interface ShellOrg {
  slug: string;
  name: string;
  isPersonal: boolean;
  role: string;
  viaPlatformAdmin: boolean;
}

export interface ShellProject {
  key: string;
  name: string;
}

export interface AppShellProps {
  children: ReactNode;
  orgSlug: string;
  orgs: ShellOrg[];
  projects: ShellProject[];
  viewer: { email: string; name: string | null; isPlatformAdmin: boolean };
  capabilities: { canCreateProject: boolean; canUpload: boolean; canManageMembers: boolean };
  /** Live counts so the collapsed rail still carries signal. */
  signals: { failing: number; flaky: number };
  /**
   * The project the user last selected, when the current URL does not name one.
   *
   * Already validated against `projects` by the layout, so the shell can trust it.
   */
  rememberedProjectKey: string | null;
  /** Rendered from a cookie, so a collapsed sidebar never flashes open. */
  initialSidebar: SidebarState;
  /** Same reason: the theme is correct in the first painted frame. */
  initialTheme: ThemePreference;
}

export function AppShell({
  children,
  orgSlug,
  orgs,
  projects,
  viewer,
  capabilities,
  signals,
  rememberedProjectKey,
  initialSidebar,
  initialTheme,
}: AppShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [sidebar, setSidebar] = useState<SidebarState>(initialSidebar);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [, startTransition] = useTransition();
  const collapsed = sidebar === "collapsed";

  const toggle = useCallback(() => {
    const next: SidebarState = collapsed ? "expanded" : "collapsed";
    setSidebar(next);
    /*
     * Inside a transition, not fire-and-forget.
     *
     * A bare `void setSidebarState(next)` appeared to work — the panel moved — but the
     * cookie did not reliably survive, so the next server render re-read the old value
     * and the sidebar silently snapped back. Running it as a transition ties the write
     * to React's update, which is also what keeps the optimistic local state and the
     * persisted state from disagreeing.
     */
    startTransition(() => void setSidebarState(next));
  }, [collapsed]);

  // `[` for the sidebar is the convention in editors and developer tools, which is the
  // audience here; `?` for help is the convention nearly everywhere else. Both are ignored
  // while typing so they cannot eat a character in the search box.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        target?.isContentEditable;
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;

      // Matched on the character alone, unlike `[` below: `?` needs Shift on most layouts
      // and sits on a different physical key depending on the layout, so `event.code` would
      // be wrong more often than it was right. Shift is deliberately not excluded above.
      if (event.key === "?") {
        event.preventDefault();
        router.push("/help");
        return;
      }

      // Matched on both the character and the physical key: on layouts where `[`
      // needs a modifier (German, French) event.key is something else entirely, and
      // event.code still identifies the same physical key.
      if (event.key === "[" || event.code === "BracketLeft") {
        event.preventDefault();
        toggle();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [toggle, router]);

  /*
   * Escape closes the mobile drawer.
   *
   * Necessary rather than nice: the open drawer covers the very button that opened it,
   * so without this a keyboard user has no way out except the pointer-only dismiss
   * overlay. Registered separately from the toggle shortcut because it must fire even
   * while focus sits in a text field.
   */
  useEffect(() => {
    if (!mobileOpen) return;
    function onEscape(event: KeyboardEvent): void {
      if (event.key === "Escape") setMobileOpen(false);
    }
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  }, [mobileOpen]);

  // A route change closes the mobile drawer; leaving it open over the new page is
  // disorienting and traps focus behind an overlay.
  useEffect(() => setMobileOpen(false), [pathname]);

  const currentOrg = orgs.find((org) => org.slug === orgSlug) ?? null;

  /*
   * The selected project: what the URL says, or failing that what the user last chose.
   *
   * The path wins when it has an opinion, so opening a shared link lands on the project
   * that link is about rather than on whatever the recipient was last looking at. When the
   * path is silent — a test detail page, a run detail page, the organisation dashboard —
   * the remembered choice stands. Deriving it from the path alone meant the header dropdown
   * reset to "All projects" and the project's nav section disappeared the moment you opened
   * a test from that project's own list, which is exactly when you least expect to lose your
   * place.
   */
  const pathProjectKey = projectKeyFromPath(pathname, orgSlug);
  const currentProjectKey = pathProjectKey ?? rememberedProjectKey;
  const currentProject = projects.find((project) => project.key === currentProjectKey) ?? null;
  const projectBase = currentProject ? `/o/${orgSlug}/p/${currentProject.key}` : null;

  /*
   * Persist what the path told us, so the next page that cannot see the project still knows.
   *
   * Only fires when the path names a project and it differs from what is stored — navigating
   * within a project, or across pages that do not name one, writes nothing. Clearing is not
   * done here: leaving a project by visiting an organisation-wide page must not forget the
   * selection, because that is the behaviour being fixed. Only choosing "All projects" clears
   * it, and that path calls the action directly.
   */
  useEffect(() => {
    if (!pathProjectKey || pathProjectKey === rememberedProjectKey) return;
    startTransition(() => void setProjectScope(orgSlug, pathProjectKey));
  }, [pathProjectKey, rememberedProjectKey, orgSlug]);

  /*
   * Scope changes keep you in the same section wherever the section exists at both levels.
   *
   * Reading a project's test list and switching to another project lands on that project's
   * test list; doing it from the org-wide list narrows the same list. Selecting "all
   * projects" widens it back. Only when the section is project-only (upload, settings) does
   * the switcher fall back to the project overview, because there is nowhere else to go.
   */
  const projectHref = (key: string): string => projectScopeHref(pathname, orgSlug, key);
  const allProjectsHref = orgScopeHref(pathname, orgSlug);

  const orgOptions: ScopeOption[] = orgs.map((org) => ({
    slug: org.slug,
    name: org.name,
    ...(org.isPersonal ? { badge: "personal" } : org.viaPlatformAdmin ? { badge: "admin" } : {}),
  }));
  const projectOptions: ScopeOption[] = projects.map((project) => ({
    slug: project.key,
    name: project.name,
  }));

  const nav = (
    <nav className="flex-1 space-y-5 overflow-y-auto px-2 py-3" aria-label="Main navigation">
      <NavSection title="Organisation" collapsed={collapsed}>
        <NavLink href={`/o/${orgSlug}`} icon="dashboard" exact collapsed={collapsed}>
          Dashboard
        </NavLink>
        <NavLink href={`/o/${orgSlug}/runs`} icon="runs" collapsed={collapsed}>
          Runs
        </NavLink>
        <NavLink href={`/o/${orgSlug}/tests`} icon="tests" collapsed={collapsed}>
          Tests
        </NavLink>
        <NavLink
          href={`/o/${orgSlug}/flaky`}
          icon="flaky"
          count={signals.flaky}
          tone="flaky"
          collapsed={collapsed}
        >
          Flaky tests
        </NavLink>
        <NavLink href={`/o/${orgSlug}/reports`} icon="reports" collapsed={collapsed}>
          Reports
        </NavLink>
        <NavLink href={`/o/${orgSlug}/projects`} icon="projects" collapsed={collapsed}>
          Projects
        </NavLink>
      </NavSection>

      {/* The heading is prefixed, because a bare project name sitting between "Organisation"
          and "Settings" reads as a third category rather than as the name of the thing being
          scoped to. */}
      {projectBase ? (
        <NavSection
          title={currentProject ? `Project: ${currentProject.name}` : "Project"}
          collapsed={collapsed}
        >
          <NavLink href={projectBase} icon="overview" exact collapsed={collapsed}>
            Overview
          </NavLink>
          <NavLink href={`${projectBase}/runs`} icon="runs" collapsed={collapsed}>
            Runs
          </NavLink>
          <NavLink href={`${projectBase}/tests`} icon="tests" collapsed={collapsed}>
            Tests
          </NavLink>
          {/* No count here, unlike the organisation entry: `signals.flaky` is the
              organisation-wide total, and showing it against a project would attribute
              other projects' flakes to this one. The page states its own count. */}
          <NavLink href={`${projectBase}/flaky`} icon="flaky" collapsed={collapsed}>
            Flaky tests
          </NavLink>
          <NavLink href={`${projectBase}/reports`} icon="reports" collapsed={collapsed}>
            Reports
          </NavLink>
          {capabilities.canUpload ? (
            <NavLink href={`${projectBase}/upload`} icon="upload" collapsed={collapsed}>
              Upload
            </NavLink>
          ) : null}
          <NavLink href={`${projectBase}/settings`} icon="settings" collapsed={collapsed}>
            Settings
          </NavLink>
        </NavSection>
      ) : null}

      <NavSection title="Settings" collapsed={collapsed}>
        {capabilities.canManageMembers ? (
          <NavLink href={`/o/${orgSlug}/settings/members`} icon="members" collapsed={collapsed}>
            Members
          </NavLink>
        ) : null}
        <NavLink href={`/o/${orgSlug}/settings/tokens`} icon="tokens" collapsed={collapsed}>
          API tokens
        </NavLink>
        {viewer.isPlatformAdmin ? (
          <NavLink href="/admin" icon="admin" collapsed={collapsed}>
            Platform admin
          </NavLink>
        ) : null}
      </NavSection>
    </nav>
  );

  const sidebarWidth = collapsed ? "3.5rem" : "14rem";

  return (
    <div className="min-h-screen">
      {/* First focusable element on the page. Keyboard users should not have to walk
          the entire nav on every navigation to reach the content. */}
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-[var(--color-ink)] focus:px-3 focus:py-2 focus:text-xs focus:font-medium focus:text-[var(--color-surface)]"
      >
        Skip to content
      </a>

      {/* ── Sidebar: fixed, collapsible, off-canvas below lg ─────────────── */}
      <aside
        id="sidebar"
        aria-label="Sections"
        data-state={sidebar}
        className={`fixed inset-y-0 left-0 z-40 flex flex-col border-r border-[var(--color-border-subtle)] bg-[var(--color-surface)] transition-transform duration-150 motion-reduce:transition-none lg:transition-[width] ${
          mobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        }`}
        style={{ width: collapsed && !mobileOpen ? sidebarWidth : "14rem" }}
      >
        {/* The brand strip is part of the header band, not part of the sidebar: the aside
            sits above the header in the stack, so leaving this on the page surface cut a
            notch out of the left end of the coloured bar. Same token rebinding as the
            header, so the two halves cannot drift apart. */}
        <div
          className={`flex h-12 shrink-0 items-center border-b border-[var(--color-chrome-border)] bg-[var(--color-chrome)] text-[var(--color-chrome-ink)] ${
            collapsed && !mobileOpen ? "justify-center px-2" : "gap-2 px-4"
          }`}
          style={{
            ["--color-surface" as string]: "var(--color-chrome)",
            ["--color-surface-raised" as string]: "var(--color-chrome-raised)",
            ["--color-border-subtle" as string]: "var(--color-chrome-border)",
            ["--color-ink" as string]: "var(--color-chrome-ink)",
            ["--color-ink-muted" as string]: "var(--color-chrome-ink-muted)",
          }}
        >
          <Link
            href={`/o/${orgSlug}`}
            className="flex min-w-0 items-center gap-2 text-sm font-semibold tracking-tight"
            aria-label="Test Center home"
          >
            {/* Was status-passed green. A green dot beside the product name is indis-
                tinguishable from a health indicator saying everything is passing, and
                status tokens are reserved for actual status. */}
            <span
              className="inline-block size-2.5 shrink-0 rounded-full bg-[var(--color-chrome-ink)]"
              aria-hidden
            />
            {collapsed && !mobileOpen ? null : <span className="truncate">Test Center</span>}
          </Link>
        </div>

        {collapsed && !mobileOpen ? (
          <div className="px-2 pt-3">{/* spacing parity with the expanded rail */}</div>
        ) : null}

        {nav}

        <div
          className={`shrink-0 border-t border-[var(--color-border-subtle)] py-3 ${
            collapsed && !mobileOpen ? "px-2" : "px-4"
          }`}
        >
          {collapsed && !mobileOpen ? (
            <form action={signOutAction}>
              <button
                type="submit"
                title={`Sign out (${viewer.email})`}
                aria-label={`Sign out ${viewer.email}`}
                className="flex w-full items-center justify-center rounded-md py-1.5 text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-ink)]"
              >
                <svg
                  viewBox="0 0 16 16"
                  className="size-3.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  aria-hidden
                >
                  <path d="M6 2.5H3.5v11H6M9.5 8h4.5M11.5 5.5 14 8l-2.5 2.5" />
                </svg>
              </button>
            </form>
          ) : (
            <>
              <div className="truncate text-xs font-medium">{viewer.name ?? viewer.email}</div>
              <div className="truncate font-mono text-[10px] text-[var(--color-ink-muted)]">
                {viewer.email}
              </div>
              <form action={signOutAction}>
                <button
                  type="submit"
                  className="mt-2 text-[11px] text-[var(--color-ink-muted)] underline hover:text-[var(--color-ink)]"
                >
                  Sign out
                </button>
              </form>
            </>
          )}
        </div>

        {/*
         * Developer credit.
         *
         * Its own strip below the account block, and explicitly prefixed "Built by",
         * because the block directly above it is also a person's name — an unlabelled
         * second name stacked under the signed-in user reads as a second account. The
         * label is what keeps the two apart.
         *
         * Deliberately the quietest thing in the shell: smaller than the nav, muted, no
         * link. A credit earns its place by being present, not by competing with the
         * navigation someone opened the app to use.
         */}
        <div
          className={`shrink-0 border-t border-[var(--color-border-subtle)] py-2.5 ${
            collapsed && !mobileOpen ? "px-2" : "px-4"
          }`}
        >
          {collapsed && !mobileOpen ? (
            <div
              className="text-center font-mono text-[10px] text-[var(--color-ink-muted)]"
              title={CREDIT.title}
            >
              {CREDIT.initials}
            </div>
          ) : (
            <p className="truncate text-[10px] text-[var(--color-ink-muted)]">
              Built by <span className="text-[var(--color-ink)]">{CREDIT.name}</span>
            </p>
          )}
        </div>
      </aside>

      {/* Dismiss layer for the mobile drawer. aria-hidden because Escape and the
          toggle already provide keyboard routes out. */}
      {mobileOpen ? (
        <button
          type="button"
          onClick={() => setMobileOpen(false)}
          className="fixed inset-0 z-30 bg-black/40 lg:hidden"
          aria-hidden
          tabIndex={-1}
        />
      ) : null}

      {/* ── Fixed header ─────────────────────────────────────────────────── */}
      <header
        className="tc-print-hide fixed inset-x-0 top-0 z-30 h-12 border-b border-[var(--color-chrome-border)] bg-[var(--color-chrome)] text-[var(--color-chrome-ink)] transition-[padding] duration-150 motion-reduce:transition-none"
        style={{
          paddingLeft: `var(--tc-sidebar, 0px)`,
          /*
           * The header rebinds the generic surface and ink tokens to their chrome
           * equivalents for its whole subtree, rather than threading a `variant` prop
           * through every control inside it.
           *
           * Everything in here — both scope switchers and their dropdowns, the search
           * button, the theme toggle, the role badge — is already written against
           * --color-surface / --color-ink / --color-border-subtle. Rebinding those five
           * properties at this one element recolours all of it, including components that
           * know nothing about the header, and keeps a single definition of what "on
           * chrome" means. It also means the dropdowns read as extensions of the header
           * they hang from, which is what they are.
           */
          ["--color-surface" as string]: "var(--color-chrome)",
          ["--color-surface-raised" as string]: "var(--color-chrome-raised)",
          ["--color-border-subtle" as string]: "var(--color-chrome-border)",
          ["--color-ink" as string]: "var(--color-chrome-ink)",
          ["--color-ink-muted" as string]: "var(--color-chrome-ink-muted)",
        }}
      >
        <div className="flex h-full items-center gap-2 px-3 lg:px-4">
          <button
            type="button"
            onClick={() => setMobileOpen((open) => !open)}
            aria-expanded={mobileOpen}
            aria-controls="sidebar"
            aria-label={mobileOpen ? "Close navigation" : "Open navigation"}
            className="rounded-md p-1.5 text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-ink)] lg:hidden"
          >
            <Bars />
          </button>

          <button
            type="button"
            onClick={toggle}
            aria-expanded={!collapsed}
            aria-controls="sidebar"
            title={`${collapsed ? "Expand" : "Collapse"} sidebar  [`}
            className="hidden rounded-md p-1.5 text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-ink)] lg:block"
          >
            <span className="sr-only">
              {collapsed ? "Expand sidebar" : "Collapse sidebar"} (keyboard shortcut: left bracket)
            </span>
            <PanelIcon collapsed={collapsed} />
          </button>

          <ScopeSwitcher
            label="Org"
            current={currentOrg ? { slug: currentOrg.slug, name: currentOrg.name } : null}
            options={orgOptions}
            hrefFor={(slug) => `/o/${slug}`}
            emptyLabel="Select"
            createHref="/onboarding"
            createLabel="New organisation"
          />

          <ScopeSwitcher
            label="Project"
            current={
              currentProject ? { slug: currentProject.key, name: currentProject.name } : null
            }
            options={projectOptions}
            hrefFor={projectHref}
            clearHref={allProjectsHref}
            clearLabel="All projects"
            clearAction={clearProjectScope.bind(null, orgSlug, allProjectsHref)}
            emptyLabel="All projects"
            {...(capabilities.canCreateProject
              ? { createHref: `/o/${orgSlug}/projects/new`, createLabel: "New project" }
              : {})}
          />

          {currentOrg && currentOrg.role !== "owner" ? (
            <span
              className="hidden rounded bg-[var(--color-border-subtle)] px-1.5 py-0.5 text-[10px] tracking-wide uppercase sm:inline"
              title="Your role in this organisation"
            >
              {currentOrg.role}
            </span>
          ) : null}

          <div className="ml-auto flex items-center gap-2">
            {signals.failing > 0 ? (
              <Link
                href={`/o/${orgSlug}/runs?failed=true`}
                // The dot is decorative and the count is split across spans, so the name
                // is stated once here instead of assembled from fragments.
                aria-label={`${signals.failing} failing tests in the last 30 days. Show runs with failures.`}
                className="hidden items-center gap-1.5 rounded-md border border-[var(--color-chrome-danger)]/40 px-2 py-1 text-[11px] text-[var(--color-chrome-danger)] hover:bg-[var(--color-chrome-danger)]/10 sm:flex"
              >
                <span
                  className="inline-block size-1.5 rounded-full bg-[var(--color-chrome-danger)]"
                  aria-hidden
                />
                <span className="font-mono tabular-nums">{signals.failing}</span>
                <span>failing</span>
              </Link>
            ) : null}
            {/* Announces the shortcut rather than hiding it: a keybinding nobody is
                told about is a keybinding nobody uses. Clicking dispatches the same
                event, so there is one code path for both. */}
            <button
              type="button"
              onClick={() =>
                document.dispatchEvent(
                  new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }),
                )
              }
              aria-label="Search projects, tests and pages. Keyboard shortcut: command K"
              className="hidden items-center gap-2 rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1.5 text-xs text-[var(--color-ink-muted)] hover:border-[var(--color-ink-muted)] hover:text-[var(--color-ink)] sm:flex"
            >
              <span>Search</span>
              <kbd className="rounded border border-[var(--color-border-subtle)] px-1 font-mono text-[10px]">
                ⌘K
              </kbd>
            </button>

            {/* Beside Search rather than buried in a menu, and it states its shortcut for
                the same reason Search does. Help that has to be found is help nobody reads,
                and this is the one page that has to work on somebody's first day. */}
            <Link
              href="/help"
              title="Help  ?"
              aria-label="Help — how Test Center works. Keyboard shortcut: question mark"
              className="flex items-center gap-1.5 rounded-md border border-[var(--color-border-subtle)] px-2 py-1.5 text-xs text-[var(--color-ink-muted)] hover:border-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
            >
              <svg
                viewBox="0 0 16 16"
                className="size-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                aria-hidden
              >
                <circle cx="8" cy="8" r="6.25" />
                <path d="M6.2 6.1a1.9 1.9 0 1 1 2.1 2.5v1.1" />
                <path d="M8.3 11.6h.01" strokeWidth="1.8" />
              </svg>
              <kbd className="hidden rounded border border-[var(--color-border-subtle)] px-1 font-mono text-[10px] sm:inline">
                ?
              </kbd>
            </Link>

            <ThemeToggle initial={initialTheme} />
            {capabilities.canUpload ? (
              <Link
                href={projectBase ? `${projectBase}/upload` : `/o/${orgSlug}/projects`}
                className="rounded-md bg-[var(--color-ink)] px-2.5 py-1.5 text-xs font-medium text-[var(--color-surface)] hover:opacity-90"
              >
                Upload
              </Link>
            ) : null}
          </div>
        </div>
      </header>

      {/* The shell width is published as a custom property so the header and content
          column stay in step with the sidebar without duplicating the value. */}
      <style>{`@media (min-width: 1024px) { :root { --tc-sidebar: ${sidebarWidth}; } }`}</style>

      <div
        className="transition-[padding] duration-150 motion-reduce:transition-none"
        style={{ paddingLeft: "var(--tc-sidebar, 0px)" }}
      >
        {/* pt-12 clears the fixed top bar. The print sheet drops that padding along with the
            bar, so a printed page does not open with an inch of white. */}
        <main id="content" tabIndex={-1} className="tc-shell-main pt-12">
          {children}
        </main>
      </div>

      <CommandPalette
        orgSlug={orgSlug}
        orgs={orgs.map((org) => ({ slug: org.slug, name: org.name }))}
        projects={projects}
        canUpload={capabilities.canUpload}
        isPlatformAdmin={viewer.isPlatformAdmin}
      />
    </div>
  );
}

function NavSection({
  title,
  collapsed,
  children,
}: {
  title: string;
  collapsed: boolean;
  children: ReactNode;
}) {
  return (
    <div>
      {collapsed ? (
        // A rule instead of a heading: the label would not fit, but the grouping is
        // still information worth keeping.
        <div className="mx-2 mb-1.5 border-t border-[var(--color-border-subtle)]" aria-hidden />
      ) : (
        <h2 className="truncate px-2 pb-1 text-[10px] font-medium tracking-widest text-[var(--color-ink-muted)] uppercase">
          {title}
        </h2>
      )}
      <ul className="space-y-0.5">{children}</ul>
    </div>
  );
}

function Bars() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
    </svg>
  );
}

function PanelIcon({ collapsed }: { collapsed: boolean }) {
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
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M6.5 2.5v11" />
      {/* The chevron points where the panel will go, not where it is. */}
      <path d={collapsed ? "M9.5 6.5 11.5 8l-2 1.5" : "M11.5 6.5 9.5 8l2 1.5"} />
    </svg>
  );
}
