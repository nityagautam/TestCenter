import Link from "next/link";
import { redirect } from "next/navigation";
import { authStatus, signIn } from "@/auth";
import { Card } from "@/components/ui";
import { currentViewer, resolveLandingPath } from "@/lib/viewer";

/**
 * Sign-in.
 *
 * Shows whichever providers are actually configured, and says so plainly when none
 * are — a sign-in page with no buttons and no explanation is the worst first
 * impression a self-hosted app can make.
 */
export const dynamic = "force-dynamic";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const { error } = await searchParams;

  // Already signed in: go where they were headed rather than showing a dead form.
  if (await currentViewer()) redirect(await resolveLandingPath());

  return (
    <main className="mx-auto flex min-h-[80vh] max-w-md flex-col justify-center px-6 py-12">
      <div className="mb-8 text-center">
        <div className="mb-3 flex items-center justify-center gap-2">
          <span className="inline-block size-3 rounded-full bg-[var(--color-status-passed)]" />
          <span className="text-lg font-semibold tracking-tight">Test Center</span>
        </div>
        <p className="text-xs leading-relaxed text-[var(--color-ink-muted)]">
          Test intelligence for every framework. Sign in to see your organisations.
        </p>
        {/* Before the form, not after it: someone who has not decided whether they want an
            account is the exact reader the guide is written for, and /help needs no session. */}
        <p className="mt-2 text-xs">
          <Link
            href="/help"
            className="text-[var(--color-ink-muted)] underline hover:text-[var(--color-ink)]"
          >
            New here? Read how it works
          </Link>
        </p>
      </div>

      {error ? (
        <div className="mb-4 rounded-lg border border-[var(--color-status-failed)]/40 bg-[var(--color-status-failed)]/5 px-4 py-3">
          <p className="text-xs text-[var(--color-status-failed)]">
            {error === "AccessDenied"
              ? "That account is not allowed to sign in. Check the permitted email domains."
              : "Sign-in failed. Please try again."}
          </p>
        </div>
      ) : null}

      <Card className="p-5">
        {!authStatus.anyProvider ? (
          <div className="space-y-2 text-center">
            <p className="text-sm font-medium">No sign-in method configured</p>
            <p className="text-xs leading-relaxed text-[var(--color-ink-muted)]">
              Set <code className="font-mono">AUTH_GOOGLE_ID</code> and{" "}
              <code className="font-mono">AUTH_GOOGLE_SECRET</code> for Google sign-in, or run in
              development with <code className="font-mono">AUTH_DEV_LOGIN</code> enabled.
            </p>
          </div>
        ) : null}

        {authStatus.googleConfigured ? (
          <form
            action={async () => {
              "use server";
              await signIn("google", { redirectTo: "/" });
            }}
          >
            <button
              type="submit"
              className="w-full rounded-md bg-[var(--color-ink)] px-4 py-2 text-sm font-medium text-[var(--color-surface)] transition-opacity hover:opacity-90"
            >
              Continue with Google
            </button>
          </form>
        ) : null}

        {authStatus.googleConfigured && authStatus.devLoginEnabled ? (
          <div className="my-4 flex items-center gap-3">
            <div className="h-px flex-1 bg-[var(--color-border-subtle)]" />
            <span className="text-[11px] text-[var(--color-ink-muted)]">or</span>
            <div className="h-px flex-1 bg-[var(--color-border-subtle)]" />
          </div>
        ) : null}

        {authStatus.devLoginEnabled ? (
          <form
            action={async (formData: FormData) => {
              "use server";
              await signIn("dev", {
                email: String(formData.get("email") ?? ""),
                name: String(formData.get("name") ?? ""),
                redirectTo: "/",
              });
            }}
            className="space-y-3"
          >
            <div>
              <label
                htmlFor="email"
                className="mb-1 block text-xs font-medium text-[var(--color-ink-muted)]"
              >
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                required
                placeholder="you@example.com"
                className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-2 font-mono text-xs outline-none focus:border-[var(--color-ink-muted)]"
              />
            </div>
            <div>
              <label
                htmlFor="name"
                className="mb-1 block text-xs font-medium text-[var(--color-ink-muted)]"
              >
                Display name <span className="font-normal">(optional)</span>
              </label>
              <input
                id="name"
                name="name"
                type="text"
                placeholder="Ashutosh"
                className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-2 text-xs outline-none focus:border-[var(--color-ink-muted)]"
              />
            </div>
            <button
              type="submit"
              className={`w-full rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                authStatus.googleConfigured
                  ? "border border-[var(--color-border-subtle)] hover:border-[var(--color-ink-muted)]"
                  : "bg-[var(--color-ink)] text-[var(--color-surface)] hover:opacity-90"
              }`}
            >
              Sign in
            </button>
            <p className="text-[11px] leading-relaxed text-[var(--color-ink-muted)]">
              Development sign-in — no password, and disabled in production. Use different addresses
              to check that organisations stay isolated from each other.
            </p>
          </form>
        ) : null}
      </Card>
    </main>
  );
}
