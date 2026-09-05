# Test Center — login and usage guide

How to sign in, what each role can do, and how to work through the app.

> **There is a guide inside the app, at <http://localhost:3000/help>.** It tells the same
> story as a story: one build followed from the moment CI finishes to the moment somebody
> decides whose problem it is, in five acts — a run arrives, something is red, is it always
> red, how are we doing, who can do what. It illustrates itself with the app's own live
> components rather than screenshots, so it cannot go stale, and it renders without a
> session, so it is the link to put in an invitation mail. Open **Support → Help** in the
> sidebar, or press `?` anywhere in the app.
>
> This document is the reference the guide points back to: every role boundary measured
> rather than described, the seeded accounts, the scenario projects, troubleshooting.

---

## Quick reference

**Sign in at <http://localhost:3000/signin> — type the email, no password.**

| Email | Role | What it can do |
| --- | --- | --- |
| `admin@testcenter.dev` | superadmin + owner | everything, plus Platform admin across all organisations |
| `qalead@testcenter.dev` | maintainer | manage projects; **not** members or tokens |
| `sdet@testcenter.dev` | member | upload results, edit tags, quarantine; **not** create projects |
| `qa@testcenter.dev` | viewer | read everything; **nothing** else |
| `future-hire@testcenter.dev` | member *(pending)* | never signed in — activates on first login |

If nothing is running yet:

```bash
brew services start postgresql@17 && brew services start redis
pnpm db:migrate
pnpm --filter @testcenter/db seed-test-org 45   # history
pnpm --filter @testcenter/db seed-users         # the accounts above
pnpm dev
```

Use `pnpm dev`, **not** `pnpm start` — email sign-in is disabled in production builds by
design. Details in §2.

---

## 1. Start the app

```bash
cd /Users/amishra/workspace/code/poc/TestCenter

# Postgres and Redis (installed via brew)
brew services start postgresql@17
brew services start redis

# Build the workspace packages once — they resolve to dist/, so `pnpm dev`
# cannot start without this on a fresh clone
pnpm build

# Apply migrations and provision partitions
pnpm db:migrate

# Seed the Test Organisation with believable history, then the account roster
# (both safe to re-run)
pnpm --filter @testcenter/db seed-test-org 45
pnpm --filter @testcenter/db seed-users

# Run web + worker together
pnpm dev
```

Open <http://localhost:3000>. You will be redirected to `/signin`.

> **Run it with `pnpm dev`, not `pnpm start`.** Local email sign-in is disabled when
> `NODE_ENV=production`, which is what `next start` sets. That is a deliberate safety
> guard, not a bug — see §3.

---

## 2. There are no passwords — and that is on purpose

**Local sign-in asks for an email address only.** No password field, no password to
remember or share.

That is a deliberate decision, not an omission:

- A password we invented for local accounts would be a *fake* security boundary. Anyone
  who can reach `localhost:3000` can already reach the database directly, so a password
  would protect nothing while implying it protected something.
- It makes multi-user testing practical. Verifying that one organisation cannot read
  another's results needs several accounts; creating several real Google accounts to
  check a `WHERE` clause is absurd.
- It cannot leak into production. The provider is registered only when
  `NODE_ENV !== "production"`, so a deployed build has no such login at all.

**In production, identity comes from Google** (`AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`).
Google holds the password; Test Center never sees or stores one. The only credential this
app ever stores is a **sha256 hash of a CI API token**.

If you specifically want password-protected local accounts, say so — it is a small
addition, and worth doing deliberately rather than by accident.

---

## 3. Signing in

1. Go to <http://localhost:3000/signin>
2. Under **Development sign-in**, type one of the emails below
3. Optionally type a display name
4. Press **Sign in**

That is the whole flow. First sign-in creates the account; later sign-ins reuse it.

### Accounts

All of these already have access to **Test Organisation** (4 projects, 45 days of
history, 330 runs, ~14,500 results). Type the email, leave everything else blank.

| Email | Role | Use it to see |
| --- | --- | --- |
| `admin@testcenter.dev` | **superadmin + owner** | everything, plus the Platform admin area across all organisations |
| `qalead@testcenter.dev` | **maintainer** | creating and editing projects, but *not* managing members or tokens |
| `sdet@testcenter.dev` | **member** | uploading results and tagging, but *not* creating projects |
| `qa@testcenter.dev` | **viewer** | read-only — Upload and Members are hidden, and refused server-side |
| `future-hire@testcenter.dev` | member *(pending)* | a grant made before the account existed — signing in activates it |

The roster lives in `packages/db/scripts/seed-users.ts` and is idempotent, so it survives
a database reset:

```bash
pnpm --filter @testcenter/db seed-users
```

### Superadmin

`admin@testcenter.dev` is **both** the organisation owner and a platform administrator.
Those are two separate things:

- **owner** is a role *within* Test Organisation — granted by a membership row.
- **superadmin** (platform admin) spans *all* organisations — granted only by listing the
  address in `TESTCENTER_ADMIN_EMAILS` in `.env`.

Platform status is re-read from `.env` on **every** sign-in, deliberately outside anything
the database or a seed script can set. Removing an address revokes it at the next login,
and no action inside the app can grant it — otherwise "superadmin" would be escalatable
from within the product it protects.

Whoever else is listed in `TESTCENTER_ADMIN_EMAILS` has the same reach. Read the current
list straight from `.env` rather than from here — a roster copied into prose is wrong the
first time somebody edits that variable.

Sign in as `admin@testcenter.dev` and you get **Platform admin** in the left nav: every
organisation, with the ability to grant access to ones you are not a member of. That is
how a new user gets into an existing team. The page keeps the normal Test Center header and
sidebar, and its **New organisation** action opens the same in-app creation page as the organisation
switcher.

### Try any address at all

Type any valid email — e.g. `you@example.com` — and you get a brand-new account with no
access, which is exactly what a real new user experiences. You will be offered a choice:
create your own organisation, or skip and be told what to ask an administrator for.

`/onboarding` is specifically this no-organisation flow. Once you already belong to an
organisation, use **Org → New organisation** (or `/organizations/new`) to create another team
space without leaving the application shell. If you skipped onboarding and later change your mind,
the **Create an organisation** action on the no-access page takes you back to onboarding.

---

## 4. Roles: what each one can do

Organisation membership grants access to **every project** in that organisation. Roles
control what you can *do*, and are ordered — each includes everything below it.

Names are editable without changing identity. Organisation admins rename the organisation under
**Settings → Organisation**; project maintainers use **Projects → Settings** or the selected
project's Settings section. The organisation slug and project key are deliberately read-only
because shared URLs and CI publishes use them.

| | viewer<br>`qa@` | member<br>`sdet@` | maintainer<br>`qalead@` | admin | owner<br>`admin@` |
| --- | :-: | :-: | :-: | :-: | :-: |
| Dashboard, runs, tests, flaky, projects | ✓ | ✓ | ✓ | ✓ | ✓ |
| Upload results | | ✓ | ✓ | ✓ | ✓ |
| Edit tags, quarantine tests | | ✓ | ✓ | ✓ | ✓ |
| Create projects / edit project settings | | | ✓ | ✓ | ✓ |
| Rename a run | | | | ✓ | ✓ |
| Record a verdict on a run | | | | ✓ | ✓ |
| **Delete a run** | | | | ✓ | ✓ |
| Archive **and restore** projects | | | | ✓ | ✓ |
| Manage members and API tokens | | | | ✓ | ✓ |
| Platform admin area | | | | | superadmin only |
| **Delete a project permanently** | | | | | ✓ |
| Delete the organisation | | | | | ✓ |

### Archiving, restoring, deleting a project

Three different things, deliberately kept apart:

| Action | Who | What happens | Reversible |
| --- | --- | --- | --- |
| **Archive** | admin, owner | The project disappears from lists and dashboards and stops accepting uploads. Every run and result is kept. | Yes |
| **Restore** | admin, owner | Puts it back exactly as it was. | — |
| **Delete** | **owner only** | Removes the project with every run, result and API token under it. | **No** |

Archived projects are listed under **Archived** at the bottom of *Projects*, each with a
**Restore** button. That list is the point: an archive nobody can browse is a delete with
extra steps, and archiving used to hide the project from every list *including* that one —
so the only route back was to remember and type its settings URL. Its other pages stay 404
while archived, since an archived project should not be serving dashboards; settings is the
one exception, because settings is where restoring happens.

Deletion is owner-only and needs the project key typed by hand. It is the only action on a
project that destroys history, and there is nothing to click afterwards to undo it — so if
the intent is just "we stopped using this", archive instead.

---

### Measured, not intended

The table above describes capabilities. This one is the raw result of signing in as each
account and requesting each path — useful when you want to know precisely where a role
stops:

| Path | owner | maintainer | member | viewer |
| --- | :-: | :-: | :-: | :-: |
| `/o/:org` (dashboard) | ✓ | ✓ | ✓ | ✓ |
| `/o/:org/runs` | ✓ | ✓ | ✓ | ✓ |
| `/o/:org/tests` | ✓ | ✓ | ✓ | ✓ |
| `/o/:org/flaky` | ✓ | ✓ | ✓ | ✓ |
| `/o/:org/projects` | ✓ | ✓ | ✓ | ✓ |
| `/o/:org/projects/new` | ✓ | ✓ | refused | refused |
| `/o/:org/p/:key/upload` | ✓ | ✓ | ✓ | **refused** |
| `/o/:org/p/:key/settings` | ✓ | ✓ | refused | refused |
| `/o/:org/settings` | ✓ | **refused** | refused | refused |
| `/o/:org/settings/members` | ✓ | **refused** | refused | refused |
| `/o/:org/settings/tokens` | ✓ | **refused** | refused | refused |
| `/organizations/new` | ✓ | ✓ | ✓ | ✓ |
| `/admin` | ✓ *(superadmin)* | refused | refused | refused |

"refused" is a page explaining *"requires the admin role, yours is viewer"* — not a 500,
and not a silent success. Reaching a forbidden URL directly is safe and self-explanatory.

Two things worth knowing:

- **The UI hides what your role cannot do, and the server refuses it independently.**
  Hiding a button is a convenience; the server check is the enforcement. Reaching a
  forbidden page directly by URL gives a clear "requires the *admin* role, yours is
  *viewer*" page — not a 500, and not a silent success.
- **An organisation always keeps at least one owner.** Removing the last one is refused,
  because an organisation with no owner cannot be administered again from inside the app.

---

## 5. Getting people into an organisation

There are no emails to send. Two routes:

**An admin or owner grants access** — Settings → Members, type the email, pick a role,
Grant. If that person has never signed in, the grant is **held** and applied
automatically at their first login. It shows as `pending` until then.

**A platform admin grants access to any organisation** — the Platform admin area lists
every organisation; pick one and grant access there. This works for organisations the
admin is not a member of.

Access takes effect immediately. The recipient can just reload.

### Changing someone's role

Three routes, depending on what you have in front of you:

**In the app, within one organisation** — Settings → Members, enter the *same* email with
a different role and press Grant. A repeat grant is treated as a role change, not an
error, which is what you actually want when promoting someone.

**In the app, across organisations** — Platform admin → pick the organisation → grant with
the new role. Works even for organisations you are not a member of.

**In code, for the seeded roster** — edit `ROSTER` in
`packages/db/scripts/seed-users.ts`, then:

```bash
pnpm --filter @testcenter/db seed-users
```

Prefer this for the standing test accounts: it is idempotent, survives `pnpm db:reset`,
and the roster stays reviewable in the repository rather than living only in one database.

### Adding a completely new person

1. Settings → Members (or Platform admin) → type their email → pick a role → Grant.
2. They sign in. If the account did not exist, it is created and the grant binds to it.

There is nothing to send them beyond the URL. Until they sign in they show as `pending`;
`future-hire@testcenter.dev` exists in the seed so you can watch this happen.

### Making someone a superadmin

Not doable from inside the app, on purpose. Add the address to
`TESTCENTER_ADMIN_EMAILS` in `.env`, restart, and have them sign in again:

```bash
TESTCENTER_ADMIN_EMAILS=admin@testcenter.dev,someone.else@example.com
```

The list is re-read at **every** sign-in, so removing an address revokes the privilege at
their next login. If it could be granted by a database write, then anyone who could write
to the database — including a seed script or a compromised app — could mint one.

---

## 6. Working through the app

### Keyboard

| Key | Does |
| --- | --- |
| `⌘K` / `Ctrl-K` | Command palette — jump to a project, test or page |
| `↑` `↓` | Move through palette results |
| `↵` | Open the highlighted result |
| `esc` | Close the palette, a dropdown, or the mobile nav |
| `[` | Collapse or expand the sidebar |
| `?` | The in-app guide at `/help` |

The palette searches tests by name fragment against the database, so `case_7` finds every
matching test across all projects with its status. Collapsed, the sidebar keeps the
failing and flaky counts as badges and exposes icon labels as tooltips — it narrows to icons
without losing the signal. Help lives under **Support** and remains available through `?`.

### Theme

The control beside Search cycles **follow system → light → dark**. "Follow system" is a
real setting, not the absence of one: choose it and the app tracks your OS when it
switches at sunset. The choice is stored server-side and applied during rendering, so
there is no flash of the wrong theme on load.

### Where things live

Scope is in the URL, so every link is shareable and unambiguous:

```
/o/test-organisation                     organisation dashboard
/o/test-organisation/runs                run list  (all projects)
/o/test-organisation/tests               test search (all projects)
/o/test-organisation/tests/412070        one test's full history
/o/test-organisation/flaky               flaky leaderboard
/o/test-organisation/reports             reports — a question with blanks, answered
/o/test-organisation/p/checkout-web      one project's dashboard
/o/test-organisation/p/checkout-web/reports   the same questions, one project
/help                                    the in-app guide (no sign-in needed)
```

Pasting a link into Slack lands the recipient on exactly what you were looking at,
provided they have access.

Test Center also remembers the last organisation and project you selected. Opening Help, visiting
the root page, or returning after sign-in takes you back to that scope; a shared URL that names a
different organisation or project still wins. Choosing **All projects** is the explicit way to
clear the remembered project.

### The dashboard

Headline numbers first — pass rate, runs, tests, failing, flaky, quarantined — then the
two lead charts, then a row of trends, then two rows of detail and two named lists.

The organisation dashboard and project overview offer **1, 7, 15, 30, 45 and 90 day**
windows. Seven days remains the default; choose **1d** when a busy current day contains too
many executions to read clearly in a wider window. The selected range is stored in `?days=`.

**Execution over time is one point per run, not per day.** A daily rollup averages the
executions inside it, so a single run at 40% beside four at 100% reads as a mildly bad day
and the bad run disappears. Every execution in the window is a point, oldest left; hover for
the run's name, branch and counts, and click to open it. Under it runs the **verdict
ribbon** — one cell per run, coloured by its verdict — which answers the question the chart
provokes: *we had a bad week, but was any of it us?* A cluster of red points that is entirely
orange underneath is an environment problem. The ribbon only appears once something in the
window has been reviewed.

**"When runs happen" is a punchcard** — hour of day across, weekday down, with the window's
days folded onto seven rows so four Tuesdays stack into one. It answers a question no time
series can: a scheduled suite is a vertical band, a weekly release is one bright cell, and
ad-hoc publishing is scatter through office hours. A nightly job that silently stopped
leaves a hole in its band. Shading is by quantile rather than by fraction of the busiest
hour, so one enormous nightly does not flatten everything else into the palest step — which
is why the legend says *fewer → more* instead of printing numbers on it. Every exact count
is one hover away.

**The last run** is a donut beside the pass-rate trend: all four outcomes, always listed,
even at zero. Hover a slice and the centre reports it. The pass-rate trend and **CI time per
run** chart plot every published run separately, so a bad or slow execution cannot hide
inside a daily average. CI time uses bars for exact runs and a line for the trailing five-run
average, on one shared duration axis.

Two charts carry a **view toggle** which changes the *question*, not the drawing:

| Chart | Toggle | The two questions |
| --- | --- | --- |
| Execution over time | counts / share | "how much did we run" vs "what proportion failed" |
| Pass rate | over time / by branch | "is the org healthy" vs "is *main* healthy" |

Below them: **slowest tests** (p95, because a test that is usually fast and occasionally
slow is the one worth finding), **failure concentration** (one bad test or systemic?), and
the **flake score distribution**.

The toggles live in the URL, so a view is shareable and survives a reload.

The runs list also filters by the latest human verdict: Pass, Product bug, Infra, Flaky,
Investigating, or TODO / unreviewed. The exact URL values are `pass`, `product-bug`, `infra`,
`flaky`, `investigating` and `todo`. TODO includes only runs ready for review, not uploads
that are still pending or parsing. Because filtering uses the newest append-only verdict, a
run corrected from Infra to Product bug appears only under Product bug. The selection lives
in `?verdict=` like the other filters, so it survives search, facets and pagination and the
narrowed review queue is shareable.

**Times follow your machine.** Every timestamp, and both time axes, render in your own zone
and say which one — `IST`, `PDT`, `UTC`. The very first page load renders in UTC and
corrects itself once the browser has reported its zone.

**"Flakiest tests" and "Most-failing tests" are deliberately separate lists.** A test
that always fails is *broken*, not flaky, and scores 0 on flakiness. Mixing them is what
makes most flake dashboards useless. In the seeded data `test_case_7` fails 76 times out
of 89 runs and appears only in "most-failing"; the flaky list holds tests that pass
*inconsistently*.

**Failures by category** sorts every failure into a standard kind — assertion failed, code
exception, timeout, network, auth, element, data — read from the error class in the report. It
needs no triage, so it is populated from the first upload.

The classification happens once, at ingest, and is stored on the result. It reads, in order:
the error **class** (`AssertionError`, `java.net.SocketException`), then an actual-vs-expected
pair, then keywords — across the `type`, the `message` **and the failure body**.

All three, because reporters disagree about where the error goes. Playwright writes the *test's
identity* into the `message` attribute and leaves the error in the **body**; Surefire and pytest
put it in `type` and `message`. Measured on real projects, 83% of one project's errors were
recoverable only from the body while another's were 99.7% in `type` — same rules, opposite
reporters. A dashboard that reads one field works for one framework and silently fails for the
next.

The body is cleaned first: the location/step lines and the numbered source excerpt are removed,
because the excerpt renders whatever the failing line *calls*, so leaving it in makes every
failure look like whatever function happened to be on that line. A raw substring search over the
uncleaned text filed 91% of one real suite as assertions, auth failures included.

Each failure also records **which field its error came from**, which diagnoses the *reporter*
rather than the test: all-`stack` means a reporter putting errors in the body, and `none` means
it sent no error at all. That difference decides whether the fix is a rule here or a change
upstream in CI.

**Top failures** lists the errors themselves, grouped by the extracted message — so one root
cause hitting forty tests is one row that reads *"SEO import job did not reach a terminal status
before polling timed out — 50"* rather than forty rows of a scenario title.

Two categories are worth knowing about:

- **Code exception** is kept apart from **Assertion failed** because they mean opposite things. An
  assertion failure is the test working — it checked something and the answer was wrong. A code
  exception is the test or product falling over before it could check anything, so the result is
  not "the feature is broken" but "we do not know". Both arrive as type `Error`.
- **No error reported** means the report named the test but not the failure, which some reporters
  do when they cannot extract an error. That is a gap in what CI sent — fixable upstream — rather
  than a gap in the rules, which is what "Other" means.

Toggle the card to **triaged** to see the same failures grouped by what a person concluded about
each *cause* instead. Categorise a cause from any test's **Distinct failure modes** list; the
category attaches to the failure signature, so every later occurrence inherits it — including in
tests nobody has opened yet. Corrections are recorded rather than overwritten, so "who called
this infra, and when" stays answerable. Needs admin. "Not yet triaged" is always shown, so the
chart cannot be mistaken for a complete account of the failures.

Hover any chart for its per-run tooltip. Use the day buttons to change the window — 1 / 7 /
15 / 30 / 45 / 90 on both dashboards, with 7 days still the default. A project dashboard
also states **when the suite last ran**, with a link to that run.

### Exporting data

The organisation dashboard and project overview have **Export CSV** beside the day range. It
downloads one row per run in the selected window, as data rather than as a document: durations
stay in integer milliseconds and pass rates stay bare numbers, so the columns can be summed,
averaged and charted in a spreadsheet. Each row carries the run id, project, ISO-8601 start and
finish timestamps in UTC, name, branch, full commit sha, PR number, environment, framework,
status, verdict, the outcome counts, pass rate and CI job URL.

The totals reconcile exactly with the headline tiles above the charts — the CSV applies the same
window predicate, so summing `tests_total` gives the "Tests executed" figure. If a window holds
more runs than the export cap, the filename says so rather than the file quietly being partial.

### Finding a test

Go to **Tests** and type a fragment — `case_3`, `payment`, `refund`. Matching is
substring-based, so a fragment from the middle of a name works.

Then narrow with the filter row: **Failing**, **Flaky**, **Passing**, **Skipped**,
**Quarantined**; by project; and sort by most failures, flakiest, or slowest. Every
filter is in the URL, so a useful view can be bookmarked.

### Reading a test's history — the main event

Open any test — from the Tests list, or by clicking the **outcome strip** in the Recent
column of a run's result table. That strip is the last handful of executions at a glance
(`✓`/`✕` glyphs, newest on the right); the whole strip is one link to the full history. You
get:

1. **Stat tiles** — fail rate, runs, failures, flake score, average and p95 duration.
2. **Execution history strip** — one cell per run, oldest on the left, `✓` pass, `✕`
   fail, `!` error, `–` skipped, amber for "passed only on retry". Hover for the date,
   branch and duration; click to open that run.
3. **Distinct failure modes** — this is the part worth understanding. If a test failed
   15 times, the first question is *"one bug or several?"*. Failures are grouped by a
   signature computed from the error type and the top frames of your own code, so you
   see e.g. `ConnectionError ×11` and `ValidationError ×10` as two separate problems.
   Click a mode to filter the list below to only those failures.
4. **Failure history** — every failure in full: branch, commit, duration, attempts, the
   message, the stack trace, and captured stdout/stderr. This is the "show me all three
   failures" view.

**Quarantine** (member and above) marks a known-flaky test so it stops dominating
dashboards while staying visible and still reported. It is not skipping or deleting.

### Uploading results

**From the browser** — pick a project → Upload → drag JUnit XML files in, optionally set a
**run name**, branch, environment and tags, then Upload. You land on the run and watch it
parse live.

Naming the run at upload is worth the two seconds: it is what every list, link and report
identifies the run by afterwards. Drop several files at once and each becomes its own run,
with the file name appended to the name you typed so they stay distinguishable.

**From CI** — one command:

```bash
curl -X POST "http://localhost:3000/api/v1/ingest?project=checkout-web&branch=$BRANCH&tag=suite:regression" \
  -H "Authorization: Bearer $TESTCENTER_TOKEN" \
  -F "report=@reports/junit.xml"
```

Get a token from **Settings → API tokens**, or from the screen shown right after you
create a project. A token is displayed **once** — only its hash is stored.

In GitHub Actions, use `if: always()` on the publish step. Without it the step is skipped
exactly when tests fail, which is when you most want the results.

That one-command endpoint accepts reports up to **32 MiB** by default, because it buffers the
upload in the web process. A larger report returns HTTP 413 with `too_large_for_single_shot`,
and the error body carries `limitBytes`, `actualBytes` and the alternative endpoint as fields —
so a CI wrapper can branch on it rather than parsing the message:

```bash
# Raise the server-side ceiling (must stay <= MAX_ARTIFACT_BYTES)
MAX_SINGLE_SHOT_BYTES=134217728
```

Raising it costs memory: peak RSS runs at roughly 7x the limit while a request is in flight, so
budget for `concurrent uploads x limit x 7`. For reports that are routinely large, the answer is
the three-step flow instead — `POST /api/v1/runs` returns presigned URLs and the bytes go
straight from CI to object storage, bounded only by `MAX_ARTIFACT_BYTES`.

Supported today: **JUnit / xUnit XML** — pytest `--junitxml`, Playwright's junit
reporter, Maven Surefire, Gradle, jest-junit, Cypress, Robot, TestNG.

### Run actions: rename, tags, verdict, delete

Every action on a run lives behind the **⋯** button at the top right of the run — and on
each row of the runs list, so you do not have to open a run to act on it. The menu only
lists what your role permits, and renders nothing at all if that is nothing.

| Action | Who | Notes |
| --- | --- | --- |
| Rename… | admin | Empty clears the name, and the heading falls back to the framework |
| Edit tags… | member | Chips with removal; add as `key:value` |
| Add / change verdict… | admin | See below |
| Delete run… | admin | Requires typing the run's name to confirm |

Deleting asks you to **type the run's name** rather than clicking "yes". It is the only
action here that destroys evidence — the results, their stack traces and the uploaded report
all go, and trends are recalculated without them. Typing the name also makes it impossible
to delete the run above the one you meant.

### Quality gates — the automatic go/no-go

Every run is checked the moment it finishes, and the result appears as a `gate` badge beside the
run's status and its verdict.

**Out of the box, two checks, and no configuration required.** A run must have *finished*, and it
must not break a test that was passing. Both were chosen because they need no local knowledge to
be right; everything else (a pass-rate floor, a cap on failures) is a number only your team can
set, so nothing guesses one.

Why those two:

- **Must have finished.** A suite that dies halfway reports *fewer* failures than one that ran, so
  without this check every threshold is passed by crashing.
- **No new failures.** Measured against each test's own recent history — the last five times it
  ran — and not against the previous run. Projects commonly receive several unrelated suites, so
  comparing a nightly regression against a smoke test would report every test the smoke run did
  not contain as newly broken. Measured on real data, the run-to-run version reported 264 new
  failures where the true number of regressions was zero.

**Advisory first.** A new gate reports but does not block: the badge says `gate ! would fail` and
CI is unaffected. Switch it to *Stop the build* under **Settings → Quality gate** once the numbers
are worth arguing with. A gate that goes straight to blocking spends its first week failing builds
for known flakes, and the lasting result is a team that turned it off.

**Three levels.** The organisation sets the default; a project can tighten it or switch it off for
itself; a branch can override again, so `main` can demand no regressions while feature branches do
not. Settings pages show what is in force and where each part came from. Editing the
organisation-wide gate is owner-only — it is the floor under every project at once, including
projects whose owners are not in the room — while everyone can read it, because "why was my build
gated" is a question the people who cannot change the policy need answered.

**A gate is not a verdict.** The gate is what the rules computed; the verdict below is what a
person concluded. They are allowed to disagree, and a failed gate with a `pass` verdict is the
ordinary shape of an accepted known failure.

Existing history is not judged automatically. To evaluate runs that predate the feature, or to
re-judge everything after changing a policy:

```bash
pnpm --filter @testcenter/db backfill-gate            # dry run
pnpm --filter @testcenter/db backfill-gate -- --apply
pnpm --filter @testcenter/db backfill-gate -- --apply --force   # re-judge runs already scored
```

To see what a policy *would* have said before switching it on:

```bash
pnpm --filter @testcenter/db gate-dry-run -- --project=orders-api --limit=50
```

### Verdicts — why a run looked the way it did

A verdict is the one thing Test Center cannot work out for itself. "96%, 2 failing" does not
distinguish a real regression from a UAT cluster being down, and that distinction decides
who gets handed the problem.

| Verdict | Means | Goes to |
| --- | --- | --- |
| **Pass** | Reviewed; the failures are known and tolerated | nobody |
| **Product bug** | A genuine regression | a developer |
| **Infra** | Environment or data, not the code under test | whoever owns the environment |
| **Flaky** | Non-deterministic, so not a real signal | the test's author |
| **Investigating** | Seen, not yet judged | you, later |

A complete, partial or failed run nobody has judged shows a blue dashed **TODO** badge — so
"what still needs review?" is answerable at a glance from the runs list, the dashboards and
the run itself. Pending and parsing runs are not ready for review and show no TODO. TODO is
never stored; it simply means no verdict exists yet, which is why it is distinct from
*Investigating* (someone looked and has not finished).

Verdicts are **append-only**. Changing your mind records a new entry and the previous one
stays in the **verdict log** on the run page, marked superseded — because "who called this
infra, and when?" has to stay answerable after the call changes. The log shows five entries
and scrolls.

They deliberately **do not** change any number: pass rates, trends and flake scores ignore
verdicts entirely, so no chart shifts meaning because someone labelled a run. Filtering the
runs list by the latest verdict changes which rows are shown, not how any metric is computed.

### Creating a project

Projects → **New project**. Name it; the key is derived and is what CI sends, so keep it
short and stable — renaming it later means updating every pipeline, which is why the key
is not editable afterwards.

A CI token is minted at the same moment and shown with a copy-paste recipe. That is
intentional: the minute after creating a project is when you are actually ready to wire
up a pipeline.

---

## 7. Try the interesting cases

| To see | Do this |
| --- | --- |
| Roles actually enforced | Sign in as `qa@testcenter.dev` (viewer). Upload and Members vanish from the nav; visiting `/o/test-organisation/settings/members` explains why rather than erroring. |
| Maintainer's ceiling | Sign in as `qalead@testcenter.dev`. Projects can be created and edited, but Members and API tokens are refused — maintainer sits below admin. |
| A pending grant activating | Sign in as `future-hire@testcenter.dev` — never signed in before, and lands straight in Test Organisation with member access because the grant was waiting. |
| A brand-new user | Sign in as any unknown address. You get the onboarding choice, then the "no access yet" page with your address to hand to an admin. |
| Tenant isolation | As a new user, create your own organisation, then try `/o/test-organisation` directly. You are redirected away — and a nonexistent slug behaves identically, so slugs cannot be probed. |
| Cross-org granting | Sign in as `admin@testcenter.dev`, open Platform admin, select any organisation and grant an address access — including organisations you are not a member of. |
| Multiple failure modes | Open the test linked from "Most-failing tests" in `payments-service` — it has two distinct signatures. |
| A duration regression | Test search → sort by **Slowest**. The seeded `slowing` tests climb steadily. |

### The scenario projects

Test Organisation carries four projects whose only purpose is to make awkward states
reachable, so UI work does not depend on happening to have the right data. Regenerate them
at any time with:

```bash
pnpm --filter @testcenter/db seed-scenarios            # 5,000-test scale run
pnpm --filter @testcenter/db seed-scenarios test-organisation 20000   # larger
```

The script replaces its own projects rather than appending, so re-running is safe.

| Project | What is in it |
| --- | --- |
| `Scenarios · Run states` | Every status the UI can render: a **pending** run awaiting upload, one stuck in **parsing** (the live progress banner and SSE stream), a **failed** import with a malformed-XML warning, a **partial** import carrying three warnings, an all-green run, an all-red run, a skip-heavy run, a run of errors rather than failures, retries that recovered and retries that never did, a four-way **sharded** run sharing a `run_group_id`, a pull-request run with a PR number and CI job URL, a re-run at attempt 3, an **empty** report that parsed to nothing, and a run with ten tags. |
| `Scenarios · Awkward content` | The things that break layouts: a 180-character test name, a deep suite path, a 60-frame stack trace, 120 lines of captured stdout, CJK / Arabic / Cyrillic / emoji in names and messages, parameterised names, a 0 ms test beside a 32-minute one, a failure with a stack but no message, stderr-only output, result-level tags, and a test with **three** distinct failure signatures. |
| `Scenarios · Scale` | One run of 5,000 results across 40 suites — the case the run result table has to survive until it is virtualized. |
| `Scenarios · No data` | A project with no runs at all, for the empty state. |

Two tests are left quarantined so the Quarantined filter and badge have subjects.

### Seeding from your own reports

`EXT API TEST` is populated from real Cucumber-JVM and Surefire reports rather than from
invented data:

```bash
pnpm --filter @testcenter/worker seed-from-junit ~/Downloads/JUnitTestResults \
  --project=ext_api_test --days=90 --runs-per-day=3 --seed=7 --replace
```

The reports are read as a **corpus** — every suite, feature, scenario name, duration,
assertion type, failure message and stack trace comes from them verbatim — and then
replayed across clusters, branches, environments and days. Four reports would otherwise be
four runs, and almost nothing this product does is visible in four runs: flake scores need
repetition, failure-mode grouping needs the same test failing differently over time, and
the trend charts need a time axis.

What the script synthesises, and does not pretend otherwise: which tests fail on which
day, retry flakiness, regressions and their fixes, timeouts, the occasional skipped
feature or failed import, and the CI metadata the reports do not carry.

It is deterministic — the same directory and `--seed` produce the same history — so a UI
change can be judged against a fixed dataset. `--replace` clears the project's runs first,
including the test-case rows left with no results.

**Captured output is scrubbed of credentials on the way in.** The source reports log a live
bearer token on every scenario (`>>>>>> TOKEN::: oa-…`), and replaying them verbatim would
have copied one real credential into thousands of rows. Note that this protects the
*generated* data only: uploading a report through the API or the browser stores its output
as sent, so a report containing a secret puts that secret in the database.

---

## 8. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Sign-in form shows no email field | You are running a production build. Use `pnpm dev`. |
| "No sign-in method configured" | Neither Google credentials nor dev login is available. Use `pnpm dev`, or set `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`. |
| Signed in but "No organisations yet" | Expected for a new account. Create one, or have an admin grant access to yours. |
| Google sign-in rejected | `AUTH_ALLOWED_DOMAINS` restricts which email domains may sign in. Clear it to allow any. |
| No Platform admin link | Your address is not in `TESTCENTER_ADMIN_EMAILS`. Add it and sign in again. |
| Postgres will not start | See the Homebrew `postgresql@17` lib-link repair in the README. |
| A run sits at "parsing" | The worker is not running. Start it with `pnpm dev`; runs stuck beyond 30 minutes are failed automatically with an explanation. |
| Uploads fail with ENOENT | Web and worker disagree on `BLOB_LOCAL_DIR`. Check `curl localhost:3000/api/health?deep=1` — it prints the resolved path. |

---

## 9. Health check

```bash
curl localhost:3000/api/health?deep=1
```

Reports Postgres latency, ingest queue depth, whether the current month's partition
exists, and the resolved object-storage path. Queue depth is the metric that moves first
when something is wrong.
