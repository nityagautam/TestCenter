"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Tells the server what time zone the browser is in, once.
 *
 * Renders nothing. It exists because the charts are drawn on the server and the zone is only
 * knowable on the client — see `lib/timezone.ts` for why converting after the fact is not an
 * option for a UTC+5:30 offset.
 *
 * The cookie is written directly rather than through a server action: this is a single
 * non-sensitive value the client already owns, and a round trip would delay the refresh that
 * has to follow it anyway. `router.refresh()` re-renders the server components with the new
 * cookie, which is what turns a first visit's UTC grid into a local one without a reload.
 *
 * It fires only when the stored value is *wrong* — so the steady state is no writes and no
 * refreshes, and a reader who travels or changes their machine's zone gets one correction
 * on their next page load.
 */
export function TimezoneSync({ current }: { current: string }) {
  const router = useRouter();

  useEffect(() => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!zone) return;

    /*
     * The abbreviation comes from the browser, in the browser's own locale.
     *
     * `Asia/Kolkata` formats as "IST" for a reader in India and "GMT+5:30" for one in the
     * United States, because the abbreviation is a property of the locale as much as the
     * zone. Whichever this reader sees elsewhere is the one that belongs on the chart.
     */
    let label = zone;
    try {
      const parts = new Intl.DateTimeFormat(undefined, {
        timeZone: zone,
        timeZoneName: "short",
      }).formatToParts(new Date());
      label = parts.find((part) => part.type === "timeZoneName")?.value ?? zone;
    } catch {
      // Keep the IANA id. A zone that cannot be formatted still buckets correctly.
    }

    const value = `${zone}|${label}`;
    if (value === current) return;

    document.cookie = `tc_tz=${encodeURIComponent(value)}; path=/; max-age=31536000; samesite=lax`;
    router.refresh();
  }, [current, router]);

  return null;
}
