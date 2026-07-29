# Test Center — Architecture & Phased Delivery Plan

Status: draft v1 (2026-07-29)
Owner: Ashutosh Mishra

---

## 1. What we are building

A multi-team test intelligence platform that ingests test execution results from any
framework (pytest, Playwright, JUnit, TestNG, Cypress, Jest, Robot, Go test, …) via
**direct upload** or **API/CI integration**, normalizes them into one canonical model,
and exposes fast, filterable dashboards plus analytics (flakiness, failure clustering,
trends, ownership, quality gates).

### Design principles

1. **The raw artifact is the source of truth; the database is derived.**
   Every uploaded file is stored immutably in object storage. Parsing is a re-runnable
   projection. When we improve a parser or add a field, we re-parse history — we never
   have to ask teams to re-upload.
2. **Ingest is async; reads are precomputed.**
   Upload returns in milliseconds. Parsing, normalization and rollups happen on workers.
   Dashboards read pre-aggregated tables, never `COUNT(*)` over millions of rows.
3. **One canonical schema, many parsers.**
   Framework knowledge lives only in pluggable parsers. Everything downstream
   (UI, analytics, alerts) is framework-agnostic.
4. **Every entity is tag-addressable.**
   Tags are first-class on runs *and* tests, indexed, and drive saved views, dashboards,
   alert routing and gates. (This is the feature you already had in mind, promoted to a
   core primitive rather than a label field.)
5. **Boring, scalable defaults first.** Postgres until it hurts; add a columnar store only
   when volume proves the need. No premature distributed systems.

---

## 1b. Decisions locked (2026-07-29)

| Decision | Choice | Consequence for the design |
|---|---|---|
| **Hosting** | Not decided — stay portable | Everything runs in containers against **portable primitives only**: Postgres, Redis, S3-compatible object storage. No platform-specific services in `packages/core` or the worker (no Vercel Blob/Queues SDK, no SQS-only assumptions) — access storage/queue through a thin interface with an S3 + Redis implementation. Result: deployable to Vercel + managed services, to k8s, or to a single VM with Docker Compose, decided later without a rewrite. |
| **Volume** | Small: <100 runs/day, <50k tests/day | **Postgres-only, permanently.** ~18M result rows/year — well inside single-instance Postgres. **ClickHouse is cut from the plan**, not deferred. No read replicas, no dual-write, no OLAP mirror. Partitioning stays, but justified by *cheap retention* (drop a partition = instant delete) rather than query performance. |
| **Backend** | TypeScript end-to-end | Next.js route handlers + Node worker + BullMQ, shared types with parsers and UI. Parser coverage is unaffected — Allure, pytest-json-report, Playwright JSON and Cucumber are all JSON; Robot/TestNG/JUnit are XML via `sax`. No Python needed. |
| **Tenancy/auth** | Internal now, SaaS-ready later | Google Workspace OIDC on day one. `org_id` threaded through every table, query and API path from Phase 0 so multi-tenancy is a config flip. **Skip now:** row-level security, per-tenant isolation test suites, usage metering, billing, invite flows. Nothing pulled forward from Phase 4. |

**What these answers removed from scope:** ClickHouse, read replicas, pgBouncer, dual-write
pipelines, RLS, metering, SCIM, and the 50-concurrent-ingest load test. That is roughly
3–4 weeks of Phase 5 work deleted outright. Phase 5 becomes a short hardening phase.

---

## 2. Non-functional targets (drive the design)

Sized to the actual volume (<100 runs/day, <50k tests/day), not to a hypothetical.

| Concern | Target |
|---|---|
| Upload API p99 | < 300 ms (accepts and enqueues; does not parse) |
| Parse latency | < 15 s for a 10 MB / 20k-test report; < 2 min for 200 MB |
| Dashboard TTFB | < 400 ms p95 |
| Result table interaction | 50k rows scrollable/filterable at 60 fps (virtualized + server-side filter) |
| Concurrency | 50 simultaneous interactive users, 5 concurrent ingests |
| Max report size | 500 MB single file, 5 GB per run (sharded) |
| Retention | configurable per project: results 180–365 d, aggregates 2 y, artifacts 30–90 d |
| Availability | 99.9% for read path; ingest degrades to queue-only, never rejects |
| Steady-state size | ~18M `test_results` rows/year — single Postgres instance, no sharding ever needed |

---

## 3. High-level architecture

```
   CI (GitHub/GitLab/Jenkins)        Browser (direct upload)
        │  testcenter CLI /               │
        │  GH Action / curl               │
        ▼                                 ▼
 ┌──────────────────────────────────────────────────┐
 │  API Gateway  (Next.js Route Handlers / FastAPI) │
 │  auth: session (UI) | project API token (CI)     │
 │  rate limit + idempotency keys                   │
 └───────┬──────────────────────────────┬───────────┘
         │ 1. create run (metadata)     │ 4. queries
         │ 2. presigned PUT for files   │
         │ 3. mark run complete ────┐   │
         ▼                          │   ▼
  ┌─────────────┐            ┌──────▼────────────────┐
  │ Object store│            │  Job Queue            │
  │ (S3-compat) │            │  (Redis + BullMQ)     │
  │ raw reports │            └──────┬────────────────┘
  │ attachments │                   │
  └─────┬───────┘                   │
        │ download            ┌─────▼──────────────────────────┐
        └────────────────────►│  Ingest Workers                │
                              │  detect → parse (streaming)    │
                              │  → normalize → bulk COPY       │
                              │  → merge shards → rollups      │
                              │  → flake/cluster/notify        │
                              └─────┬──────────────────────────┘
                                    │
                    ┌───────────────▼───────────────┐
                    │ Postgres (single instance,     │
                    │   monthly partitions)          │
                    │ Redis (cache, pub/sub, locks)  │
                    └───────────────┬───────────────┘
                                    │  SSE stream for live run status
                              ┌─────▼──────┐
                              │  Web app   │
                              └────────────┘
```

### Service decomposition

Start as a **modular monolith in a monorepo** with a separate worker process. Same repo,
same types, independent scaling. Do not start with microservices.

```
apps/
  web/          Next.js App Router — UI + API route handlers
  worker/       ingest/parse/rollup/notify jobs (long-running or serverless-triggered)
  cli/          `testcenter` uploader binary
packages/
  db/           schema, migrations (Drizzle/Prisma), typed queries
  core/         canonical model, zod schemas, fingerprinting, flake + cluster algorithms
  parsers/      one module per format, registry with detect()/parse()
  contracts/    OpenAPI spec + generated clients
  ui/           shadcn-based component library
integrations/
  github-action/ jenkins-shared-lib/ gitlab-template/
```

---

## 4. Canonical data model

### 4.1 Canonical result envelope (what every parser emits)

```jsonc
{
  "schemaVersion": "1.0",
  "run": {
    "project": "checkout-web",
    "framework": "playwright",       // detected or declared
    "frameworkVersion": "1.52",
    "name": "nightly-regression",
    "startedAt": "2026-07-29T02:00:00Z",
    "durationMs": 1843000,
    "environment": "staging",
    "branch": "main",
    "commitSha": "9f3c1ab",
    "pullRequest": 4821,
    "ci": { "provider": "github", "buildId": "1198", "jobUrl": "https://..." },
    "shard": { "index": 3, "total": 8, "groupId": "gh-1198" },
    "attempt": 1,
    "tags": { "suite": "regression", "browser": "chromium", "release": "24.9", "owner": "payments" },
    "uploadedBy": "svc-ci"
  },
  "results": [
    {
      "suite": "specs/checkout/payment.spec.ts",
      "classname": "Checkout > Payment",
      "name": "declines expired card",
      "parameters": { "cardType": "visa" },      // data-driven cases
      "status": "failed",                         // passed|failed|skipped|error|blocked
      "durationMs": 4120,
      "startedAt": "...",
      "retries": [ { "attempt": 1, "status": "failed" } ],
      "failure": {
        "type": "AssertionError",
        "message": "expected 'Declined' to equal 'Approved'",
        "stackTrace": "...",
        "snippet": "...",
        "expected": "Approved",
        "actual": "Declined"
      },
      "stdout": "...", "stderr": "...",
      "attachments": [
        { "kind": "screenshot", "name": "failure.png", "storageKey": "..." },
        { "kind": "trace", "name": "trace.zip", "storageKey": "..." }
      ],
      "tags": { "severity": "p1", "jira": "PAY-1234" },
      "owner": "payments"
    }
  ]
}
```

### 4.2 Core tables (Postgres, abbreviated DDL)

```sql
-- tenancy
organizations(id uuid pk, name, slug uniq, plan, created_at)
teams(id uuid pk, org_id fk, name, slug)
users(id uuid pk, email uniq, name, avatar_url, status)
memberships(user_id fk, org_id fk, team_id fk null, role)  -- owner|admin|maintainer|member|viewer
projects(id uuid pk, org_id fk, team_id fk, key uniq, name, default_branch,
         retention_days, settings jsonb)
api_tokens(id uuid pk, project_id fk null, org_id fk, name, token_hash,
           scopes text[], last_used_at, expires_at, created_by)

-- ingest
artifacts(id uuid pk, project_id fk, run_id fk null, storage_key, bytes,
          content_type, sha256, detected_format, uploaded_at)
ingest_jobs(id uuid pk, artifact_id fk, state, attempts, error, timings jsonb)

-- runs
runs(
  id uuid pk,                   -- uuidv7 for time-ordered locality
  project_id fk, name, framework, framework_version,
  status text,                  -- pending|parsing|complete|failed|partial
  started_at timestamptz, finished_at timestamptz, duration_ms int,
  branch text, commit_sha text, pr_number int, environment text,
  ci_provider text, ci_build_id text, ci_job_url text,
  run_group_id text, shard_index int, shard_total int, attempt int,
  total int, passed int, failed int, skipped int, errored int, flaky int,
  pass_rate numeric(5,2),
  tags jsonb,                   -- GIN indexed
  created_by uuid, created_at timestamptz
);
CREATE INDEX ON runs (project_id, started_at DESC);
CREATE INDEX ON runs USING GIN (tags jsonb_path_ops);
CREATE INDEX ON runs (project_id, branch, started_at DESC);

-- stable identity of a test across runs  ← enables all history features
test_cases(
  id bigserial pk, project_id fk,
  fingerprint bytea uniq,       -- sha256(project, suite, classname, name, params)
  suite text, classname text, name text, parameters jsonb,
  owner_team_id uuid null,
  first_seen_at, last_seen_at,
  -- maintained rollups
  runs_30d int, fail_rate_30d numeric, flake_score numeric,
  avg_duration_ms int, p95_duration_ms int, quarantined bool
);

-- the big one: partitioned monthly by started_at
test_results(
  id bigserial, run_id uuid, test_case_id bigint, project_id uuid,
  status text, duration_ms int, retry_count smallint, was_flaky bool,
  failure_type text, failure_message text, failure_signature bytea,  -- clustering key
  stack_trace text, tags jsonb, started_at timestamptz
) PARTITION BY RANGE (started_at);
CREATE INDEX ON test_results (run_id, status);
CREATE INDEX ON test_results (test_case_id, started_at DESC);
CREATE INDEX ON test_results (project_id, failure_signature, started_at DESC);

attachments(id uuid pk, test_result_id, run_id, kind, name, storage_key, bytes)

-- derived / analytics
failure_clusters(id uuid pk, project_id, signature bytea, title, sample_result_id,
                 first_seen_at, last_seen_at, occurrences, status)  -- open|triaged|resolved
project_daily_stats(project_id, day date, branch, runs, tests, pass_rate,
                    avg_duration_ms, flaky_count)   -- PK(project_id, day, branch)
saved_views(id uuid pk, project_id, user_id null, name, filter jsonb, is_shared)
quality_gates(id uuid pk, project_id, rules jsonb, enabled)
notification_rules(id uuid pk, project_id, channel, target, conditions jsonb)
audit_log(id bigserial, org_id, actor_id, action, entity, entity_id, meta jsonb, at)
share_links(id uuid pk, run_id, token_hash, expires_at, created_by)
```

**Why `test_cases` matters:** the fingerprint is what turns a pile of uploads into
*history*. Flakiness, "when did this start failing", duration regression, ownership and
quarantine all hang off it. Getting the fingerprint right early is the single highest-value
schema decision — it is expensive to change later (needs a backfill).

Fingerprint rule: `sha256(project_id | normalized_suite_path | classname | test_name | sorted_params)`.
Normalize: strip absolute paths, shard suffixes, worker ids, timestamps, retry markers.

---

## 5. Ingestion pipeline (the heart of the system)

### 5.1 Upload protocols

**A. Three-step API (default for CI, handles large files):**

```
POST /api/v1/runs                     → { runId, uploadUrls[] }   (metadata + intent)
PUT  <presigned url>                  → direct-to-object-storage, bypasses our servers
POST /api/v1/runs/{runId}/complete    → enqueues parse, returns immediately
GET  /api/v1/runs/{runId}             → poll, or SSE /events for live status
```

**B. Single-shot (small reports, easiest adoption):**

```
POST /api/v1/ingest?project=web&branch=main&tag=suite:smoke
Content-Type: multipart/form-data
```

**C. Browser upload:** drag-and-drop multiple files/zip → same presigned flow → live
parse progress via SSE.

Cross-cutting: `Idempotency-Key` header (safe CI retries), gzip/zip auto-expansion,
per-token rate limits, max-size guards, virus/zip-bomb protection.

### 5.2 Worker stages

| Stage | Job | Notes |
|---|---|---|
| 1 | `detect` | sniff format by root element / JSON shape / filename; confidence-scored registry |
| 2 | `parse` | **streaming** SAX/JSON-stream parsers — never load a 300 MB XML into memory; emit batches of 1000 results |
| 3 | `normalize` | fingerprint, upsert `test_cases`, resolve owner, compute `failure_signature`, dedupe retries into one result + retry chain |
| 4 | `persist` | `COPY`/bulk insert into partitioned `test_results`; one transaction per batch |
| 5 | `merge` | if `run_group_id` present, wait for all shards (or timeout) and merge into one logical run |
| 6 | `rollup` | run counters, `project_daily_stats`, `test_cases` rollups, flake scores |
| 7 | `analyze` | failure clustering, new-failure detection, duration regressions, quality gate evaluation |
| 8 | `notify` | Slack/Teams/webhook/email; GitHub check-run + PR comment |

Idempotent per stage, resumable, `at-least-once` safe (natural keys + upserts).
Dead-letter queue with a UI to inspect and replay failed ingests.

### 5.3 Parser plugin contract

```ts
export interface Parser {
  id: string;                                    // "junit-xml", "playwright-json", ...
  detect(head: Buffer, filename: string): number; // 0..1 confidence
  parse(stream: Readable, ctx: ParseContext): AsyncIterable<ResultBatch>;
}
```

Ship order (by adoption value):

- **Phase 1:** JUnit/xUnit XML (covers pytest `--junitxml`, Playwright junit reporter,
  Maven Surefire, Gradle, Jest `jest-junit`, Cypress, Robot, TestNG-as-junit) — one parser,
  ~70% of the market.
- **Phase 2:** Playwright JSON, TestNG native XML, Allure results dir, pytest-json-report,
  Cucumber JSON, .NET TRX, NUnit/xUnit v2, Mochawesome, Go `test -json`, Robot `output.xml`,
  HTML report ingest (store + link, extract summary where structured data is embedded).
- **Phase 3+:** community/custom parser via a declarative mapping config (JSONPath/XPath →
  canonical fields) so teams can onboard a niche format without a code change.

> Note on HTML: HTML reports are for humans, not data. Policy — always store and serve the
> HTML as a linked artifact, but require a machine-readable file for analytics. Where a
> known HTML report embeds JSON (Playwright, Allure, Mochawesome), extract it.

---

## 6. Read path & "smooth and fast" strategy

This is where multi-team apps usually fall over. Concrete measures:

**Database**
- Keyset (cursor) pagination everywhere — never `OFFSET` on large tables.
- Server-side filtering/sorting/aggregation; the client never receives 50k rows unfiltered.
- Partition pruning on `started_at` for all history queries.
- Materialized rollups (`project_daily_stats`, `runs.*` counters, `test_cases.*`) so
  dashboards are single-row-per-day reads.
- `pg_stat_statements` + a slow-query budget in CI (any query > 100 ms gets flagged).

At this volume a single well-indexed Postgres instance is not the bottleneck — the frontend
is. Spend the performance effort on the client and the cache layer, not on the database.

**Caching**
- Redis: hot dashboard aggregates (30–120 s TTL), tag facet counts, tag-based invalidation
  on run completion.
- HTTP: `stale-while-revalidate` on CDN for completed runs (immutable once complete → cache
  aggressively with `immutable` + versioned keys).
- Completed runs are immutable → their detail payloads can be cached ~forever.

**Frontend**
- Next.js App Router: Server Components for shell + streaming Suspense so the page paints
  before the heavy table resolves.
- TanStack Query for client cache/dedupe; TanStack Table + Virtual for windowed rendering
  of huge result lists.
- URL is the state (filters/tags/sort are shareable links) → free deep-linking and caching.
- Precompute a compact "run summary" JSON blob per run in object storage; the run page
  fetches one CDN-cached file instead of hitting Postgres.
- Prefetch on hover/intent, optimistic tag edits, skeletons over spinners.
- Route-level code splitting; keep trace/video viewers lazy.

**Realtime**
- SSE (`text/event-stream`) per run and per project for parse progress and new-run pushes.
  Simpler and cheaper than WebSockets and works on serverless; upgrade to WS only if we add
  collaborative editing.

**On columnar stores — explicitly out of scope.**
ClickHouse and friends earn their complexity somewhere north of ~500M rows. At <50k tests/day
we reach ~18M rows/year, so Postgres with monthly partitions and rollup tables will serve
this workload indefinitely. The only thing we preserve is *optionality*: analytics queries
live behind repository functions in `packages/db`, so if the volume assumption is ever wrong
by an order of magnitude, swapping their implementation is a contained change rather than a
re-architecture. Do not build for it now.

---

## 7. Feature catalog

### Tier 1 — table stakes (Phases 1–2)
1. Multi-format ingest via UI upload + API + CI integrations.
2. Run list with rich filters: project, branch, env, status, framework, date, **tags**.
3. Run detail: summary tiles, suite tree, result table, failure details, stack traces,
   stdout/stderr, attachments (screenshot/video/trace).
4. **Tagging system** — reserved keys (`env`, `branch`, `suite`, `browser`, `device`,
   `shard`, `release`, `owner`) + free-form `key:value`; auto-derived from CI env vars;
   editable post-upload; typeahead with facet counts; bulk tag/retag.
5. Saved views — a named filter+tag combination pinned to a dashboard or shared with a team.
6. Sharded/parallel run merging (one logical run from 8 CI shards).
7. Projects, teams, roles, API tokens.
8. Full-text search across test names and failure messages.

### Tier 2 — intelligence (Phase 3)
9. **Test history & timeline** — per-test sparkline of last N runs, pass/fail heat strip,
   duration trend, "first failed at commit X", direct link to the CI job.
10. **Flaky detection & quarantine** — classify a test flaky when (a) it passes on retry
    within a run, (b) it produces different outcomes on the same commit, or (c) its status
    flips above a threshold in a rolling window. Flake score, flake leaderboard, one-click
    quarantine (excluded from gates, still reported), auto-unquarantine when stable for N runs.
11. **Failure clustering / root-cause grouping** — normalize error message + top user-code
    stack frames into a `failure_signature`; group "1 cause → 47 failing tests". Cluster
    lifecycle (open/triaged/resolved), assignee, linked ticket. This is the highest-value
    differentiator: it turns a wall of red into 3 actionable items.
12. **Run comparison / diff** — newly failed, newly passed, still failing, new tests,
    removed tests, duration deltas. Baseline = last green on the target branch.
13. **Trends & analytics** — pass rate over time, suite duration trend, flakiness trend,
    slowest tests, duration regression alerts, CI-time-wasted-by-flakes estimate.
14. **PR/commit integration** — GitHub Check Run + sticky PR comment: "3 new failures,
    2 known flakes, +4 min duration", with deep links.

### Tier 3 — collaboration & governance (Phase 4)
15. **Quality gates** — declarative per-project policy (`pass_rate >= 98`, `no_new_failures`,
    `flaky_budget <= 5`, `duration <= baseline * 1.2`); CLI exits non-zero so CI can block merge.
16. **Ownership routing** — path/tag → team mapping (CODEOWNERS-style file or UI rules);
    team-scoped dashboards; alerts land in the owning team's channel.
17. **Notifications** — Slack/Teams/email/generic webhook; event-driven (run failed, new
    cluster, gate breached, flake spike) plus daily/weekly digests.
18. **Shareable read-only links** — expiring public run URLs for stakeholders/vendors.
19. **Requirements traceability** — link tests to Jira/Xray/TestRail IDs via tags; coverage
    and pass rate per requirement/epic; release readiness view.
20. **Release/build view** — aggregate all runs for a release tag across projects into one
    go/no-go dashboard.
21. **Annotations & triage** — comment on a failure, mark "known issue", link a ticket,
    mute a test with an expiry date and a reason.

### Tier 4 — enterprise & scale (Phase 5+)
22. SSO (SAML/OIDC), SCIM provisioning, org-level RBAC, audit log.
23. Data retention & GDPR-style deletion per project; artifact lifecycle to cold storage.
24. Usage metering, per-project quotas, ingest rate limits.
25. Self-host distribution (Docker Compose + Helm chart) for teams that cannot send data out.
26. Public REST + GraphQL API, OpenAPI-generated clients, webhooks out.
27. **AI-assisted triage** (opt-in) — summarize a failure cluster, suggest probable cause,
    propose a fix, auto-title clusters, natural-language query over test data
    ("which payments tests got slower this week?"). Cheap and high-perceived-value once
    clustering exists — do *not* build it before clustering.
28. MCP server / agent access so coding agents can query test health directly.

---

## 8. Phased plan

Estimates assume 2–3 engineers. Each phase ends with something shippable to real users.

### Phase 0 — Foundations (1–2 weeks)

**Goal:** decisions locked, skeleton deployable, CI green.

Sub-tasks:
- Monorepo scaffold (pnpm + Turborepo), TypeScript strict, lint/format, commit hooks.
- **Portability layer:** `packages/core` defines `BlobStore` and `Queue` interfaces;
  implementations are S3-compatible + Redis/BullMQ. No hosting-specific SDK anywhere outside
  those adapters. `docker-compose.yml` for local dev (Postgres + Redis + MinIO) so the whole
  stack runs offline and the hosting decision stays open.
- Postgres + Redis + object storage provisioned for dev/staging.
- Migration tooling; write v1 schema (orgs, projects, users, runs, test_cases, test_results
  partitioned, artifacts). **`org_id` on every tenant-scoped table and in every query
  signature from the first migration** — this is the entire cost of staying SaaS-ready, and
  it is near-zero now versus a painful retrofit later.
- Canonical schema package with zod validation + published JSON Schema.
- Google Workspace OIDC login + org/project bootstrap. No invite flows, no RLS, no metering.
- Partition management job (create next month, drop beyond retention) — retention is the
  reason partitions exist here.
- Observability from day one: structured logs, OpenTelemetry traces, error tracking,
  a `/health` + queue-depth dashboard.
- CI: typecheck, unit, migration check, preview deploy.

**Exit criteria:** empty app deploys to staging; migrations run; a smoke E2E test passes.

---

### Phase 1 — MVP: ingest and see results (3–4 weeks)

**Goal:** a team can upload a JUnit XML and browse it. This is the credibility phase.

Sub-tasks:
- Ingest API (three-step + single-shot), presigned uploads, idempotency, size limits.
- Streaming JUnit/xUnit XML parser + format detection registry.
- Worker: parse → normalize → fingerprint → bulk persist → run rollups. DLQ + replay.
- Browser upload UI with drag-and-drop, multi-file, live SSE progress.
- Run list page: filters (project/branch/status/date), keyset pagination.
- Run detail page: summary tiles, suite tree, virtualized result table, failure panel
  (message, stack trace, stdout/stderr).
- **Tagging v1**: tags on upload (API params + UI), tag chips, filter by tag, facet counts,
  reserved-key validation, post-upload edit.
- Projects + email/password or Google login; single org.
- Perf budget test: seed 5M results, assert dashboard p95 < 400 ms.

**Exit criteria:** one real team runs their nightly suite through it for a week; a 20k-test
report parses in < 15 s; run page opens in < 1 s.

---

### Phase 2 — Multi-framework + CI native (3–4 weeks)

**Goal:** any framework, zero-friction CI adoption.

Sub-tasks:
- Parsers: Playwright JSON, TestNG XML, Allure, pytest-json-report, Cucumber JSON, TRX,
  NUnit, Mochawesome, Go test JSON, Robot `output.xml`. Golden-file test suite per parser
  (real reports committed as fixtures) — non-negotiable for trust.
- Attachments: screenshots/videos/traces uploaded and rendered inline; Playwright trace
  viewer link; HTML report stored and served.
- Sharded run merging via `run_group_id` + completion timeout.
- **CI integrations:** GitHub Action, GitLab CI template, Jenkins shared library snippet,
  plus a documented dependency-free `curl` recipe.
- **`testcenter` CLI**: `testcenter upload --project web --tag suite:smoke ./reports/*.xml`;
  auto-detects CI env vars (branch, SHA, PR, build URL, shard index) so tagging is free.
- Project API tokens with scopes; usage/last-used visibility.
- Re-parse capability (reprocess stored artifacts under a new parser version).
- Public OpenAPI spec + generated TS/Python clients.

**Exit criteria:** 3+ teams and 3+ frameworks onboarded with a ≤ 5-line CI change; parser
golden tests cover every supported format.

---

### Phase 3 — Intelligence (4–5 weeks)

**Goal:** the product stops being a report viewer and starts saving people time.

Sub-tasks:
- Test detail page: history strip, pass/fail timeline, duration trend, retry history,
  first-failure commit, per-run links.
- Flakiness engine: detection rules, rolling flake score, leaderboard, quarantine
  workflow, auto-unquarantine.
- Failure clustering: signature normalization (strip paths/hex/uuids/numbers/timestamps,
  keep top user frames), cluster CRUD, triage state, cluster detail with affected tests
  and timeline.
- Run comparison / diff view against a chosen or auto-selected baseline.
- Trends dashboards: pass rate, duration, flakiness, slowest tests, duration regressions.
- GitHub Check Run + PR comment with new-failure vs known-flake breakdown.
- Nightly/rolling aggregation jobs + backfill command.

**Exit criteria:** a red nightly run collapses from 60 failures to ≤ 5 clusters; flake list
matches what QA already believes is flaky (validate against human intuition).

---

### Phase 4 — Collaboration & governance (3–4 weeks)

**Goal:** works for many teams at once, with guardrails.

Sub-tasks:
- Teams, RBAC (owner/admin/maintainer/member/viewer), project visibility.
- Ownership rules (path/tag → team) and team dashboards.
- Quality gates: rule builder, evaluation in the ingest pipeline, CLI `--gate` exit codes,
  gate history.
- Notifications: Slack/Teams/webhook/email, per-rule conditions, digests, per-team routing.
- Saved views (personal + shared), pinned dashboards, homepage per team.
- Annotations: comments, known-issue marking, ticket links, timed mutes.
- Expiring share links for read-only run access.
- Traceability: requirement tags → coverage view; release/build aggregate dashboard.
- Onboarding: project setup wizard, copy-paste CI snippets, sample reports.

**Exit criteria:** three teams operating independently with their own gates, alerts and
dashboards; zero cross-team permission leaks (verified by tests).

---

### Phase 5 — Hardening (1.5–2 weeks)

Cut down substantially by the locked decisions — no ClickHouse, no replicas, no SCIM,
no metering, no multi-tenant isolation suite.

Sub-tasks:
- Retention jobs end-to-end: partition drop, artifact lifecycle to cold storage, per-project
  retention settings honoured and verified.
- Load test at realistic scale (5 concurrent 100 MB ingests, 50 interactive users) plus one
  10× headroom run to know where the first wall actually is.
- Audit log UI, org-level settings, role review.
- Rate limits per token, upload size/abuse guards.
- Backup + restore drill (actually restore into a scratch DB and verify a run renders).
- SLOs + alerting on ingest lag, queue depth, parse failure rate, p95 latency.
- Hosting decision made here with real data in hand; package for the chosen target
  (Compose or Helm — the portability layer means this is packaging, not porting).
- Accessibility pass (WCAG 2.1 AA).

**Deferred until a real trigger exists:** SAML/SCIM (trigger: a team outside Google
Workspace), RLS + isolation suite (trigger: a second untrusted org), usage metering
(trigger: chargeback or external customers).

---

### Phase 6 — Differentiators (opportunistic)

- AI triage: cluster summarization, probable-cause suggestions, auto-titles, NL query.
- Predictive test selection: suggest the minimal test subset for a diff based on historical
  failure correlation.
- Coverage ingest (Cobertura/LCOV) alongside results.
- Visual-regression diff support (image compare artifacts).
- Cross-project "quality score" and executive/release readiness reporting.
- MCP server so agents can ask "what's failing on main?" and act on it.

---

## 9. Recommended stack

| Layer | Recommendation | Why / alternative |
|---|---|---|
| Frontend | Next.js 16 App Router + TypeScript + Tailwind + shadcn/ui | Streaming SSR, one deploy unit, huge component velocity |
| Tables/charts | TanStack Table + Virtual, Recharts or visx | Handles 50k rows; charts stay in-house |
| Client state | TanStack Query + URL state | Dedupe, cache, shareable filters |
| API | Next.js Route Handlers (+ tRPC internally, REST/OpenAPI externally) | One language end-to-end |
| Workers | Node/TS worker container with BullMQ (Redis) | Shared types with parsers; a long-running process handles 300 MB XML far better than a serverless invocation. Containerized → runs anywhere |
| DB | PostgreSQL 16+, single instance, declarative monthly partitioning | Relational + JSONB + GIN tags + full-text in one engine. Partitions are for retention, not perf |
| ORM | Drizzle | Typed, SQL-first, good with partitions and bulk COPY |
| Cache/queue | Redis | Queue, cache, rate limit, SSE pub/sub |
| Object storage | S3-compatible (MinIO locally, S3/R2 in prod) | Behind a `BlobStore` interface so hosting stays open |
| Auth | Auth.js with Google OIDC | Google Workspace day one; `org_id` modelled throughout for later SaaS |
| Observability | OpenTelemetry + Sentry + Grafana/Datadog | Ingest lag and queue depth are the key SLIs |
| CLI | Go single static binary (or Node + `bun build --compile`) | CI runners must not need a runtime |

---

## 10. Key risks and how we blunt them

| Risk | Mitigation |
|---|---|
| Parser correctness (every framework writes slightly different XML) | Golden-file fixtures from real projects for every format; store raw artifacts so we can re-parse after fixes |
| Volume assumption turns out 10× wrong | Analytics queries isolated behind repository functions; partitions already in place; measure in Phase 5 load test before reacting |
| Hosting decision deferred too long and platform coupling creeps in | `BlobStore`/`Queue` interfaces + a lint rule banning hosting SDK imports outside adapters; local Compose stack keeps everyone honest |
| Fingerprint instability (parametrized/dynamic test names) breaks history | Explicit normalization rules + a fingerprint version column + backfill tooling; hide dynamic segments behind a `parameters` field rather than the name |
| Adoption fails because CI integration is fiddly | Ship a copy-paste GH Action + curl recipe in Phase 2; auto-derive tags from CI env so nobody has to configure metadata |
| Huge uploads OOM the server | Presigned direct-to-storage uploads + streaming parsers; servers never buffer whole files |
| Multi-team noisy dashboards | Ownership routing + saved views + team-scoped homepages in Phase 4 |
| Feature sprawl before value | Phase gates require a real team using it before moving on |

---

## 11. Remaining open questions

Answered in §1b: hosting (deferred, stay portable), volume (small), backend (TypeScript),
tenancy (internal now, SaaS-ready). Still open — none of these block Phase 0:

1. **CI mix:** which CI systems must be first-class in Phase 2? (GitHub Actions assumed
   primary; Jenkins/GitLab as templates.)
2. **Chat platform:** Slack or Teams for notifications in Phase 4?
3. **Test management integration:** Jira, Xray, TestRail — any of these required for the
   traceability feature, or is tag-based linking enough to start?
4. **Pilot team:** which team and which suite is the Phase 1 guinea pig? Pick this before
   Phase 1 starts — the exit criteria depend on a real team using it.
5. **Frameworks in use today**, ranked by volume — this sets the Phase 2 parser order.

---

## 12. Immediate next step

Phase 0, task 1: monorepo scaffold + `docker-compose.yml` (Postgres/Redis/MinIO) +
v1 migrations with `org_id` throughout + the `BlobStore`/`Queue` interfaces. Everything in
Phase 0 is unblocked by the questions above.
