# CLAUDE.md

Context for working in this repository. Read `docs/architecture.md` for the full
developer reference; this file is the short version plus the things that bite.

## What this is

Test Center — multi-tenant test intelligence. Ingests test reports (JUnit/xUnit XML from
pytest, Playwright, Cucumber, Surefire, jest-junit, TestNG…), normalizes them to one
canonical model, and serves triage and trend views over the result history.

pnpm + Turborepo monorepo, TypeScript throughout, Next.js App Router for the web app and a
separate long-running worker for ingest.

## Commands

```bash
pnpm install
pnpm build            # REQUIRED before the first `pnpm dev` — packages resolve to dist/
pnpm dev              # web on :3000 + worker, watch mode
pnpm verify           # format:check + lint + typecheck + test — what CI runs
pnpm db:migrate       # apply migrations, provision partitions
pnpm db:reset         # drop and rebuild the schema (refuses non-local databases)
```

Single-package variants: `pnpm --filter @testcenter/db test`, etc. Seeds and one-off
scripts live in `packages/db/scripts/` and `apps/worker/scripts/` — see the README table.

## Layout

```
apps/web           Next.js App Router — UI + API route handlers
apps/worker        ingest/rollup/maintenance worker (containerized)
packages/core      canonical model, fingerprinting, ports, config, logging
packages/parsers   parser registry + streaming JUnit/xUnit XML parser
packages/db        migrations, partitions, ingest persistence, read queries
packages/adapters  the ONLY place S3/Redis/BullMQ SDKs may be imported
```

## Rules that are enforced, not suggested

- **Infrastructure SDKs only in `packages/adapters`.** An ESLint `no-restricted-imports`
  rule blocks `@aws-sdk/*`, `ioredis`, `bullmq`, `postgres`, `drizzle-orm/*` and cloud
  vendor SDKs elsewhere. Depend on the ports in `packages/core` instead. This is what keeps
  the hosting decision open — do not work around it.
- **`no-console`** except `warn`/`error`. Use the pino logger from `packages/core`.
- **`consistent-type-imports`** — `import type { X }` for type-only imports.
- **Every tenant-scoped query takes an explicit `orgId`.** There is deliberately no variant
  that omits it. A query that forgets it must return nothing, never another tenant's rows.

## Traps that have actually caused bugs here

Each of these cost real debugging time. They are in the code as comments too.

- **`jsonb` must be bound with `sql.json()`.** postgres.js JSON-encodes anything bound to a
  jsonb column, so pre-stringifying stores a JSON *string*. Nothing errors on insert, but
  `tags @> …` silently stops matching. Migration `0003` repairs such rows.
- **`int8`/`bigint` comes back as a *string*** from postgres.js — it will not silently
  narrow. Coerce with `Number()` where the type claims `number`, or `formatDuration("2687693")`
  and any arithmetic will concatenate. See `dailySeries` and `upsertTestCases`.
- **drizzle and raw SQL need separate pools.** `drizzle(sql)` mutates the postgres.js
  instance; afterwards the raw template path cannot bind a `Date`. `createClient` opens one
  pool per access style.
- **`Queryable`, not `Sql`, for helpers that run inside a transaction.** postgres.js hands
  `begin()` a `TransactionSql` which is not assignable to `Sql`.
- **Functions cannot be passed from a server component to a client one.** Pass serializable
  descriptors (`format="percent"`, `runHrefBase`), not callbacks.
- **`min-w-0` on flex children that must truncate.** A flex item defaults to
  `min-width:auto` and will not shrink below min-content, so a long test name pushes
  siblings out of the container and `truncate` never engages. Bit `CardHeader` once.
- **`minmax(0,1fr)`, not `1fr`, for grid tracks holding long strings.** `1fr` is
  `minmax(auto,1fr)` and `auto` bottoms out at min-content.
- **Tailwind `divide-*` borders children by DOM order, not grid position.** In a wrapping
  grid it draws stray borders and cannot express "between rows".
- **Deleting rows does not fix rollups.** `project_daily_stats` and the `test_cases`
  aggregates are maintained at write time; nothing recomputes them on read. Use
  `deleteRun`, which recomputes the day and refreshes the affected tests in one transaction.

## Conventions

- **Filter, sort and view state lives in the URL**, never client state — views are then
  shareable, survive reload, and the back button works. `?days=`, `?volume=share`,
  `?rate=branch`, `?show=all`, `?search=`, `?tag=k:v` (repeatable).
- **Comments explain *why*, not what.** The existing density is high and deliberate,
  especially where a decision looks arbitrary or a previous approach failed. Match it.
- **Destructive actions confirm by typing the target's name**, not a yes/no dialog.
- **Status is never carried by colour alone.** `status-passed` and `status-failed` are
  ΔE 4.1 apart under deuteranopia, so every status pairs colour with a glyph or label,
  stacked segments keep a fixed order separated by 2px surface gaps, and counts appear as
  text. Removing any of those breaks the charts for red-green colourblind readers.
- **Charts:** the form is chosen by the question the data answers. No dual-axis, ever. Only
  three categorical series tokens exist — fold a fourth into "other" rather than inventing
  a hue. Validate any new palette rather than eyeballing it.

## Testing

Vitest. `packages/db` tests run against a real local Postgres (they create and tear down
real orgs — `access.test.ts` proves tenant isolation from the outside using ids that are
valid in their own tenant). `pnpm verify` is the gate.

The partition-DDL test in `packages/db/src/schema.test.ts` can deadlock if the worker's
partition-maintenance job fires at the same moment. It is environmental, not a real
failure; re-run.

## Before changing these, read the notes first

- **`packages/core/src/fingerprint.ts`** — turns uploads into *history*. Flakiness, "when
  did this start failing", ownership and quarantine all key off it. Changing the algorithm
  requires a backfill, which is why `fingerprint_version` is on every row.
- **The flake score calibration** in `refreshTestCaseStats`. It was wrong once: a linear
  weighting scored a test needing retries in 30% of its runs at 15.8, below the threshold
  the dashboard used to call anything flaky.
- **`test_results` partitioning** — monthly, for retention rather than performance. If
  maintenance stops, inserts keep succeeding into `test_results_default` silently, so
  `/api/health` checks for the current month's partition.
