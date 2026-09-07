import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { setAutoRefresh } from "@/app/actions/ui";
import { Card } from "@/components/ui";
import {
  AUTO_REFRESH_COOKIE,
  AUTO_REFRESH_INTERVALS,
  AUTO_REFRESH_LABELS,
  readAutoRefresh,
  type AutoRefreshInterval,
} from "@/lib/auto-refresh";
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

      <Card className="p-5">
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
    </main>
  );
}
