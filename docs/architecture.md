# Test Center — Developer Architecture Reference

Everything a developer needs to work in this codebase: the stack, the layout, how a report
becomes history, where every table and route lives, and the conventions that are enforced.

For *why* the product is shaped this way and what is planned next, see
[`test-center-plan.md`](test-center-plan.md). For signing in and using the app, see
[`user-guide.md`](user-guide.md). For the bug register, see
[`known-issues.md`](known-issues.md).

---

## 1. Tech stack

| Layer | Choice | Version | Why this one |
| --- | --- | --- | --- |
| Language | TypeScript | `^6.0.3` | `strict`; one language across web, worker and packages |
| Runtime | Node | `>=22` (dev on 24.9) | Native `fetch`, stable streams, `--env-file` |
| Package manager | pnpm | `11.18.0` | Workspaces + content-addressed store; `packageManager` pins it |
| Monorepo tasks | Turborepo | `^2.10.7` | Task graph + caching; `dependsOn: ["^build"]` orders packages |
| Web framework | Next.js App Router | `^16.2.12` | Server components for read-heavy pages; route handlers for the API |
| UI | React | `^19.2.8` | — |
| Styling | Tailwind CSS | `^4.3.3` | Via `@tailwindcss/postcss`; design tokens as CSS custom properties |
| Auth | Auth.js (next-auth) | `5.0.0-beta.32` | Google Workspace OIDC + a dev credentials provider |
| Database | PostgreSQL | 16/17 (16.14 in dev) | Partitioning, `jsonb`, `uuidv7()`, trigram search |
| DB driver | postgres.js | `^3.4.9` | Raw SQL for bulk ingest; template-literal binding |
| ORM | Drizzle | `^0.45.2` | Typed application queries; schema in `packages/db/src/schema.ts` |
| Queue | BullMQ on Redis | `^5.81.2` / `ioredis ^5.11.1` | Retries, delayed jobs, repeatable maintenance |
| Object storage | S3 SDK or local FS | `@aws-sdk/* ^3.1096.0` | `BLOB_DRIVER=s3\|fs`; both implement one port |
| XML parsing | saxes | `^6.0.0` | SAX streaming — a 300 MB report is never buffered |
| Validation | Zod | `^4.4.3` | Canonical model, env, API payloads |
| Logging | pino | `^10.3.1` | Structured; `pino-pretty` in dev |
| Tests | Vitest | `^4.1.10` | Unit + real-Postgres integration |
| Lint/format | ESLint 10 + Prettier 3 | `^10.8.0` / `^3.9.6` | `typescript-eslint`, `prettier-plugin-tailwindcss` |

Three portable primitives only — **Postgres, Redis, S3-compatible storage** — reached
through ports. That is the whole hosting-portability story.

---

## 2. Repository layout

```
apps/
  web/                 Next.js App Router: UI pages + /api route handlers
    src/app/           routes (see §7)
    src/components/    UI components (see §8)
    src/features/      page-sized compositions reused at two scopes
    src/lib/           services, viewer/access resolution, formatting, health tones
  worker/              long-running BullMQ worker
    src/stages/        ingest.ts, maintenance.ts
    scripts/           enqueue, seed-from-junit
packages/
  core/                canonical model, fingerprint, ports, env, logger
  parsers/             parser registry + streaming JUnit/xUnit parser
  db/                  schema, migrations (sql/), ingest persistence, read queries
  adapters/            the ONLY place infra SDKs are imported
docs/                  this file, plan, user guide, bug register
```

### Dependency direction

```
apps/web ─┐
          ├─→ packages/db ─→ packages/core
apps/worker┘        │
          └─→ packages/adapters ─→ packages/core
                    └─→ packages/parsers ─→ packages/core
```

`packages/core` depends on nothing internal. Nothing depends on `apps/*`.

### The boundary that is enforced

`eslint.config.mjs` blocks these imports outside `packages/adapters` / `packages/db`:

| Blocked | Use instead |
| --- | --- |
| `@aws-sdk/*` | `BlobStore` port from `@testcenter/core` |
| `ioredis`, `bullmq`, `redis` | `Queue` port from `@testcenter/core` |
| `pg`, `postgres`, `drizzle-orm/*` | the client exported by `@testcenter/db` |
| `@vercel/*`, `@google-cloud/*`, `@azure/*` | — (vendor lock) |

Also enforced repo-wide: `no-console` (except `warn`/`error`), `consistent-type-imports`,
`eqeqeq` (null-tolerant), unused vars unless `_`-prefixed.

---

## 3. Data model

### Tables

| Table | Purpose | Notes |
| --- | --- | --- |
| `organizations` | tenant root | |
| `users` | accounts | `is_platform_admin` seeded from `TESTCENTER_ADMIN_EMAILS` at sign-in |
| `memberships` | who can see what, with a role | grants may be by `invited_email` before the account exists |
| `teams` | ownership grouping | |
| `projects` | one codebase/suite | `archived_at` for soft archive |
| `api_tokens` | CI credentials | hash only; shown once at creation |
| `runs` | one execution | denormalized totals (`total/passed/failed/…/pass_rate`) |
| `artifacts` | uploaded report bytes | `storage_key` into the blob store, `sha256` |
| `attachments` | screenshots/videos/traces | |
| `ingest_jobs` | parse pipeline state | `stage` × `state`, drives progress UI |
| `test_cases` | **test identity** + rollups | `fingerprint`, `flake_score`, `runs_30d`, `p95_duration_ms`, quarantine |
| `test_results` | one test in one run | **partitioned monthly** by `started_at` |
| `project_daily_stats` | per (project, day, branch) rollup | what the dashboards read |
| `run_verdicts` | human judgement on a run | append-only; see §6 |
| `idempotency_keys` | safe upload retries | |
| `schema_migrations` | applied migrations + checksums | |

`org_id` is on every tenant-scoped table. Row-level security is deliberately deferred;
scoping is enforced in the query layer, and `packages/db/src/access.test.ts` proves
isolation from the outside using ids that are valid in their own tenant.

### Partitioning

`test_results` is partitioned monthly **for retention, not performance**. At the planned
volume (<50k tests/day, ~18M rows/year) one Postgres handles reads trivially. Dropping a
month is instant DDL; a `DELETE` over the same rows would rewrite the table and hold locks.

If maintenance stops, inserts keep succeeding into `test_results_default` — silently — so
`/api/health` asserts the current month's partition exists. `pnpm db:partitions` has
`--dry-run`, `--list` and `--drain` (the drain relocates backdated rows out of DEFAULT
inside a transaction with an `ON COMMIT DROP` temp table, so nothing is lost if it fails).

### Test identity (the fingerprint)

`packages/core/src/fingerprint.ts`. The highest-leverage decision in the schema: it is what
turns uploads into *history*. Inputs are project + suite + classname + name + parameters,
after normalising away things that differ per machine but do not change the test:

- absolute path prefixes (GitHub Actions, GitLab, Jenkins, macOS/Linux homes, `/app`, `/workspace`)
- shard/worker decorations (`shard-3`, `[worker 2]`, pytest-xdist `gw0`)
- retry decorations (`(retry #2)`)

`FINGERPRINT_VERSION` is stored on every row so a future algorithm change can coexist with
old data during backfill instead of forcing a stop-the-world rebuild. Its tests assert that
the same logical test on a laptop, a GitHub runner, a GitLab runner and Windows produces
one identity.

### Rollups are write-time, never read-time

`project_daily_stats` and the `test_cases` aggregates are maintained during ingest.
**Nothing recomputes them on read.** Any code path that deletes results must repair them —
`deleteRun` does it in one transaction (`deleteRunResults` → `rollupProjectDay` →
`refreshTestCaseStats`). A bare `DELETE FROM runs` leaves dashboards counting a run that no
longer exists, permanently.

---

## 4. Ingest pipeline

```
POST /api/v1/ingest            (small: bytes through the API)
  or
POST /api/v1/runs              → presigned upload URLs
PUT  <uploadUrl>               → bytes straight to object storage
POST /api/v1/runs/:id/complete → queues parsing
                                        │
                                  BullMQ "ingest"
                                        │
                     worker: detect → parse → normalize → persist
                                     → merge → rollup → analyze → notify
```

- Uploads go **direct to object storage** and are stored immutably. The raw artifact is the
  source of truth; the database is a derived projection that can be recomputed when a
  parser improves.
- The parser **streams** (SAX). Batches of ≤1000 results are written with one multi-row
  statement each; a 200k-test report never materializes in full.
- Writes are **idempotent upserts** keyed on natural identity, because CI retries and
  at-least-once queue delivery mean a batch can legitimately be replayed. Per-batch
  atomicity rather than one transaction spanning the run — a long transaction would block
  vacuum and risk total loss on any error.
- **Failure signatures are computed at ingest** even though the clustering UI is later, so
  that feature opens against real history instead of an empty table.
- A worker killed mid-ingest leaves a run in `parsing` with no job to finish it;
  `failStalledRuns` (maintenance queue) marks such runs failed with an explanation rather
  than leaving a spinner forever.

Single-shot ingest exists because adoption is the real battle: the three-step flow is
correct for large reports, but asking a team to chain three curl calls to try the product
guarantees they never do. Its size cap is far below the presigned path's, deliberately.

---

## 5. Read path

Dashboards read pre-aggregated rows, never `COUNT(*)` over millions. Enforced, not assumed:
`seed-perf` measures the five queries the UI issues against real data and fails if any
exceeds 400 ms p95. At 400k results they run in 2–6 ms.

Query shapes worth knowing (`packages/db/src/insights.ts`, `queries.ts`):

- **`LATERAL` + `LIMIT` per row, not `row_number() … WHERE rn <= n`.** The window form reads
  every retained row for every entity on the page and discards all but a few. Used by
  `recentOutcomes` (per-test outcome strips) and `latestRunVerdicts`.
- **`generate_series` calendar fill.** Daily series fill gaps so a quiet weekend shows as a
  gap rather than compressing the x-axis.
- **Batched per-page lookups, never per-row queries.** A list resolves its ids, then one
  query fetches the extras keyed by id.
- **Keyset pagination** on the run list (`(started_at, id) < (…)`), so ties never skip or
  repeat a row across pages.
- **Latest-verdict filtering happens before pagination.** Recorded values use a correlated
  latest-row lookup ordered by `(created_at DESC, id DESC)`; `todo` is a reviewable run with
  no verdict row. Filtering after the newest page was selected would silently omit matching
  older runs.

---

## 6. Access control

`packages/db/src/access.ts` — capability → minimum role, checked by rank
(`viewer < member < maintainer < admin < owner`).

| Capability | Minimum role |
| --- | --- |
| `run:read` | viewer |
| `run:upload`, `run:edit` | member |
| `project:create`, `project:edit` | maintainer |
| `run:rename`, `run:verdict`, `run:delete` | admin |
| `project:archive`, `token:manage`, `member:manage`, `org:edit` | admin |
| `project:delete`, `org:delete` | owner |

Organisation membership grants access to every project in it; roles control what you can
*do*. Grants are by **email** and bind at first login, which gives invite ergonomics with
no mail sending. Platform admins (`TESTCENTER_ADMIN_EMAILS`) see every organisation, and
the list is re-asserted on every sign-in, so privilege cannot be escalated from inside the
app and removing an address actually revokes it.

Two auth paths, deliberately distinct:

- **CI tokens** (`Authorization: Bearer tc_…`) — scope-checked (`runs:write`), used by
  ingest. Cannot rename, delete, or record verdicts on a run: a token leaked from a
  pipeline log must not be able to destroy or editorialise history.
- **Session viewers** — capability-checked after `requireOrgAccess` *proves* the org from
  the request. A run id alone is never authority to modify it, and every write is
  additionally scoped by `org_id` so a mismatched pair updates nothing.

### Run verdicts

A human judgement on a run — the one thing the product cannot compute. `96%, 2 failing`
cannot distinguish a regression from a UAT cluster being down, and that distinction decides
who gets handed the problem.

Five values (`packages/core`, mirrored by a CHECK constraint in migration `0005`):
`pass`, `product-bug`, `infra`, `flaky`, `investigating`. Separate because the action
differs — a product bug goes to a developer, infra to whoever owns the cluster, flakiness
to the test's author.

**Append-only.** A correction is a new row; the run displays its newest. `created_by` is
`ON DELETE SET NULL` so a judgement outlives the account that made it. Ordering is
`(created_at DESC, id DESC)` — two verdicts in the same millisecond would otherwise make
"latest" arbitrary, and `id` is uuidv7 so it breaks the tie in the direction the timestamps
intend.

A complete, partial or failed run with no verdict row renders **TODO**, derived and never
stored: writing a machine row would put a NULL author in an audit trail and make "nobody
looked" indistinguishable from the `investigating` verdict, which means someone did look and
has not finished. Pending and parsing runs are not ready for review and show no TODO.
Verdicts are **inert with respect to every metric** — no chart changes meaning when someone
labels a run.

The runs list exposes the latest judgement through
`?verdict=pass|product-bug|infra|flaky|investigating|todo`. A recorded-value predicate reads
only the newest append-only row, so correcting `infra` to `product-bug` removes the run from
the former filter. `todo` uses `NOT EXISTS` and is limited to `complete`, `partial` and
`failed` runs; an upload still parsing is not review work. The predicate is part of the SQL
filter before keyset pagination and is carried through search, facets and older-page links.

---

## 7. HTTP surface

### Public API (`/api/v1`)

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/ingest` | token/session | single-shot upload: create run, store report, queue parse |
| POST | `/runs` | token/session | create a run, return presigned upload URLs |
| GET | `/runs` | token/session | list runs |
| GET | `/runs/:id` | token/session | run detail + paginated results |
| PATCH | `/runs/:id` | token (`runs:write`) | edit tags |
| DELETE | `/runs/:id?orgSlug=` | **session, `run:delete`** | delete run + results + artifacts, repair rollups |
| POST | `/runs/:id/name` | **session, `run:rename`** | rename (empty clears → framework fallback) |
| POST | `/runs/:id/verdict` | **session, `run:verdict`** | record a verdict (append-only) |
| POST | `/runs/:id/complete` | token/session | queue parsing after a presigned upload |
| GET | `/runs/:id/events` | session | SSE parse progress |
| POST | `/tests/:id/quarantine` | session, `run:edit` | quarantine / reactivate |
| GET | `/search` | session | command palette |
| PUT/GET | `/blob` | signed | the `fs` driver's signed-URL implementation |

`GET /api/health` — shallow by default; `?deep=1` adds object storage. Checks database,
queue depth, current-month partition, blob store.

Query parameters accepted by ingest: `project` (required), `name`, `branch`, `commit`,
`env`/`environment`, `framework`, `suite`, `tag` (repeatable, `key:value`), `buildId`,
`ciProvider`, `jobUrl`, `startedAt`.

### Pages

Scope lives in the URL — `/o/:org` for cross-project views, `/o/:org/p/:project` for
project-scoped ones — so every link is shareable and unambiguous.

The URL wins whenever it names a scope. The shell also remembers the last visited organisation
and selected project in short-lived cookies so neutral routes (`/`, `/help`, and the sign-in
return) can take the viewer back to the same place. The project value is qualified by organisation
and both values are validated against current access before use; stale, archived, or revoked scope
falls back safely instead of producing a phantom selection or granting access.

| Route | Contents |
| --- | --- |
| `/o/:org` | dashboard: KPI tiles; outcome-per-run area chart (2/3) beside the activity heatmap (1/3); per-run pass rate, last-run donut and CI time per run (exact bars + five-run rolling average); slowest tests, failure concentration, flake distribution; leaderboards; recent runs |
| `/o/:org/runs` | filterable run list — search, branch/env/framework/tag facets, latest verdict/TODO, keyset pagination |
| `/o/:org/runs/:id` | run detail: metadata strip, KPI tiles, verdict log, suite tree, failures-first results, output |
| `/o/:org/tests` | test search + per-test outcome strips |
| `/o/:org/tests/:id` | test history: outcome strip, duration trend, failure modes, executions (`?show=all` for passed output) |
| `/o/:org/flaky` | flaky leaderboard with CI time burned |
| `/o/:org/projects`, `/projects/new` | projects; creation mints a CI token and shows the recipe |
| `/o/:org/settings` | organisation display name; slug stays immutable so links and integrations survive |
| `/o/:org/settings/members`, `/settings/tokens` | access and tokens |
| `/o/:org/reports` | a catalog of 12 vetted questions with blanks (`?q=` plus one parameter per blank: `days`, `branch`, `environment`, `suite`, `project`, `topN`, `verdict`), answered as panels; print for PDF |
| `/o/:org/p/:project/*` | project-scoped dashboard, runs, tests, flaky, reports, upload, settings |
| `/organizations/new` | authenticated creation of an additional team organisation; rendered in the remembered org's full application shell |
| `/onboarding` | no-org creation/skip flow; intentionally outside the shell because there is no tenant scope to navigate yet |
| `/admin` | platform-wide organisation access management; full application shell, with platform-admin authorization rechecked in every action |
| `/help` | the narrative guide — five acts, illustrated with the app's own components. Outside `/o/:org` because that layout is the authorisation gate; unauthenticated and reads no tenant data, so it works in an invitation mail and during an outage |

`/o/:org/p/:key/runs` and `/o/:org/runs?project=` render the *same* component
(`features/run-list.tsx`). The project route used to redirect to the org route with
`?project=`, which kept one implementation but threw the URL out of the `/p/:key/` path —
and the shell derives the selected project from the path, so the header dropdown reset and
the project nav vanished. Rendering the same component under both paths keeps one
implementation *and* the scope. `/reports` is rendered by `features/reports.tsx` under both
paths for the same reason.

**Time zones.** Every timestamp and every time bucket renders in the viewer's zone. A server
component cannot ask the browser what zone it is in, so `TimezoneSync` writes
`Asia/Kolkata|IST` to a cookie and refreshes; `viewerTimeZone()` reads it during render and
the zone is passed explicitly — to `formatAbsoluteTime`, and to `runActivity`/`runSeries`,
which bucket `AT TIME ZONE <zone>` in SQL. It cannot be done by shifting UTC buckets
afterwards: at UTC+5:30 an hour bucket spans two local hours. The label travels in the cookie
beside the zone because deriving "IST" from "Asia/Kolkata" depends on the runtime's ICU data.
The first render before the cookie exists is UTC, labelled as such.

**The report panel contract** (`packages/core/src/reports.ts`) is the seam that lets a
question catalog ship now and a chart builder arrive later without a rewrite. A panel is a
*finished answer* — a title, the data, and one of five closed kinds (`stat`, `trend`,
`ranked`, `volume`, `table`) — and nothing downstream knows whether the spec came from a
curated question or anything else, so print, page breaks and empty states are solved once
rather than per question. It lives in `core` because both `db` (which produces panels) and
the web app (which renders them) depend on it. The chart form is chosen by the question's
author, who knows what the data means, never by the reader. Everything is in the URL, so
there is no saved-report table: the report *is* the link.

---

## 8. Web app internals

### Components

| Component | Role |
| --- | --- |
| `app-shell` | nav, scope switcher, command palette, theme toggle |
| `org-app-shell` | server composition that loads one authorised org's chrome; reused by org routes, Platform Admin and additional-org creation |
| `organization-creation-form` | shared create mutation for no-org onboarding and authenticated team-org creation |
| `action-menu` | generic ⋯ overflow menu (`menuitem` semantics, arrow keys, Escape restores focus) |
| `filter-menu` | single-choice dropdown of links (`menuitemradio`) — the choice lives in the URL |
| `run-actions` | rename / edit tags / verdict / delete, expanding in place |
| `test-actions` | quarantine / reactivate |
| `verdict-badge` | verdict or derived TODO; `awaitsVerdict()` gates on run status |
| `tag-editor` | tag chips + add/remove (`showChips`, `startOpen`) |
| `time-range-nav` | page-level day-range selector |
| `report-panels` | renders any `ReportPanel` — one renderer for every question, so print, page breaks and empty states are solved once |
| `print-button` | hands the page to the browser's own print pipeline, which is the PDF exporter |
| `help-illustrations` | `/help` artwork: two CSS/SVG loops and two concept diagrams, no screenshots; product screens use live components with sample props |
| `search-box` | GET-form search; `name`/`label` configurable, multi-valued hidden fields |
| `upload-form` | drag-and-drop; one request per file, each its own run |
| `run-progress` | SSE parse progress |
| `charts/trend-chart` | line + area, or exact per-run bars with a five-run rolling-average line on one axis |
| `charts/volume-chart` | stacked columns; `mode="counts"\|"share"` |
| `charts/ranked-bars` | horizontal magnitude bars; `domainMax` for ratios (server component) |
| `charts/history-strip` | one test's outcomes, each cell a link (detail pages) |
| `charts/outcome-strip` | compact strip for list rows — whole strip is one link (server component) |
| `charts/chart-toggle` | switches a chart's *question*, via the URL |
| `charts/volume-chart` | `shape="columns"\|"area"`; area mode is a smoothed stacked area with a value axis, per-point dots, verdict ribbon and click-through to the run |
| `charts/outcome-donut` | one run's composition as a ring; all four outcomes always listed, hover reports a slice in the centre |
| `charts/activity-heatmap` | punchcard — hour of day across, weekday down, square cells, quantile-bucketed |
| `charts/curve` | monotone cubic interpolation shared by the line and area charts |
| `timezone-sync` | writes the browser's zone to a cookie and refreshes; renders nothing |

Two menus exist and answer the keyboard identically on purpose — differing behaviour
between two menus in one app is worse than either behaviour alone.

`HistoryStrip` links every cell; `OutcomeStrip` links the whole strip. That is not an
inconsistency: 50 rows × 8 cells would be 400 tab stops between the top and bottom of a
table.

### Conventions

- **URL is the state store.** `?days=`, `?volume=share`, `?rate=branch`, `?verdict=`,
  `?show=all`, `?search=`, `?status=`, `?suite=`, `?tag=k:v` (repeatable), `?result=`,
  `?cursor=`. Range and toggle links must carry the other selections — building them by
  hand is how they get dropped.
- **Snap enum-ish params to the offered set, do not clamp.** Clamping accepts `?days=45`
  and measures 45 days with no button highlighted, so the URL and the control disagree.
- **Server components by default.** A client component is justified by interaction that
  cannot be a link. Charts that need hover are clients; ranked bars and outcome strips are
  not, so a page of 50 does not ship 50 components.
- **Capability-gated UI renders nothing** rather than a disabled control.

### Design tokens & accessibility

Tokens are CSS custom properties in `globals.css` (light + dark, both explicit —
dark is a selected set of steps, not an automatic flip).

- `--color-status-passed/failed/flaky/error/skipped` — **reserved for status**
- `--color-series-1/2/3` — categorical; only three, validated (worst CVD ΔE 9.2).
  `series-3` is under 3:1 against the surface, so anything using it must be
  direct-labelled. A fourth series folds into "other" rather than inventing a hue.
- `passRateTone()` + `TONE_COLOR` in `lib/health.ts` — the shared bands (≥98 healthy,
  ≥90 degraded, <90 critical) so a bar and a tile never disagree about the same number.

Hard rules: pass/fail is **never** carried by colour alone (`status-passed` ↔
`status-failed` are ΔE 4.1 apart under deuteranopia) — every status pairs colour with a
glyph or label, stacked segments keep a fixed order separated by 2px surface gaps, and
counts appear as text. No dual-axis charts, ever.

---

## 9. Configuration

`.env` at the repo root (copy `.env.example`). `pnpm dev` sources it; the `db:*` scripts
load it themselves via `packages/db/scripts/load-env.ts`, which walks up to five parents to
find it.

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | **`.env` does not run shell substitution** — write the username literally |
| `REDIS_URL` | queue + cache + SSE pub/sub |
| `BLOB_DRIVER` | `fs` (local, zero infra) or `s3`; both implement one signed-URL contract |
| `BLOB_BUCKET`, `BLOB_LOCAL_DIR` | |
| `S3_*` | read only when `BLOB_DRIVER=s3`; missing credentials fail at boot, not at first upload |
| `AUTH_SECRET` | `openssl rand -base64 32` |
| `AUTH_URL`, `AUTH_GOOGLE_ID/SECRET`, `AUTH_ALLOWED_DOMAINS` | |
| `AUTH_DEV_LOGIN` | password-less local sign-in; impossible in production |
| `TESTCENTER_ADMIN_EMAILS` | platform admins, re-asserted every sign-in |
| `TESTCENTER_RETENTION_MONTHS`, `TESTCENTER_PARTITION_LOOKAHEAD` | partition maintenance |
| `MAX_ARTIFACT_BYTES`, `MAX_RUN_BYTES` | ingest limits |
| `LOG_LEVEL`, `OTEL_*` | |

`NODE_ENV` is deliberately **not** set in `.env` — forcing `development` breaks
`next build` (React's server renderer picks the wrong condition and prerendering fails).

Config is validated once at startup by `loadEnv` and fails loudly. A misconfigured blob
store that only surfaces during the first 300 MB upload is a far worse failure than
refusing to boot.

---

## 10. Local development

```bash
pnpm install
cp .env.example .env        # set AUTH_SECRET, DATABASE_URL
pnpm build                  # REQUIRED first — workspace packages resolve to dist/
pnpm db:migrate
pnpm dev
```

Postgres and Redis via Docker (`pnpm stack:up`, includes MinIO) or natively via brew — see
the README for both, including the two macOS traps (`.env` shell substitution and a
Homebrew `redis.conf` that references modules it did not install).

### Testing

Vitest. `packages/db` tests run against a **real local Postgres** — `access.test.ts`
creates two organisations plus an unaffiliated user and tries to read across using ids that
are perfectly valid in their own tenant; a hidden organisation and a nonexistent one return
the identical error so slugs cannot be enumerated.

`pnpm verify` = `format:check` + `lint` + `typecheck` + `test`, which is what CI runs.

The partition-DDL test in `schema.test.ts` can deadlock against the worker's
partition-maintenance job. Environmental; re-run.

### Migrations

Plain SQL in `packages/db/sql/`, applied in filename order, **checksummed** — an
already-applied migration cannot be edited unnoticed. Add `NNNN_name.sql`; never edit an
applied file (change the index or constraint in a new migration instead).

| Migration | Contents |
| --- | --- |
| `0001_init` | full initial schema, partitioning, indexes |
| `0002_run_warnings` | import warnings on runs |
| `0003_repair_double_encoded_jsonb` | fixes rows where jsonb was pre-stringified |
| `0004_multi_tenancy` | memberships, roles, self-serve orgs, trigram index, backfill |
| `0005_run_verdicts` | append-only run verdicts |

---

## 11. Gotchas that have cost real time

Collected so the next person does not rediscover them. Most are also comments at the site.

**Database / driver**

- `jsonb` must be bound with `sql.json()`. Pre-stringifying stores a JSON *string*; nothing
  errors, but `tags @> …` silently stops matching and `jsonb_array_length()` fails.
- `int8`/`bigint` arrives as a **string**. Coerce it, or `formatDuration("2687693")` and any
  arithmetic concatenates.
- drizzle and raw SQL need **separate pools**; `drizzle(sql)` mutates the instance it is
  given and the raw path can no longer bind a `Date`.
- Helpers that run inside `sql.begin()` take **`Queryable`**, not `Sql` — postgres.js hands
  the callback a `TransactionSql` which is not assignable to `Sql`.
- Deleting rows does **not** fix rollups; see §3.

**Next.js / React**

- Functions cannot be passed from a server component to a client one. Pass serializable
  descriptors.
- Next does not read the monorepo-root `.env`; `pnpm dev` sources it before running Turbo.

**CSS / layout**

- `min-w-0` on flex children that must truncate — a flex item will not shrink below
  min-content, so a long name pushes siblings out and `truncate` never engages.
- `minmax(0,1fr)` not `1fr` for grid tracks holding long unbroken strings.
- Tailwind `divide-*` borders children by DOM order, not grid position — in a wrapping grid
  it draws stray borders and cannot express "between rows".
- Hover must never be the only route to content (no hover on touch) and must never change
  layout — reading a chart should not require holding the mouse still.

**Shell / CI scripts**

- bash `printf "'$char"` yields a **signed** char, so a UTF-8 byte like `0xE2` returns `-30`
  and `%02X` renders `FFFFFFFFFFFFE2`. Mask with `& 0xFF` when percent-encoding.
- Always quote arguments containing `&` — an unquoted `&` backgrounds the command and the
  script silently receives a truncated value while still exiting 0.
