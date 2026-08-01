import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";

/**
 * The viewer's time zone, carried in a cookie.
 *
 * A server component cannot ask the browser what zone it is in, and this app renders its
 * charts on the server. The same trick the theme and sidebar use applies: the client writes
 * what it knows to a cookie, the server reads it during render, and the first painted frame
 * is already correct on every load after the first.
 *
 * **Why not convert on the client instead.** The obvious alternative is to bucket by UTC hour
 * in SQL and shift the buckets in the browser. That is wrong for half the world: India is
 * UTC+5:30, so the 02:00–03:00 UTC bucket is 07:30–08:30 local and belongs to *two* local
 * hours at once. Nepal (+5:45) and the Chatham Islands (+12:45) are worse. Bucketing has to
 * happen in the target zone, which means the target zone has to reach the query.
 *
 * The cookie carries the label as well as the zone. Deriving "IST" from "Asia/Kolkata" on the
 * server means trusting whichever ICU data that runtime shipped with — the same call returns
 * "GMT+5:30" under one locale and "IST" under another. The browser already knows what its own
 * zone is called, so it says so rather than making the server guess.
 */
export const TIMEZONE_COOKIE = "tc_tz";

export interface ViewerTimeZone {
  /** IANA identifier, e.g. `Asia/Kolkata`. Safe to hand to Postgres. */
  zone: string;
  /** What to print, e.g. `IST`. Never used for computation. */
  label: string;
}

/** UTC, for the first render before the cookie exists and for anything that cannot resolve. */
export const DEFAULT_TIME_ZONE: ViewerTimeZone = { zone: "UTC", label: "UTC" };

/**
 * Parses `Asia/Kolkata|IST`, rejecting anything that is not a real zone.
 *
 * The value reaches `AT TIME ZONE` in a query. postgres.js parameterises it, so this is not
 * the injection boundary — but an unrecognised zone makes Postgres raise rather than return
 * rows, which would take the whole dashboard down over a malformed cookie. `Intl` is the
 * authority on what the database will accept, so it is asked first.
 */
export function readViewerTimeZone(raw: string | undefined): ViewerTimeZone {
  if (!raw) return DEFAULT_TIME_ZONE;

  const [zone, label] = raw.split("|");
  if (!zone) return DEFAULT_TIME_ZONE;

  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
  } catch {
    return DEFAULT_TIME_ZONE;
  }

  // The label is displayed, so it is constrained to what a zone abbreviation can look like
  // rather than trusted: "IST", "GMT+5:30", "PDT".
  const safeLabel = label && /^[A-Za-z0-9+:\-. ]{1,12}$/.test(label) ? label : zone;
  return { zone, label: safeLabel };
}

/**
 * The viewer's zone for the current request.
 *
 * Wrapped in React's `cache`, like `currentViewer`, so a page whose header, table and three
 * charts all need it reads the cookie once rather than five times.
 */
export const viewerTimeZone = cache(async (): Promise<ViewerTimeZone> => {
  const store = await cookies();
  return readViewerTimeZone(store.get(TIMEZONE_COOKIE)?.value);
});
