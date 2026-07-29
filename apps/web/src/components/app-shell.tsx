"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { signOutAction } from "@/app/actions/auth";
import { NavLink } from "@/components/nav-link";
import { ScopeSwitcher, type ScopeOption } from "@/components/scope-switcher";

/**
 * Application shell: left navigation and a header with scope switchers.
 *
 * A client component because the current project has to come from the URL. A Next.js
 * layout cannot read its child route's params, and the alternative — duplicating the
 * shell inside every project layout — would guarantee the two copies drift.
 *
 * Capabilities are computed on the server and passed in, so a viewer-role member
 * never sees an Upload link that the API would refuse. Hiding a control the server
 * rejects is the difference between a permission model and a decoration.
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
}

/** `/o/acme/p/checkout-web/runs` → `checkout-web` */
function projectKeyFromPath(pathname: string, orgSlug: string): string | null {
  const prefix = `/o/${orgSlug}/p/`;
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  const key = rest.split("/")[0];
  return key || null;
}

export function AppShell({
  children,
  orgSlug,
  orgs,
  projects,
  viewer,
  capabilities,
}: AppShellProps) {
  const pathname = usePathname();
  const currentProjectKey = projectKeyFromPath(pathname, orgSlug);

  const currentOrg = orgs.find((org) => org.slug === orgSlug) ?? null;
  const currentProject = projects.find((project) => project.key === currentProjectKey) ?? null;

  const orgOptions: ScopeOption[] = orgs.map((org) => ({
    slug: org.slug,
    name: org.name,
    ...(org.isPersonal ? { badge: "personal" } : org.viaPlatformAdmin ? { badge: "admin" } : {}),
  }));

  const projectOptions: ScopeOption[] = projects.map((project) => ({
    slug: project.key,
    name: project.name,
  }));

  const projectBase = currentProjectKey ? `/o/${orgSlug}/p/${currentProjectKey}` : null;

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-56 shrink-0 border-r border-[var(--color-border-subtle)] lg:block">
        <div className="sticky top-0 flex h-screen flex-col">
          <Link
            href={`/o/${orgSlug}`}
            className="flex items-center gap-2 px-4 py-4 text-sm font-semibold tracking-tight"
          >
            <span className="inline-block size-2.5 rounded-full bg-[var(--color-status-passed)]" />
            Test Center
          </Link>

          <nav className="flex-1 space-y-5 overflow-y-auto px-2 py-2" aria-label="Main">
            <NavSection title="Organisation">
              <NavLink href={`/o/${orgSlug}`} exact>
                Dashboard
              </NavLink>
              <NavLink href={`/o/${orgSlug}/runs`}>Runs</NavLink>
              <NavLink href={`/o/${orgSlug}/tests`}>Tests</NavLink>
              <NavLink href={`/o/${orgSlug}/flaky`}>Flaky tests</NavLink>
              <NavLink href={`/o/${orgSlug}/projects`}>Projects</NavLink>
            </NavSection>

            {projectBase ? (
              <NavSection title={currentProject?.name ?? "Project"}>
                <NavLink href={projectBase} exact>
                  Overview
                </NavLink>
                <NavLink href={`${projectBase}/runs`}>Runs</NavLink>
                <NavLink href={`${projectBase}/tests`}>Tests</NavLink>
                {capabilities.canUpload ? (
                  <NavLink href={`${projectBase}/upload`}>Upload</NavLink>
                ) : null}
                <NavLink href={`${projectBase}/settings`}>Settings</NavLink>
              </NavSection>
            ) : null}

            <NavSection title="Settings">
              {capabilities.canManageMembers ? (
                <NavLink href={`/o/${orgSlug}/settings/members`}>Members</NavLink>
              ) : null}
              <NavLink href={`/o/${orgSlug}/settings/tokens`}>API tokens</NavLink>
              {viewer.isPlatformAdmin ? <NavLink href="/admin">Platform admin</NavLink> : null}
            </NavSection>
          </nav>

          <div className="border-t border-[var(--color-border-subtle)] px-4 py-3">
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
          </div>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-20 border-b border-[var(--color-border-subtle)] bg-[var(--color-surface)]/85 backdrop-blur">
          <div className="flex flex-wrap items-center gap-2 px-6 py-2.5">
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
              hrefFor={(key) => `/o/${orgSlug}/p/${key}`}
              emptyLabel="All projects"
              {...(capabilities.canCreateProject
                ? { createHref: `/o/${orgSlug}/projects/new`, createLabel: "New project" }
                : {})}
            />

            {currentOrg && currentOrg.role !== "owner" ? (
              <span
                className="rounded bg-[var(--color-border-subtle)] px-1.5 py-0.5 text-[10px] tracking-wide uppercase"
                title="Your role in this organisation"
              >
                {currentOrg.role}
              </span>
            ) : null}

            <div className="ml-auto flex items-center gap-2">
              <Link
                href={`/o/${orgSlug}/tests`}
                className="rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1.5 text-xs text-[var(--color-ink-muted)] hover:border-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
              >
                Search tests
              </Link>
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

        {children}
      </div>
    </div>
  );
}

function NavSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="truncate px-2 pb-1 text-[10px] font-medium tracking-widest text-[var(--color-ink-muted)] uppercase">
        {title}
      </div>
      <ul className="space-y-0.5">{children}</ul>
    </div>
  );
}
