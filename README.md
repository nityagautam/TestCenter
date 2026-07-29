# Test Center

Test intelligence for every framework. Ingest test results from pytest, Playwright, JUnit,
TestNG, Cypress, Jest and others — via direct upload or API/CI — then triage and trend them.

**Docs:** [user guide — login, roles, walkthrough](docs/user-guide.md) ·
[bug register and backlog](docs/known-issues.md) ·
[architecture and phase plan](docs/test-center-plan.md)

**Status: multi-tenant product.** Sign in, land in the organisations you have access to,
create projects, upload results from CI or the browser, then search tests and read a
test's full history. See [`docs/test-center-plan.md`](docs/test-center-plan.md) for the
architecture and phase plan.

Scope lives in the URL — `/o/:org` for views that span projects, `/o/:org/p/:project`
for project-scoped ones — so every link is shareable and unambiguous.

| Page | What it does |
| --- | --- |
| `/o/:org` | Dashboard: pass-rate and duration trends, outcome volume, flakiest and most-failing tests |
| `/o/:org/runs` | Filterable run list — branch, env, framework, tag facets, keyset pagination |
| `/o/:org/runs/:id` | Summary tiles, suite tree, failures-first result table, stack traces, tag editing |
| `/o/:org/tests` | Search by name fragment; filter by failing / flaky / slow / quarantined |
| `/o/:org/tests/:id` | **Test history** — outcome strip, distinct failure modes, every failure in full |
| `/o/:org/flaky` | Flaky leaderboard with the CI time each flake has burned |
| `/o/:org/projects` | Projects, and creating one (mints a CI token and shows the recipe) |
| `/o/:org/settings/members` | Grant access by email, set roles, revoke |
| `/o/:org/settings/tokens` | Create and revoke CI tokens |

## Access model

Organisation membership grants access to every project in that organisation; roles
control what you can *do*. A new user either creates their own organisation or is
granted access to an existing one by an administrator — grants are by **email** and
bind to the account at first login, which gives invite ergonomics without needing to
send mail.

| Role | Can |
| --- | --- |
| viewer | read results |
| member | upload results, edit tags, quarantine tests |
| maintainer | create and edit projects |
| admin | manage members and API tokens |
| owner | everything, including deleting the organisation |

Platform admins (`TESTCENTER_ADMIN_EMAILS`) see and can grant access to every
organisation. That list is re-asserted on every sign-in, so privilege cannot be
escalated from inside the app and removing an address actually revokes it.

## Architecture in one paragraph

Uploads go **direct to object storage** via presigned URLs and are stored immutably — the raw
artifact is the source of truth, the database is a derived projection that can be recomputed
when a parser improves. The API records metadata and enqueues; a long-running worker
stream-parses (never buffering a 300 MB XML), normalizes to one canonical model, bulk-inserts,
and rolls up. Dashboards read pre-aggregated rows, never `COUNT(*)` over millions.

Three portable primitives only — Postgres, Redis, S3-compatible storage — reached through
ports in `packages/core`. Infrastructure SDKs may only be imported inside
`packages/adapters`, enforced by an ESLint rule, which is what keeps the hosting decision
open.

```
apps/web           Next.js App Router — UI + API route handlers
apps/worker        long-running ingest/rollup/maintenance worker (containerized)
packages/core      canonical result model, fingerprinting, ports, config, logging
packages/parsers   parser registry + streaming JUnit/xUnit XML parser
packages/db        migrations, partitions, ingest persistence, read-path queries
packages/adapters  the ONLY place S3/Redis SDKs are imported
```

## Ingesting results

One command, no dependencies:

```bash
curl -X POST "$TESTCENTER_URL/api/v1/ingest?project=demo&branch=main&tag=suite:regression" \
  -H "Authorization: Bearer $TESTCENTER_TOKEN" \
  -F "report=@reports/junit.xml"
```

For large reports, bytes go straight to object storage and never through the API:

```
POST /api/v1/runs              → { runId, uploads: [{ uploadUrl }] }
PUT  <uploadUrl>               → the report bytes
POST /api/v1/runs/:id/complete → queues parsing
```

Mint a token with `pnpm --filter @testcenter/db mint-token <project-key>`.

One JUnit/xUnit parser covers pytest `--junitxml`, Playwright's junit reporter, Maven
Surefire, Gradle, jest-junit, Cypress, Robot and TestNG.

## Getting started

Prerequisites: Node 22+ and pnpm (via `corepack enable pnpm`).

```bash
pnpm install
cp .env.example .env      # then set AUTH_SECRET: openssl rand -base64 32
```

### Option A — Docker

```bash
pnpm stack:up             # Postgres + Redis + MinIO, bucket auto-created
# in .env: BLOB_DRIVER=s3
```

### Option B — native, no Docker

```bash
brew install postgresql@17 redis
brew services start postgresql@17
brew services start redis
createdb testcenter
# in .env:
#   DATABASE_URL=postgresql://$(whoami)@localhost:5432/testcenter
#   BLOB_DRIVER=fs
```

If Postgres fails to start with `could not open directory
"/usr/local/lib/postgresql@17"`, Homebrew linked the libs without the version
suffix the binary was compiled to expect (`pg_config --pkglibdir` shows the path it
wants). Repair with:

```bash
ln -sfn ../Cellar/postgresql@17/$(ls /usr/local/Cellar/postgresql@17)/lib/postgresql \
  /usr/local/lib/postgresql@17
ln -sfn ../Cellar/postgresql@17/$(ls /usr/local/Cellar/postgresql@17)/share/postgresql \
  /usr/local/share/postgresql@17
brew services restart postgresql@17
```

`BLOB_DRIVER=fs` is a filesystem blob store that implements the same signed-URL upload
contract as S3, so the upload path you exercise locally is the production path rather than a
special case that hides bugs until deploy.

### Then

```bash
pnpm db:migrate           # apply migrations, provision partitions
pnpm dev                  # web on http://localhost:3000, worker alongside
```

Visit <http://localhost:3000>. You will be sent to `/signin` — sign in with
`admin@testcenter.dev` (email only, no password; see the
[user guide](docs/user-guide.md) for why, and for the other roles).

Health JSON: `curl localhost:3000/api/health?deep=1`.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | web + worker in watch mode |
| `pnpm verify` | format check, lint, typecheck, unit tests — what CI runs |
| `pnpm db:migrate` | apply migrations and provision partitions (creates no organisation — sign in, or use `seed-test-org`) |
| `pnpm db:migrate:check` | non-zero exit if anything is unapplied (CI drift guard) |
| `pnpm db:partitions` | create lookahead partitions, drop expired; `--dry-run`, `--list`, `--drain` |
| `pnpm db:reset` | drop and rebuild the schema (refuses non-local databases) |
| `pnpm --filter @testcenter/db mint-token <project>` | create a CI API token (shown once) |
| `pnpm --filter @testcenter/db seed-perf [runs] [tests]` | seed history and assert read-path budgets |
| `pnpm --filter @testcenter/db seed-test-org [days]` | seed the Test Organisation with believable history |
| `pnpm --filter @testcenter/db seed-scenarios [org] [n]` | seed the awkward cases — every run state, layout-breaking content, an n-test run, an empty project |
| `pnpm --filter @testcenter/db seed-users` | apply the account roster (idempotent) — see the [user guide](docs/user-guide.md) |
| `pnpm --filter @testcenter/db remove-org <slug> [--yes]` | delete an organisation and everything under it; dry-run by default |
| `pnpm --filter @testcenter/worker enqueue partitions` | enqueue a real job to smoke-test the queue path |

## Things worth knowing before changing code

**`test_results` is partitioned monthly for retention, not performance.** At the planned
volume (<50k tests/day, ~18M rows/year) a single Postgres handles reads trivially. Dropping a
month is instant DDL; a `DELETE` over the same rows would rewrite the table and hold locks
while teams are using the product. If the partition maintenance job stops, inserts keep
succeeding into `test_results_default` — silently — so `/api/health` checks for the current
month's partition.

**The test fingerprint is the most expensive thing to change.**
`packages/core/src/fingerprint.ts` turns uploads into *history*; flakiness, "when did this
start failing", duration regression, ownership and quarantine all key off it. Changing the
algorithm requires a backfill, which is why `fingerprint_version` is stored on every row. Its
tests cover the cases that matter: the same logical test on a laptop, a GitHub runner, a
GitLab runner and Windows must produce one identity.

**`org_id` is on every tenant-scoped table** even though we ship as a single internal org.
That is the entire cost of staying SaaS-ready and it is near-zero now versus a painful
retrofit. Row-level security, metering and invite flows are deliberately deferred.

**Failure signatures are computed at ingest from day one** even though the clustering UI is
Phase 3, so that feature opens against real history instead of an empty table.

**jsonb values must be bound with `sql.json()`.** postgres.js JSON-encodes anything bound
to a jsonb column or an explicit `::jsonb` cast, so pre-stringifying stores a JSON *string*
scalar. Nothing errors on insert — but `tags @> ...` silently stops matching and
`jsonb_array_length()` fails outright. Migration `0003` repairs such rows and a test pins
the encoding.

**drizzle and raw SQL need separate connection pools.** `drizzle(sql)` mutates the
postgres.js instance it is given, and afterwards the raw template path can no longer bind a
`Date`. `createClient` therefore opens one pool per access style; the ingest hot path uses
raw SQL for bulk inserts while everything else uses drizzle.

**Read-path budget is enforced, not assumed.** `seed-perf` measures the five queries the UI
issues against real data and fails if any exceeds 400ms p95. At 400k results they run in
2–6ms and pages render in 18–48ms.

**Isolation is tested from the outside, not assumed.** `packages/db/src/access.test.ts`
creates two real organisations and a third unaffiliated user, then tries to read across
using ids that are perfectly valid in their own tenant. A hidden organisation and a
nonexistent one return the identical error, so slugs cannot be enumerated.

**The flake score is calibrated, and the calibration was wrong once.** It combines
retry-flakiness (failed then passed inside one run — the highest-confidence signal) with
status instability, counting the latter only at two or more flips so a consistently
failing test scores 0 and stays out of the flake list. A linear weighting was tried
first and scored a test needing retries in 30% of its runs at **15.8** — below the
threshold the dashboard used to call anything flaky, and below a test that merely failed
sometimes. The saturating curve puts a 20% retry rate near 80 and keeps the ordering
faithful to signal strength. `seed-test-org` exists partly to make this checkable.

**Red/green pass-fail bars are unreadable for red-green colourblind users** —
status-good and status-critical measure ΔE 4.1 under deuteranopia. Green/red is
unavoidable domain convention for tests, so pass/fail is never carried by colour alone:
every status is paired with a label or glyph, stacked segments keep a fixed order
separated by 2px surface gaps, and counts appear as text beside every chart. Removing
any of those breaks the charts for those readers.

**Functions cannot be passed from a server component to a client one.** Both chart
components originally took a `formatValue`/`hrefFor` callback and failed at runtime with
a 500. They now take serializable descriptors (`format="percent"`, `runHrefBase`). If you
add a client component prop, keep it serializable.
