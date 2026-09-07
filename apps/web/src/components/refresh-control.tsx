"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AUTO_REFRESH_SHORT, type AutoRefreshInterval } from "@/lib/auto-refresh";

/**
 * Refresh now, and pick up new reports without being asked.
 *
 * WHY THIS IS NOT A TIMER
 *
 * The obvious build is `setInterval(router.refresh, n)`. It is wrong in both directions: it spends
 * a full server render every tick whether or not anything arrived, and it moves the page under
 * somebody mid-sentence for no reason. Instead this polls one change token — a count and a
 * timestamp, no data — and refreshes only when it moves. "Every 30 seconds" becomes "when there is
 * something to see", which is what anyone asking for auto-refresh actually meant.
 *
 * WHY IT STILL TELLS YOU WHEN AUTO-REFRESH IS OFF
 *
 * With the interval off, the token is still checked once on focus. If something arrived the button
 * says so and waits to be pressed. That is the state most readers want and no product offers: not
 * a page that changes under you, and not a stale page that looks identical to a fresh one. A
 * refresh button that cannot tell you whether pressing it will do anything is a button you press
 * out of superstition.
 */
type State = "idle" | "checking" | "stale" | "refreshing";

/**
 * How often to check when automatic refresh is off.
 *
 * Only ever sets the "New reports" prompt; it never refreshes. Slow enough to be nearly free,
 * quick enough that the prompt arrives while the reason for it still matters.
 */
const NOTIFY_ONLY_SECONDS = 60;

export function RefreshControl({
  orgSlug,
  projectKey,
  interval,
  settingsHref,
}: {
  orgSlug: string;
  projectKey?: string | null;
  /** Seconds between checks, or 0 for off. A viewer preference; see `lib/auto-refresh.ts`. */
  interval: AutoRefreshInterval;
  /** Where the interval is configured, so the control can point at its own setting. */
  settingsHref: string;
}) {
  const router = useRouter();
  const [state, setState] = useState<State>("idle");
  const [, startTransition] = useTransition();
  /*
   * The token last seen, and the time of the last successful render, in refs rather than state.
   * Neither should cause a render of its own: the token is a comparison value nobody sees, and
   * re-rendering the header once a second to age a timestamp would be a worse waste than the
   * refresh this component exists to avoid.
   */
  const token = useRef<string | null>(null);
  const refreshedAt = useRef<number>(Date.now());

  const refresh = useCallback(() => {
    setState("refreshing");
    refreshedAt.current = Date.now();
    startTransition(() => {
      router.refresh();
      // Cleared on a short delay rather than in a callback: `router.refresh()` resolves when the
      // payload arrives, not when React has painted it, so clearing immediately makes the icon
      // stop spinning before the numbers change.
      window.setTimeout(() => setState("idle"), 600);
    });
  }, [router]);

  useEffect(() => {
    const params = new URLSearchParams({ org: orgSlug });
    if (projectKey) params.set("project", projectKey);
    const url = `/api/v1/activity?${params.toString()}`;
    let cancelled = false;
    let timer = 0;

    const check = async (): Promise<void> => {
      /*
       * Never while the tab is hidden. A dashboard left open in a background tab is the common
       * case, and polling it costs the server exactly as much as polling a watched one while
       * being worth nothing. The visibility listener below checks immediately on return, so
       * coming back to the tab is when the answer is actually wanted.
       */
      if (document.visibilityState !== "visible") return;
      try {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok || cancelled) return;
        const body = (await response.json()) as { token?: string };
        if (cancelled || typeof body.token !== "string") return;

        if (token.current === null) {
          // First look establishes the baseline. Refreshing here would reload the page the
          // moment it opened, every time.
          token.current = body.token;
          return;
        }
        if (body.token === token.current) return;

        token.current = body.token;
        if (interval > 0) refresh();
        else setState("stale");
      } catch {
        // A failed check is not worth reporting. The page is still correct as of its last render,
        // and an error badge on a background poll would be alarming out of all proportion —
        // people are offline on trains.
      }
    };

    void check();
    /*
     * Off still polls — slowly, and only to tell you.
     *
     * The first build checked on mount and on tab focus, which meant somebody sitting on a
     * dashboard with auto-refresh off would never see the "New reports" prompt this control
     * promises: it would only appear if they happened to switch tabs and come back. That made the
     * off state indistinguishable from a plain button, which is the state this component exists
     * to improve on.
     *
     * A minute is slow enough to be nearly free and fast enough that the prompt arrives while the
     * reason for it is still interesting. Nothing re-renders on these checks unless the answer
     * changes, and the page is never moved: off means off for refreshing, not for noticing.
     */
    const period = interval > 0 ? interval : NOTIFY_ONLY_SECONDS;
    timer = window.setInterval(() => void check(), period * 1000);

    const onVisible = (): void => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [orgSlug, projectKey, interval, refresh]);

  const spinning = state === "refreshing" || state === "checking";
  const stale = state === "stale";

  return (
    <span className="flex items-center">
      <button
        type="button"
        onClick={() => {
          setState("idle");
          refresh();
        }}
        aria-label={
          stale
            ? "New reports have arrived. Refresh the page."
            : interval > 0
              ? `Refresh now. Checking automatically every ${AUTO_REFRESH_SHORT[interval]}.`
              : "Refresh now. Automatic refresh is off."
        }
        title={
          stale
            ? "New reports have arrived — click to load them"
            : interval > 0
              ? `Checking for new reports every ${AUTO_REFRESH_SHORT[interval]} · click to refresh now`
              : "Automatic refresh is off · click to refresh now"
        }
        className={`flex h-9 items-center gap-1.5 rounded-md border px-2 text-xs transition-colors ${
          stale
            ? /* Amber, not red. Something to look at is not something wrong — and this is the
                 chrome, where red is reserved for failing tests. */
              "border-[var(--color-status-flaky)]/50 bg-[var(--color-status-flaky)]/10 text-[var(--color-status-flaky)]"
            : "border-[var(--color-border-subtle)] hover:border-[var(--color-ink-muted)]"
        }`}
      >
        {/*
         * The arrow spins only while refreshing. `prefers-reduced-motion` collapses every
         * animation to a single 0.01ms iteration app-wide, so for those readers the state is
         * carried by the label changing to "Loading" rather than by movement — which is why the
         * label changes at all rather than the icon alone doing the work.
         */}
        <svg
          viewBox="0 0 16 16"
          className={`size-4 shrink-0 ${spinning ? "animate-spin" : ""}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          aria-hidden
        >
          <path d="M13.5 8a5.5 5.5 0 1 1-1.61-3.89" />
          <path d="M13.6 2.2v2.9h-2.9" />
        </svg>
        {stale ? (
          <span className="whitespace-nowrap">New reports</span>
        ) : interval > 0 ? (
          /* The interval is shown because otherwise nothing on screen says the page is watching,
             and a reader who cannot tell assumes it is not. */
          <span className="font-mono text-[10px] opacity-70">{AUTO_REFRESH_SHORT[interval]}</span>
        ) : null}
      </button>
      {/*
       * A link to the setting rather than a dropdown of intervals.
       *
       * The interval is a preference somebody sets once, not a control they operate; putting five
       * radio options behind a header button spends permanent chrome on a decision made annually.
       * The link is only rendered when auto-refresh is off, where it is the answer to "can this
       * happen by itself?" — once it is on, the badge already says so.
       */}
      {interval === 0 ? (
        <a
          href={settingsHref}
          title="Turn on automatic refresh"
          aria-label="Turn on automatic refresh, in preferences"
          className="ml-1 hidden text-[10px] text-[var(--color-chrome-ink-muted)] underline hover:text-[var(--color-chrome-ink)] lg:inline"
        >
          auto
        </a>
      ) : null}
    </span>
  );
}
