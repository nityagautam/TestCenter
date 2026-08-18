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
- **A display time zone is a parameter, never module state.** The viewer's zone arrives in a
  cookie (`lib/timezone.ts`) and is passed explicitly to every formatter and every query that
  buckets by time. A module-level "current zone" the server sets per request is a
  cross-request leak with a silent failure mode: two readers in different zones share a
  process and the second one sees the first one's clock. Client components take it as a prop
  and never resolve it locally — their first render is server HTML, and a mismatch there is
  the hydration bug `format.ts` was written to prevent.
- **Hour buckets cannot be shifted after the fact.** India is UTC+5:30, so a UTC hour spans
  two local hours and belongs to neither. Anything grouped by hour is grouped
  `AT TIME ZONE <viewer zone>` in SQL, where Postgres also gets DST right.
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
- **`var()` in an SVG *presentation attribute* is not universally resolved.**
  `fill="var(--color-ink)"` works in some engines and is simply invalid in others, where the
  shape falls back to solid black — no error, no warning, a diagram of black boxes for
  whoever opened the wrong browser. Pass token colours through `style` instead; both inherit,
  so a `<g>` still covers its children. `help-illustrations.tsx` does this throughout.
- **A query's declared type describes the *column*, not what it returns.** `DailyPoint.day`
  is typed `string` and holds `"Jul 20"` — `to_char(day, 'Mon DD')`, formatted for display.
  Parsing it as a date yields `Invalid Date`, which crashed the heatmap and then, once that
  was guarded, silently dropped every cell. Same family as the `int8` trap: read the SQL, not
  the interface. `runActivity` and `runSeries` return real `YYYY-MM-DD` for this reason.
- **Never key a chart's marks by their label.** Labels are not unique and were never promised
  to be: two runs finishing in the same minute both render a column called `08:08`, React
  warns, and it is free to drop one — silently losing a run from the chart. Position *is* the
  identity in an ordered series; key by index.
- **`preserveAspectRatio="none"` distorts everything round.** The chart viewBoxes are stretched
  to their container, so an SVG `<circle>` renders as an ellipse whose eccentricity changes
  with the card width, and `feDropShadow` blurs into a horizontal smear. Position dots as
  absolute HTML and use a CSS `filter` — both run after layout, in device pixels.
- **`animation-delay` applies to the first iteration only.** A staggered reveal built from
  per-element delays plays correctly once and then fires every element simultaneously on
  every later loop. Animate one clipping window over a fixed-width row instead.

## Conventions

- **Filter, sort and view state lives in the URL**, never client state — views are then
  shareable, survive reload, and the back button works. `?days=`, `?volume=share`,
  `?rate=branch`, `?verdict=`, `?show=all`, `?search=`, `?tag=k:v` (repeatable).
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
- **Magnitude has its own ramp.** `--color-scale-1..5` is the sequential scale, added for the
  heatmap; the categorical tokens are identity and must never be reused for "how much". The
  ramp is blue because every warm hue here is a reserved status token, and a warm heatmap of
  *upload activity* reads as a map of failures.
- **Bucket skewed data by quantile, not by fraction of the maximum.** One nightly job at forty
  runs against hours of one or two puts everything in the palest step: accurate, and useless,
  because the shape has been quantised away. When the ramp is quantile-based the legend says
  fewer/more rather than printing numbers on a scale that is not linear.
- **Smoothing must not overshoot.** Curves use monotone cubic (`charts/curve.ts`), never
  Catmull-Rom: a pass rate of 100 → 96 → 100 drawn with a naive spline bulges *above* 100%,
  and `yMax` clips the scale rather than the curve, so the lie renders outside the plot and
  is cropped rather than caught.
- **A stacked area cannot have the 2px gaps.** Its bands share an edge, so the form replaces
  that encoding with a solid boundary stroke in each band's own colour. Fixed order and
  legend counts are unchanged. Below ~30 points prefer columns, which keep the gaps.
- **Motion must teach, and must end on its resting state.** The global
  `prefers-reduced-motion` rule collapses every animation to one 0.01ms iteration, so the
  100% keyframe is what those readers see — a loop that resets to "empty" at 100% shows them
  nothing. Decoration that carries no information does not get animated at all.
- **`/help` documents the product with the product.** It is the narrative front door — five
  acts following one build from CI to a verdict — and it illustrates itself with the app's
  own live components given sample props, never screenshots, so it cannot silently go stale.
  Only concepts with no screen of their own (fingerprinting, signature clustering) are drawn
  as artwork. It renders unauthenticated and reads no tenant data, which is what lets it go
  in an invitation mail and survive an outage; keep it that way. `docs/user-guide.md` stays
  the exhaustive reference.

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
