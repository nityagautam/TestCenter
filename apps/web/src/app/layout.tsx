import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Test Center",
  description: "Test intelligence for every framework — ingest, triage, and trend test results.",
};

const NAV = [
  { href: "/", label: "Overview" },
  { href: "/runs", label: "Runs" },
  { href: "/upload", label: "Upload" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <header className="sticky top-0 z-10 border-b border-[var(--color-border-subtle)] bg-[var(--color-surface)]/85 backdrop-blur">
          <div className="mx-auto flex max-w-7xl items-center gap-6 px-6 py-3">
            <Link href="/" className="flex items-center gap-2 text-sm font-semibold tracking-tight">
              <span className="inline-block size-2.5 rounded-full bg-[var(--color-status-passed)]" />
              Test Center
            </Link>
            <nav className="flex items-center gap-1" aria-label="Main">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="rounded-md px-2.5 py-1.5 text-xs font-medium text-[var(--color-ink-muted)] transition-colors hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-ink)]"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
            <div className="ml-auto">
              <Link
                href="/api/health?deep=1"
                className="font-mono text-[11px] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
              >
                health
              </Link>
            </div>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
