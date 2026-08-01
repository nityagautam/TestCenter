/**
 * Captures the README's UI reference shots into `docs/screenshots/`.
 *
 * A script rather than a folder of hand-taken PNGs, because hand-taken screenshots rot: they
 * are captured at whatever window width the author had, against whatever data was in their
 * database that afternoon, and nobody ever retakes the whole set after a layout change. This
 * runs against the seeded Test Organisation at a fixed viewport, so re-running it after a UI
 * change produces a consistent set rather than one new image among nine stale ones.
 *
 *   pnpm add -Dw playwright && npx playwright install chromium   # once
 *   pnpm dev                                                     # in another terminal
 *   node scripts/capture-screenshots.mjs
 *
 * Navigation waits on `domcontentloaded`, never `networkidle` — the dev server keeps an HMR
 * websocket open, so "the network went quiet" is a condition that never arrives.
 *
 * It signs in through the dev credentials provider, which only exists outside production —
 * so this is a local-only tool by construction, and cannot be pointed at a real deployment
 * by accident.
 *
 * Environment:
 *   BASE_URL   default http://localhost:3000
 *   ORG        default test-organisation
 *   PROJECT    default the first project in the org's list
 *   EMAIL      default admin@testcenter.dev — the account that can see every page
 */
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const ORG = process.env.ORG ?? "test-organisation";
const EMAIL = process.env.EMAIL ?? "admin@testcenter.dev";

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "docs", "screenshots");

/*
 * 1440×900 at 2× — a 14" laptop, which is what this is read on, rendered retina so the 10px
 * chart labels survive GitHub's image scaling. Wider would exercise the 2xl breakpoints that
 * most readers never see.
 */
const VIEWPORT = { width: 1440, height: 900 };
const SCALE = 2;

async function main() {
  await mkdir(OUT, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: SCALE,
    // Pinned so the timestamps and both time axes are identical between runs. Without it the
    // shots carry whichever zone the machine that took them was in.
    timezoneId: "UTC",
    colorScheme: "light",
  });

  /*
   * The theme and timezone cookies are set before the first navigation.
   *
   * Both are read during the server render. Letting the client correct them afterwards would
   * mean the first page captured is the only one showing the pre-correction state, which is
   * exactly the kind of inconsistency this script exists to avoid.
   */
  await context.addCookies(
    ["tc_theme=light", "tc_tz=UTC|UTC"].map((pair) => {
      const [name, value] = pair.split("=");
      return { name, value, url: BASE_URL };
    }),
  );

  const page = await context.newPage();

  // Dev sign-in: one email field, no password. See docs/user-guide.md §2.
  await page.goto(`${BASE_URL}/signin`, { waitUntil: "domcontentloaded" });
  await page.fill('input[name="email"]', EMAIL);
  // Scoped to the form that owns the email field: when Google is configured its button is
  // also a submit and comes first in the document.
  await page.click('form:has(input[name="email"]) button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.startsWith("/signin"), { timeout: 30_000 });

  const projectKey = process.env.PROJECT ?? (await firstProjectKey(page));

  const shots = [
    ["dashboard", `/o/${ORG}`],
    ["project-overview", `/o/${ORG}/p/${projectKey}`],
    ["runs", `/o/${ORG}/runs`],
    ["run-detail", await firstHref(page, `/o/${ORG}/runs`, `a[href*="/runs/"]`)],
    ["tests", `/o/${ORG}/tests`],
    ["test-detail", await firstHref(page, `/o/${ORG}/tests`, `a[href*="/tests/"]`)],
    ["flaky", `/o/${ORG}/flaky`],
    ["reports", `/o/${ORG}/reports`],
    ["help", `/help`],
  ];

  for (const [name, path] of shots) {
    if (!path) {
      console.warn(`skipped ${name} — no matching link found in the seeded data`);
      continue;
    }
    await page.goto(`${BASE_URL}${path}`, { waitUntil: "domcontentloaded" });
    // The charts animate in and the SSE progress banner settles; a fixed pause is cruder
    // than waiting on a selector but survives every page having a different one.
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
    console.log(`captured ${name}.png`);
  }

  await browser.close();
}

/** The first project in the org, so the script works against any seed. */
async function firstProjectKey(page) {
  await page.goto(`${BASE_URL}/o/${ORG}/projects`, { waitUntil: "domcontentloaded" });
  const href = await page.getAttribute(`a[href*="/p/"]`, "href");
  if (!href)
    throw new Error("no projects found — run `pnpm --filter @testcenter/db seed-test-org`");
  return href.split("/p/")[1].split("/")[0];
}

/** Follows the first matching link on a list page, for the detail shots. */
async function firstHref(page, listPath, selector) {
  await page.goto(`${BASE_URL}${listPath}`, { waitUntil: "domcontentloaded" });
  const href = await page.getAttribute(selector, "href");
  return href ?? null;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
