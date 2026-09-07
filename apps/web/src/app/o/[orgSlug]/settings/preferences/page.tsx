import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { setAutoRefresh, setThemePreference } from "@/app/actions/ui";
import { Card } from "@/components/ui";
import {
  AUTO_REFRESH_COOKIE,
  AUTO_REFRESH_INTERVALS,
  AUTO_REFRESH_LABELS,
  readAutoRefresh,
  type AutoRefreshInterval,
} from "@/lib/auto-refresh";
import { readThemePreference, THEME_COOKIE, type ThemePreference } from "@/lib/theme";
import { readViewerTimeZone, TIMEZONE_COOKIE } from "@/lib/timezone";
import { requirePageContext } from "@/lib/viewer";

/**
 * Your preferences, not the organisation's.
 *
 * Every other page under Settings describes shared state — members, tokens, the quality gate — and
 * is gated on a capability. This one is gated on nothing, because everything on it is stored in
 * the viewer's own cookie and affects nobody else. Putting it behind `org:edit` would mean a
 * viewer could not choose how often their own browser makes requests.
 *
 * The copy says "you" throughout for the same reason. A settings page that does not say whose
 * settings it is will be read as the organisation's, and somebody will eventually wonder why their
 * change did not reach their team.
 */
export const dynamic = "force-dynamic";

export default async function PreferencesPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ ok?: string }>;
}) {
  const { orgSlug } = await params;
  const { ok } = await searchParams;
  const context = await requirePageContext(orgSlug);
  const store = await cookies();
  const interval = readAutoRefresh(store.get(AUTO_REFRESH_COOKIE)?.value);
  const theme = readThemePreference(store.get(THEME_COOKIE)?.value);
  const timeZone = readViewerTimeZone(store.get(TIMEZONE_COOKIE)?.value);

  return (
    <main className="mx-auto max-w-2xl px-6 py-6">
      <h1 className="text-lg font-semibold tracking-tight">Preferences</h1>
      <p className="mt-0.5 mb-5 text-xs leading-relaxed text-[var(--color-ink-muted)]">
        These apply to you, in this browser, across {context.org.name} — not to your team.
      </p>

      {ok ? (
        <p className="mb-4 rounded-md border border-[var(--color-status-passed)]/40 bg-[var(--color-status-passed)]/5 px-3 py-2 text-xs text-[var(--color-status-passed)]">
          {ok}
        </p>
      ) : null}

      <Card className="mb-5 p-5">
        <h2 className="text-sm font-medium">Theme</h2>
        <p className="mt-1 mb-4 max-w-prose text-xs leading-relaxed text-[var(--color-ink-muted)]">
          The same setting as the icon in the header; either changes both.
        </p>

        <form
          action={async (formData: FormData) => {
            "use server";
            const raw = String(formData.get("theme") ?? "system");
            const chosen: ThemePreference = raw === "light" || raw === "dark" ? raw : "system";
            await setThemePreference(chosen);
            // The root layout stamps <html data-theme> during its render, so the layout has to be
            // revalidated or the page would save the choice and keep showing the old theme.
            revalidatePath("/", "layout");
          }}
          className="space-y-3"
        >
          <fieldset className="space-y-2">
            <legend className="sr-only">Theme</legend>
            {(
              [
                [
                  "system",
                  "Follow my system",
                  "Tracks your operating system, including when it changes at sunset.",
                ],
                ["light", "Light", null],
                ["dark", "Dark", null],
              ] as const
            ).map(([value, label, hint]) => (
              <label key={value} className="flex items-baseline gap-2.5 text-[13px]">
                <input
                  type="radio"
                  name="theme"
                  value={value}
                  defaultChecked={value === theme}
                  className="mt-0.5"
                />
                <span>
                  {label}
                  {hint ? (
                    <span className="block text-[11px] text-[var(--color-ink-muted)]">{hint}</span>
                  ) : null}
                </span>
              </label>
            ))}
          </fieldset>
          <button
            type="submit"
            className="rounded-md bg-[var(--color-ink)] px-3 py-1.5 text-xs font-medium text-[var(--color-surface)] hover:opacity-90"
          >
            Save
          </button>
        </form>
      </Card>

      <Card className="mb-5 p-5">
        <h2 className="text-sm font-medium">Automatic refresh</h2>
        <p className="mt-1 mb-4 max-w-prose text-xs leading-relaxed text-[var(--color-ink-muted)]">
          How often a page checks whether new reports have arrived. It does not reload on a timer:
          it asks a small endpoint whether anything changed and only then re-renders, so a page
          nobody has uploaded to stays exactly as you left it. Checks pause while the tab is in the
          background and run once when you come back to it.
        </p>

        <form
          action={async (formData: FormData) => {
            "use server";
            const raw = Number(formData.get("interval"));
            const chosen = (AUTO_REFRESH_INTERVALS as readonly number[]).includes(raw)
              ? (raw as AutoRefreshInterval)
              : 0;
            await setAutoRefresh(chosen);
            /*
             * The header renders the control from this cookie during the server render, so the
             * layout has to be revalidated or the badge would keep showing the old interval until
             * the next hard navigation.
             */
            revalidatePath("/", "layout");
          }}
          className="space-y-3"
        >
          <fieldset className="space-y-2">
            <legend className="sr-only">Check for new reports</legend>
            {AUTO_REFRESH_INTERVALS.map((option) => (
              <label key={option} className="flex items-baseline gap-2.5 text-[13px]">
                <input
                  type="radio"
                  name="interval"
                  value={option}
                  defaultChecked={option === interval}
                  className="mt-0.5"
                />
                <span>
                  {AUTO_REFRESH_LABELS[option]}
                  {option === 0 ? (
                    <span className="block text-[11px] text-[var(--color-ink-muted)]">
                      The refresh button still tells you when something has arrived — it just waits
                      to be pressed.
                    </span>
                  ) : null}
                  {option === 10 ? (
                    <span className="block text-[11px] text-[var(--color-ink-muted)]">
                      For watching a run land. Faster than this is not offered: the check is cheap
                      but not free.
                    </span>
                  ) : null}
                </span>
              </label>
            ))}
          </fieldset>

          <button
            type="submit"
            className="rounded-md bg-[var(--color-ink)] px-3 py-1.5 text-xs font-medium text-[var(--color-surface)] hover:opacity-90"
          >
            Save
          </button>
        </form>
      </Card>

      {/*
       * Shown, not settable, and that is deliberate.
       *
       * `TimezoneSync` writes this cookie from the browser whenever it disagrees with what is
       * stored, so an override here would be silently reverted on the next render — a setting that
       * does not stick is worse than no setting. What was actually missing is this sentence:
       * nothing on any page said which zone the timestamps and hour buckets were in, so a reader
       * looking at an unfamiliar hour had no way to find out.
       */}
      <Card className="p-5">
        <h2 className="text-sm font-medium">Time zone</h2>
        <p className="mt-1 text-xs leading-relaxed text-[var(--color-ink-muted)]">
          Times, dates and hour-of-day charts are shown in{" "}
          <strong className="font-medium text-[var(--color-ink)]">
            {timeZone.zone} ({timeZone.label})
          </strong>
          , detected from this browser. Charts are bucketed in this zone rather than shifted after
          the fact, so half-hour offsets land correctly.
        </p>
      </Card>
    </main>
  );
}
