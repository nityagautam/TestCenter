# Test Center

Test intelligence for every framework. Ingest test results from pytest, Playwright, JUnit,
TestNG, Cypress, Jest and others — via direct upload or API/CI — then triage and trend them.

**Status: Phase 1 complete — the product is usable.** Upload a JUnit XML report from the
browser or from CI, then browse runs, drill into failures, and filter by tag. See
[`docs/test-center-plan.md`](docs/test-center-plan.md) for the architecture and phase plan.

| Page | What it does |
| --- | --- |
| `/` | Health across recent runs, per-project pass rate |
| `/runs` | Filterable run list — branch, env, framework, tag facets, keyset pagination |
| `/runs/:id` | Summary tiles, suite tree, failures-first result table, stack traces, tag editing |
| `/upload` | Drag-and-drop upload with live parse progress, plus CI recipes |

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
pnpm db:migrate           # apply migrations, provision partitions, bootstrap org/project
pnpm dev                  # web on http://localhost:3000, worker alongside
```

Visit <http://localhost:3000> for the status board, or `curl localhost:3000/api/health?deep=1`.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | web + worker in watch mode |
| `pnpm verify` | format check, lint, typecheck, unit tests — what CI runs |
| `pnpm db:migrate` | apply migrations, provision partitions, bootstrap org/project |
| `pnpm db:migrate:check` | non-zero exit if anything is unapplied (CI drift guard) |
| `pnpm db:partitions` | create lookahead partitions, drop expired; `--dry-run`, `--list`, `--drain` |
| `pnpm db:reset` | drop and rebuild the schema (refuses non-local databases) |
| `pnpm --filter @testcenter/db mint-token <project>` | create a CI API token (shown once) |
| `pnpm --filter @testcenter/db seed-perf [runs] [tests]` | seed history and assert read-path budgets |
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
