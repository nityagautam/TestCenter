"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Back — to wherever you actually came from, or to the list if that was nowhere.
 *
 * A plain `router.back()` is wrong on a deep link. Half the traffic to a run page arrives
 * from Slack, and there the previous entry is whatever the reader was doing before this tab
 * existed: another site, a new-tab page, or nothing at all. Sending them there is either a
 * dead end or, worse, out of the application entirely.
 *
 * So the control resolves what it means on mount:
 *
 * - `document.referrer` is same-origin → they navigated here from inside the app, and
 *   `back()` returns them to the exact list, scroll position and filters they left. That is
 *   the thing a link to the parent list cannot reproduce, and the reason to prefer history.
 * - anything else → push the fallback, which is the list this page belongs to.
 *
 * Rendered as a link rather than a button when it will navigate to the fallback, so
 * middle-click and "open in new tab" behave. The history case has to be a button: there is
 * no href for "wherever you were".
 *
 * `mounted` guards the decision because `document.referrer` does not exist during the server
 * render. Until then it renders the fallback form — correct, just not yet clever — which
 * keeps the server and client markup identical and avoids a hydration mismatch on a control
 * that sits at the top of every detail page.
 */
export function BackLink({ fallbackHref }: { fallbackHref: string }) {
  const router = useRouter();
  const [useHistory, setUseHistory] = useState(false);

  useEffect(() => {
    if (typeof document === "undefined" || !document.referrer) return;
    try {
      const from = new URL(document.referrer);
      // Same origin *and* not this very page: a reload makes the referrer itself, and
      // "back" to where you already are is a no-op that looks broken.
      if (from.origin === window.location.origin && from.href !== window.location.href) {
        setUseHistory(true);
      }
    } catch {
      // A malformed referrer is not worth a crash. The fallback still works.
    }
  }, []);

  const className =
    "flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 -ml-1.5 hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-ink)]";

  const body = (
    <>
      <svg
        viewBox="0 0 16 16"
        className="size-3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M9.5 3.5 5 8l4.5 4.5" />
      </svg>
      Back
    </>
  );

  if (!useHistory) {
    return (
      <a href={fallbackHref} className={className}>
        {body}
      </a>
    );
  }

  return (
    <button type="button" onClick={() => router.back()} className={className}>
      {body}
    </button>
  );
}
