# Bug register and improvement backlog

Two lists. **Part A** records defects that were found and fixed, with the root cause, so
they are recognisable if they recur — most of them failed *silently*, which is why they
are written down rather than just closed. **Part B** is outstanding work.

Last updated 2026-07-29.

---

## Part A — found and fixed

Each entry: what broke, why it was dangerous, and what the fix was.

### A1. drizzle mutates the postgres.js instance, breaking `Date` binding

**Symptom** Every bulk insert failed with `Buffer.byteLength received an instance of Date`.

**Cause** `drizzle(sql)` installs its own type handling on the postgres.js client it is
given. Afterwards the raw template path on that *same* client can no longer serialize a
`Date`. The architecture deliberately exposes both `db` (drizzle, for typed queries) and
`sql` (raw, for bulk inserts) from one pool, so this disabled the entire ingest write path.

**Fix** `createClient` opens one pool per access style. Cost is a few extra connections.

**Guard** `packages/db/src/schema.test.ts` binds a `Date` through raw SQL *after* drizzle
has been constructed, including via the multi-row helper that actually failed.

---

### A2. jsonb values bound pre-stringified were stored as JSON *string* scalars

**Symptom** Tag filtering silently returned nothing; the run list 500'd with
`cannot get array length of a scalar`.

**Cause** postgres.js JSON-encodes any value bound to a `jsonb` column or an explicit
`::jsonb` cast. Passing `JSON.stringify(value)` encoded it twice, storing `"{}"` as a
scalar string rather than an object. **Nothing errored on insert** — the data looked
present and `tags @> …` simply never matched.

**Fix** `sql.json()` at every jsonb binding. Migration `0003` repairs affected rows via
`value #>> '{}'` and then *fails* if any non-container value remains, rather than
reporting success on a partial repair.

**Guard** A test asserts `jsonb_typeof` is `object`/`array` and that containment actually
matches after a write.

---

### A3. Draining the DEFAULT partition was ordered backwards

**Symptom** `updated partition constraint for default partition would be violated by some
row` — and only when there was work to do.

**Cause** The code created the target monthly partition *before* removing rows from
DEFAULT. Attaching a partition makes Postgres verify DEFAULT holds nothing in the new
range, so it failed precisely in the case it existed to handle. The system could not
recover without manual SQL.

**Fix** Rows leave DEFAULT first, inside a transaction with an `ON COMMIT DROP` temp
table, so a failure in the create-or-reinsert rolls the delete back and no result is lost.
Verified by relocating 198,500 real rows.

**Guard** A test inserts a backdated row, confirms it lands in DEFAULT, drains, and
asserts it moved to the correct monthly partition.

---

### A4. `BLOB_LOCAL_DIR` resolved against each process's own cwd

**Symptom** Ingest failed with ENOENT on a file that had definitely been uploaded.

**Cause** The web app runs from `apps/web` and the worker from the repo root, so a
relative path meant two different directories. The API wrote artifacts the worker could
not find.

**Fix** Relative paths are anchored at the workspace root. `/api/health?deep=1` now prints
the resolved path so a divergence is visible instead of mysterious.

**Guard** A test asserts the same relative value resolves identically from both cwds.

---

### A5. Flake score was miscalibrated and mis-ordered

**Symptom** Dashboard said "0 flaky tests" while 19 tests were demonstrably flaky.

**Cause** A linear weighting scored a test needing retries in **30% of its runs at 15.8** —
below the threshold the dashboard used to call anything flaky. Worse, it ranked that test
*below* one that merely failed sometimes with no retries at all, inverting the signal:
retry-flakiness is the highest-confidence evidence of nondeterminism.

**Fix** A saturating curve, `100 × (1 − e^(−8·rate))`, over retry-flake rate plus status
instability, counting instability only at ≥2 flips so a consistently failing test scores 0.
Genuinely flaky tests now score 84–95; the four consistently-broken seeded tests score 0.

**Note** Found only because the seeded data had *believable shapes*. Random noise would
have hidden it. This is the main argument for keeping `seed-test-org` faithful.

---

### A6. Runs stranded in "parsing" forever

**Cause** A worker killed mid-ingest left no job to finish the run, so the UI showed a
spinner indefinitely — which reads as a broken product rather than a failed import.

**Fix** A reaper fails runs idle beyond 30 minutes and records why, running on the same
schedule as partition maintenance.

---

### A7. Function props passed from server components to client components

**Symptom** Two 500s: the dashboard and the test history page.

**Cause** `TrendChart` took `formatValue` and `HistoryStrip` took `hrefFor`. React cannot
serialize a function across the server→client boundary. Made twice, which is why an audit
was added rather than just a fix.

**Fix** Serializable descriptors — `format="percent" | "duration"`, `runHrefBase="/o/…/runs"`.

**Guard** A script enumerates client components and checks no server component passes a
function-valued prop to one. Currently clean.

---

### A8. Onboarding bounced granted members away from their organisation

**Cause** The gate keyed on an `onboarded_at` flag. A user granted access by an admin has
never been through onboarding and never needs to, so they were redirected out of the
organisation they had just been added to.

**Fix** The gate keys on *actual access*: onboarding is only shown when a viewer has no
accessible organisations.

---

### A9. Two nav links pointed at pages that did not exist

**Cause** The app shell linked to `/admin` and `/o/:org/p/:key/settings` before either was
built. Both 404'd from the product's own navigation.

**Fix** Both built. `/admin` is also a stated requirement — it is how a platform admin
grants access to an organisation they are not in.

---

### A10. A declared filter that silently did nothing

**Cause** `TestSearchFilter` declared a `tags` field the query never applied. A caller
passing tags received *unfiltered* results and would reasonably believe the filter had
worked — strictly worse than the feature being absent.

**Fix** The field is removed, with a comment explaining what implementing it requires
(tags live on `test_results`, so filtering `test_cases` needs an EXISTS subquery). Tracked
as B3.

---

### A11. "Average test duration" was average *run* duration

**Cause** `project_daily_stats.avg_duration_ms` is `AVG(runs.duration_ms)`. The tile
labelled it as a per-test figure, making a ~19s value look absurd for a unit test.

**Fix** Relabelled to "Average run duration", and the meaning documented where it is
computed. A mislabelled metric is worse than a missing one.

---

### A13. Shell and accessibility defects found by looking at the running app

Found by driving the browser rather than reading code — every one of these passed
`tsc` and `eslint`.

- **A `"use server"` file exported a constant.** Server-action files may only export
  async functions, so the app failed to build at request time while both the typechecker
  and the linter reported success. The cookie name and type now live in a plain module.
- **Four controls had no accessible name.** Both scope-switcher triggers, the "N failing"
  header pill, and every tag chip. Their names came from nested spans, and in the
  switcher's case one of those spans is `hidden` below the `sm` breakpoint — a hidden
  element is excluded from the accessible name, so the label degraded on exactly the
  screens where context matters most. All four now state their name explicitly.
- **No Escape on the mobile drawer.** The open drawer covers the button that opened it,
  so a keyboard user had no route out other than a pointer-only dismiss overlay.
- **The `[` shortcut matched only `event.key`.** On layouts where `[` requires a modifier
  it would never fire; it now also matches `event.code === "BracketLeft"`.
- **Platform admins landed in the wrong organisation.** Because they can see *every*
  org, the landing path picked whichever sorted first alphabetically — an empty one —
  which reads as "the product lost my data". Preference now favours an org the viewer is
  genuinely a member of.
- **The sidebar's persisted state silently reverted.** Its cookie was written with a bare
  `void setSidebarState(next)`. The panel moved, so it looked correct, but the write did
  not reliably land and the next server render re-read the old value and snapped the
  panel back. Wrapping it in a transition ties the write to React's update. Worth
  knowing generally: a fire-and-forget server action is not a reliable way to persist
  state the server is about to read back.

### A12. Test-suite mistakes worth noting

Three of my own test expectations were wrong rather than the code:

- A pass-rate assertion I had mis-calculated (1 passed / 1 failed / 1 skipped is 50%, not 66.67%).
- A "unique" test name built from `Date.now()`, which the fingerprint scrubber correctly
  collapsed to `<epoch>` — the scrubbing was right; the test was naive.
- A `partattrs[1]` subscript; `int2vector` is zero-indexed.

Recorded because in each case the instinct to "fix the code" would have broken correct
behaviour.

### A14. The headline pass rate was always red

`tone={summary.failing30d > 0 ? "failed" : "passed"}` on both the org and project
dashboards. Any single failing test anywhere painted the pass rate with the critical
colour, so a 97.7% pass rate rendered in the same red as an outage — and since every real
project has at least one broken test, the loudest signal on the page was permanently lit.

Replaced with banded thresholds in `apps/web/src/lib/health.ts` (≥98% healthy, ≥90%
degraded, below that critical), and a null rate — no runs in the window — now renders
neutral rather than asserting a verdict about a suite nobody has run. The *count* of
failing tests keeps its unconditional red, which is correct: a failure count above zero
really is a failure count.

### A15. Flake score ranked its least-evidenced entries highest

The score divided flake events by the observed run count, so a test seen exactly once that
needed one retry had a rate of 1.0 and scored a perfect **100** — above a test that had
been flaking in 30 of its last 40 runs (~88). The flaky leaderboard's job is to say what
to fix first, and its top was reserved for the weakest evidence available. A synthetic
5,000-test seed run made this obvious: 94 brand-new tests instantly occupied the entire
list.

Both rates are now smoothed by `FLAKE_PRIOR_RUNS = 4` pseudo-runs in the denominator, so
sparse observations are pulled toward zero while well-evidenced ones move by under two
points. One flake in one run scores ~80; the 30%-of-40-runs case scores ~89 and keeps its
place above it. `queries.test.ts` now asserts the ordering and the zero for a
consistently-broken test, since the property matters more than the exact numbers.

### A16. `max-width` on a `<td>` does nothing

Four data tables bounded their name column with `max-w-md` / `max-w-lg` on the cell.
Under auto table layout the algorithm sizes each column to its content and ignores that
declaration entirely, so a 200-character test name overran its cell and drove straight
through the status and fail-rate columns. Constraining a block *child* fixed the
truncation but not the geometry: an absolute maximum cannot know how much width the
sidebar left, so the last two columns were pushed off the right edge instead.

All four tables (tests, flaky, run results, run result suites) are now `table-fixed` with
proportioned column widths, which gives `truncate` a definite width to resolve against and
makes the layout independent of content. Narrow measurement columns also carry
`whitespace-nowrap`, because a duration broken across two lines reads as two values.

Found by seeding deliberately awkward content rather than by reading the code.

### A17. The test suite recreated organisations in the development database

`bootstrap()` is idempotent by slug, and both integration suites called it with the
default slug. Running `pnpm test` against a development database therefore recreated the
`default` organisation and its project — an org deliberately deleted came back the next
time anyone ran the tests. The two suites also shared that org, so each could see the
other's leftovers.

Each suite now bootstraps a uniquely-slugged throwaway organisation and deletes it in
`afterAll`, which cascades through every tenant-scoped table. `seed-perf` likewise got its
own `perf-harness` org. Verified: after a full run, `test-organisation` is the only
organisation present.

### A18. Backdated seed runs recorded wall-clock durations

`finalizeRun` defaults `finishedAt` to `now()` and derives the duration from
`started_at`, which is right for a live ingest and wrong for seeded history. A run placed
30 hours in the past came out with a 30-hour duration, and the dashboard duly reported an
average run duration of **3h 18m**. Both seeders now state the duration and the finish
time explicitly, and existing rows were realigned. The average is now 27s.

### A19. Selecting a project, then opening Runs or Tests, silently discarded the project

`/o/:org/p/:key/runs` and `/o/:org/p/:key/tests` were `redirect()` shims to the org-wide
route carrying `?project=`. The reasoning was sound — one implementation of filtering,
pagination and facets, rather than two copies that drift — but the redirect moved the URL
out of the `/p/:key/` path, and the shell derives the selected project *from the path*.

So the results were filtered correctly while everything around them said otherwise: the
header dropdown reset to "All projects", the project section vanished from the left nav,
and the address bar no longer mentioned the project. Choosing a project and clicking Tests
looked exactly like being ignored, which defeated the purpose of the switcher.

Fixed by keeping one implementation and rendering it at both scopes:

- `features/test-search.tsx` and `features/run-list.tsx` hold the implementations; the four
  routes are thin wrappers passing `basePath` and `scopedProjectKey`.
- A path-scoped project overrides `?project=`, so one value never has two sources, and an
  unknown project key is a 404 instead of a silently org-wide list.
- Every filter, facet, sort, tag, search form and pagination link is built from `basePath`,
  so nothing inside a project view escapes it. Verified in the browser: 45 filter links on
  the run list and 25 on the test list, none leaving scope.
- Scope switching now *preserves the section*. Moving between projects on the test list
  keeps you on the test list; narrowing from the org list stays on the list; "All projects"
  — a new row in the project dropdown — widens it back. Sections that exist at only one
  scope (`upload`, `settings`) fall back to the project overview.
- The scope-path helpers moved out of the client component into `lib/scope.ts` with 11 unit
  tests, because a URL parser that quietly returns the wrong answer is precisely how this
  class of bug reappears.
- The run detail breadcrumb also linked to `?project=`; it now points at the project path.

Redundant columns were dropped while scoped: repeating the project key on every row of a
single-project list is noise.

### A20. Hovering the execution history moved the chart beside it

Hovering any *failed* cell in a test's execution history widened the left column and shoved
the "Duration over time" chart sideways; the panel also appeared and disappeared, pushing
everything below it up and down.

Two causes, both needed fixing:

- The page used `lg:grid-cols-[1fr_320px]`. `1fr` is shorthand for `minmax(auto, 1fr)`, and
  `auto` bottoms out at **min-content** — so the hover panel's longest unbroken string set
  the column's minimum width. A Hamcrest failure message is one long unbroken string, which
  is exactly why only failed cells did it: passed cells have no message. All four
  `[1fr_…]` grids in the app now use `minmax(0, 1fr)`, since each holds unbounded content
  (failure messages, test names, suite paths).
- The panel was rendered only while hovering. It is now always rendered and falls back to
  the newest execution, with `min-w-0` so `truncate` has a basis and a fixed `min-height` so
  moving between a passed and a failed cell does not resize it. Defaulting to the latest run
  beats reserving blank space — it is the question the panel answers anyway.

Verified by measurement rather than by eye: the chart's x and width are byte-identical
across hovering a failed cell, a passed cell, and nothing, and the section below it does not
move vertically.

### A21. `toLocaleString()` mismatched between server and browser on every timestamp

The Next.js dev overlay showed **1 issue** on the test history page. It was a real
hydration failure in our code, not the browser extension that had caused an earlier one.

`new Date(x).toLocaleString()` with no arguments formats using whatever locale the
*runtime* has. Node was en-US and the browser en-GB, so the same instant rendered as
`6/12/2026, 8:13:00 PM` on the server and `12/06/2026, 20:13:00` on the client. React
discarded the server HTML for that subtree and re-rendered it. On a 60-cell history strip
that was 120 mismatched attributes plus the detail panel.

Every date helper in `lib/format.ts` passed `undefined` as the locale, so this was a class
of bug rather than one instance — and the number `toLocaleString()` calls were latent
members of it (they agree between en-US and en-GB, but not de-DE).

Fixed by pinning both locale and time zone in one place: `Intl.DateTimeFormat("en-GB", {
timeZone: "UTC" })` for dates, a pinned `Intl.NumberFormat` for counts, and `formatDay` /
`formatAbsoluteTime` / `formatInteger` used everywhere instead of raw calls. Timestamps now
read `29 Jul 2026, 17:31 UTC`.

Pinning is the right answer beyond hydration: `6/12` and `12/06` are the same string to a
machine and different dates to a reader, and a test dashboard is read by people in
different places looking at the same run. UTC matches what CI logs and what the database
stores, and it is labelled rather than left to be guessed.

Verified: zero console errors across the dashboard, run list, test search, flaky list and
project overview, and the overlay badge is gone. One latent member of the class is left
open deliberately — see the relative-time entry in the backlog.

### A22. The selected project reset itself on any page that did not name one

The project came only from the URL path, so it was only true on `/o/:org/p/:key/…`. Open a
test from a project's own test list and the URL becomes `/o/:org/tests/:id` — no project in
it — so the header dropdown snapped back to "All projects" and the project's nav section
disappeared, while the page displayed a test belonging to that project. Same for a run, and
for any organisation-wide page. Nothing had changed except that the next URL happened not
to mention where you were.

Selection is now a remembered preference, held in a cookie and read by the layout during
the server render, so a page whose URL is silent still arrives with the right project
selected in the first painted frame.

- **The path still wins when it has an opinion**, so a shared link lands on the project it
  is about rather than on whatever the recipient last opened — and visiting a project URL
  updates the memory.
- **The value is qualified by organisation** (`orgSlug:projectKey`) and validated against
  the projects the viewer can see, so a selection cannot leak between organisations that
  both have a `web` project, and a deleted or newly-inaccessible project cannot leave a
  phantom selection in the header.
- **Only "All projects" clears it.** Visiting an organisation-wide page does not, which is
  the whole point.

Two things went wrong while building it, both worth recording:

- Clearing via a plain link raced the redirect: the destination's server render could read
  the cookie before the delete landed, so choosing "All projects" arrived on an
  organisation-wide page still showing the project. The clear and the navigation now happen
  in one server action.
- That action is submitted from a form inside the dropdown, and the row initially kept the
  menu's close-on-click handler. Closing unmounts the form, and a form unmounted mid-submit
  never submits — so "All projects" silently did nothing at all. A link survives that
  because the browser owns the navigation; a form does not.

### A23. Archiving a project was a one-way trip, and nothing could be deleted

One button did neither job properly. It said "Archive", it was gated on a capability called
`project:delete`, and afterwards the project was unreachable: `requireProject`,
`findProjectByKey` and `listProjects` all filtered `archived_at IS NULL`, so the settings
page could not resolve it and the projects list did not show it. There was no page left on
which to un-archive, and no way to actually delete either. Archiving was an
indistinguishable-from-deletion action with a reassuring name.

- `requireProject` and `listProjects` take `includeArchived`. The settings page passes it,
  because that is where restoring happens; every other project page stays 404 for an
  archived project, since an archived project should not be serving dashboards.
- The projects list has an **Archived** section with a Restore button per row.
- The capability is split: `project:archive` (admin) for the reversible action,
  `project:delete` (**owner**) for the one that destroys history.
- Deleting requires the project key typed by hand, and the runs, results, test cases and
  tokens cascade from the foreign keys. Verified end to end: wrong confirmation refuses and
  changes nothing, correct confirmation removes the project with zero orphaned rows.

Found because two projects in the development organisation were already archived and stuck.

### A24. insights.ts had no tests, and every id it returned was a string

`insights.ts` is the read path behind every dashboard tile, every chart, the test history
page, the flaky leaderboard and test search — around 1,100 lines, of which 496 had just been
added. No test file imported it.

That is the same exposure that produced A-register entries already: these queries are built
by string composition, so a syntax or semantics error appears only when the query runs.
`runFilterOptions` shipped with a bare `ORDER BY` inside a `UNION` branch and took the run
list down with a 500; `queries.test.ts` exists to stop that recurring, and covered
`queries.ts` only.

`insights.test.ts` now covers all nineteen exported functions against a real Postgres, with a
fixture of a known shape — a steady test, a consistently broken one, a genuinely flaky one, a
test with two distinct failure signatures, a permanently skipped one and a duration outlier —
so the assertions check arithmetic rather than merely that nothing threw. Pass-rate
denominators exclude skips, the broken test scores zero for flakiness and stays off the flaky
list, two signatures group as two modes, and every function is exercised against an empty
project because that is the state a new project is in.

Writing it surfaced a latent defect immediately: **ten fields declared `number` were strings
at runtime.** postgres.js decodes `int8` as a string, and every id in this module is a
bigserial. Nothing was visibly broken because both sides were consistently wrong —
`searchTests` returned string ids and `recentOutcomes` keyed its map by string, so the
lookups matched. That is a trap rather than a bug: the types lie, so TypeScript cannot catch
the first caller who does `Number(id)` and then silently misses every lookup, and the
test-detail page already calls `Number(testId)` on its route param.

Fixed once, in `client.ts`, by parsing `int8` to a number where values are decoded rather
than asking nineteen queries to remember to coerce. Casting to `int4` in SQL would have been
the cheaper-looking fix and is wrong — that ceiling is 2.1 billion results, which a busy
install could reach; the JS number limit of 2^53 needs quadrillions.

### A25. The db suite deadlocked on itself about one run in eight

Captured after ten attempts:

```
delete from "organizations" where "organizations"."slug" = $1
PostgresError: deadlock detected (40P01)
Process 60709 waits for RowExclusiveLock on relation 16740; blocked by process 60714
```

Each suite tears down by deleting its throwaway organisation, which cascades through runs,
test_results across every monthly partition, test_cases, memberships and api_tokens. Vitest
runs test files in parallel, so two of those cascades overlapped, took the same partition
locks in different orders, and Postgres broke the tie. It had been rare enough to look like
noise; adding a fourth test file made it frequent enough to catch.

Two changes, both narrowing what a test can reach beyond itself:

- `packages/db/vitest.config.ts` sets `fileParallelism: false`. This is a property of sharing
  one database, not of any single test, so it belongs in the runner rather than in a retry
  wrapped around each teardown. Cost is about 3.5s parallel against 6s serial.
- `failStalledRuns` takes an optional `orgId`. Unscoped it reaps every stalled run in the
  database — correct for the scheduled janitor, and a sharp edge for a test, which was
  sweeping runs belonging to other files. The reaper test now scopes to its own organisation.

The reaper test also used to `ALTER TABLE runs DISABLE TRIGGER`, which takes ACCESS EXCLUSIVE
on `runs` and blocks every other file writing runs. The trigger is BEFORE UPDATE only, so the
test now backdates `updated_at` in its INSERT and nothing needs suspending.

Verified by running the suite twelve consecutive times: no failures, no skips.

---

## Part B — outstanding

### B13. Reports can carry credentials into the database *(found in real data)*

The Cucumber reports used to seed `EXT API TEST` log a live bearer token in `system-out`
on every scenario — `>>>>>> TOKEN::: oa-<40 hex>` and `PLATFORM CLIENT TOKEN` — so
ingesting four reports put real credentials in 36 rows, and from there into the UI and any
backup. `seed-from-junit` scrubs what it generates, but the product's own ingest path
stores captured output exactly as CI sent it.

Two separate things need deciding, which is why this is not a silent fix:

- **Whether to redact at parse time**, and whether that is a per-project setting (default
  on) or unconditional. Redacting changes what the product stores from what was sent,
  which is the owner's call.
- **The raw artifact** in object storage remains the source of truth and would still hold
  the secret, so artifact retention has to be part of any answer.

Worth saying separately: the token appearing in the report at all is a property of the
test suite, not of Test Center. A dashboard that quietly makes it searchable does make it
worse.

### B14. Embedding the cluster in the scenario name fragments a test's history

Not a defect in this product, but it shapes what the product can show. The real scenarios
are named `On Cluster "SWADESHUAT", Positive Brand import with file "SWADESHUAT-…"`, so
the same scenario on a second cluster is a *different* test as far as any dashboard is
concerned — a separate fingerprint, a separate history, a separate flake score. Running
four clusters turns 65 scenarios into 353 test cases, and no view can answer "does this
scenario fail only on production?".

The fix is on the suite's side: keep the cluster out of the scenario name and pass it as a
Cucumber tag or a run-level parameter. Test Center already reads run tags and per-result
parameters, so `cluster` becomes a filter across one shared history instead of a name
prefix that splits it. `seed-from-junit` records `cluster` both ways — in the name, as the
reports do, and in `parameters` — so the difference is visible in the product.



Ordered by my view of value. None are known to be broken; they are absent or thin.

### B1. Platform admin area is minimal *(built, could go further)*
Lists organisations and grants/revokes access. Does not yet offer: a user directory with
last-seen and org membership, disabling an account, per-org quota editing, or an audit log
of admin actions. The last is the most valuable — cross-tenant grants should be traceable.

### B2. Expose the flake and duration thresholds in the UI
`searchTests` supports `minFlakeScore` and `slowerThanMs`, but no control surfaces them, so
"tests slower than 5s" cannot be asked from the UI.

### B3. Implement tag filtering on test search
See A10. Needs an EXISTS subquery against `test_results.tags` within the window, and a
decision about semantics: a test whose *latest* run carried the tag, or any run in the
window.

### B4. Virtualize the run result table
Server-paginated at 200 rows (≈580KB at 1000 results). A 10k–50k test nightly needs
windowing, plus sortable columns, a sticky header and keyboard navigation.

### B5. Accessibility — remaining work
Substantially advanced (see A13). What is still open: no testing with a real screen
reader, the scope-switcher does not *trap* focus (it closes on Tab instead, which is
acceptable for a menu but not for a modal), the mobile drawer does not trap focus either,
and dark mode has not had a contrast run against real screenshots rather than computed
values.

### B6. Run comparison against a baseline
"3 new failures, 2 known flakes" turns a red run from 40 problems into 2. The failure
signatures needed for it already exist.

### B7. Per-organisation quotas are declared but unenforced
`organizations.max_runs_per_day` exists and nothing checks it. `max_projects` *is*
enforced. An unenforced limit is a false promise — either wire it up or drop the column.

### B8. No rate limiting on ingest
A token can upload without bound. Matters as soon as this is shared.

### B9. Sharded run merging is not implemented
`run_group_id`, `shard_index` and `shard_total` are stored and accepted by the API, but
shards are not merged into one logical run — so a suite split across 8 CI jobs appears as
8 runs. Phase 2 work, but worth knowing the columns are currently decorative.

### B10. Re-parse path unimplemented
Raw artifacts are stored precisely so an improved parser can be replayed over history, and
`parser_version` is recorded per artifact — but nothing triggers a re-parse. This is the
payoff for storing artifacts immutably and is currently unclaimed.

### B11. Notifications, quality gates, ownership routing
Phase 4 as planned. Nothing started.

### B12. SSE progress polls the database
One indexed row per second for the seconds a parse takes. Fine now; if many concurrent
viewers ever make it measurable, the poll body is the only thing that changes.

---

## Deliberate non-goals

Recorded so they are not mistaken for oversights.

| Not doing | Why |
| --- | --- |
| Local passwords | Anyone reaching `localhost` can reach the database; a password would imply protection it does not provide. Production identity is Google's. See the user guide §2. |
| ClickHouse / columnar store | At <50k tests/day this is ~18M rows/year. Postgres with monthly partitions serves it indefinitely; queries measure 2–6ms at 400k rows. |
| Row-level security | Isolation is enforced in one access module and tested from the outside. RLS becomes worthwhile with untrusted tenants in one database. |
| Deleting projects | Archiving instead — test results are evidence, and a project someone stopped using is usually still worth reading. |
| Editing a project key | It is what CI sends. Changing it breaks every pipeline, and the failure looks like "results stopped arriving". |
