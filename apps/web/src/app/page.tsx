import { QUEUES } from "@testcenter/core";
import { listPartitions, ping, schema } from "@testcenter/db";
import { desc } from "drizzle-orm";
import { authProvidersConfigured } from "@/auth";
import { getServices } from "@/lib/services";

/**
 * Phase 0 landing page: a system status board.
 *
 * There is no product UI yet by design — Phase 0 delivers the foundations, and the
 * useful thing to show is whether those foundations are actually wired up. This
 * page is the human-readable form of the Phase 0 exit criteria and is replaced by
 * the run list in Phase 1.
 */
export const dynamic = "force-dynamic";

interface StatusRow {
  label: string;
  value: string;
  ok: boolean | null;
  hint?: string;
}

async function collectStatus(): Promise<StatusRow[]> {
  const { sql, db, queue, blobStore, env } = getServices();
  const rows: StatusRow[] = [];

  const database = await ping(sql);
  rows.push({
    label: "Postgres",
    value: database.ok ? `connected in ${database.latencyMs}ms` : "unreachable",
    ok: database.ok,
    hint: database.ok ? undefined : "Is Postgres running? Check DATABASE_URL.",
  });

  if (database.ok) {
    try {
      const migrations = await db
        .select({ name: schema.schemaMigrations.name })
        .from(schema.schemaMigrations)
        .orderBy(desc(schema.schemaMigrations.name));
      rows.push({
        label: "Migrations",
        value:
          migrations.length === 0
            ? "none applied"
            : `${migrations.length} applied (latest ${migrations[0]?.name})`,
        ok: migrations.length > 0,
        hint: migrations.length > 0 ? undefined : "Run `pnpm db:migrate`.",
      });

      const partitions = (await listPartitions(sql)).filter((name) => /_\d{4}_\d{2}$/.test(name));
      const now = new Date();
      const currentMonth = `test_results_${now.getUTCFullYear()}_${String(
        now.getUTCMonth() + 1,
      ).padStart(2, "0")}`;
      const hasCurrent = partitions.includes(currentMonth);
      rows.push({
        label: "Partitions",
        value: hasCurrent
          ? `${partitions.length} monthly, current month present`
          : `${partitions.length} monthly, current month MISSING`,
        ok: hasCurrent,
        hint: hasCurrent
          ? "Retention drops a partition instead of running a DELETE."
          : "Run `pnpm db:partitions` — results are landing in test_results_default.",
      });

      const orgs = await db.select({ slug: schema.organizations.slug }).from(schema.organizations);
      const projects = await db.select({ key: schema.projects.key }).from(schema.projects);
      rows.push({
        label: "Bootstrap",
        value:
          orgs.length > 0
            ? `org ${orgs.map((org) => org.slug).join(", ")} · ${projects.length} project(s)`
            : "no org yet",
        ok: orgs.length > 0,
        hint: orgs.length > 0 ? undefined : "Run `pnpm db:migrate` to bootstrap.",
      });
    } catch (error) {
      rows.push({
        label: "Schema",
        value: error instanceof Error ? error.message : "query failed",
        ok: false,
      });
    }
  }

  try {
    const depth = await queue.depth(QUEUES.ingest);
    rows.push({
      label: "Queue (ingest)",
      value: `waiting ${depth.waiting} · active ${depth.active} · failed ${depth.failed}`,
      ok: true,
      hint: "Queue depth is the primary ingest-lag SLI.",
    });
  } catch (error) {
    rows.push({
      label: "Queue (ingest)",
      value: error instanceof Error ? error.message : "unreachable",
      ok: false,
      hint: "Is Redis running? Check REDIS_URL.",
    });
  }

  rows.push({
    label: "Object storage",
    value: `driver ${blobStore.driver}`,
    ok: true,
    hint:
      blobStore.driver === "fs"
        ? "Local filesystem driver — same signed-upload contract as S3, no Docker needed."
        : "S3-compatible endpoint.",
  });

  rows.push({
    label: "Auth",
    value: authProvidersConfigured ? "Google OIDC configured" : "not configured",
    ok: authProvidersConfigured ? true : null,
    hint: authProvidersConfigured
      ? `Allowed domains: ${process.env.AUTH_ALLOWED_DOMAINS || "(any)"}`
      : "Set AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET to enable sign-in.",
  });

  rows.push({
    label: "Environment",
    value: `${env.NODE_ENV} · retention ${env.TESTCENTER_RETENTION_MONTHS} months`,
    ok: true,
  });

  return rows;
}

function StatusDot({ ok }: { ok: boolean | null }) {
  const color =
    ok === true
      ? "bg-[var(--color-status-passed)]"
      : ok === false
        ? "bg-[var(--color-status-failed)]"
        : "bg-[var(--color-status-skipped)]";
  return <span className={`inline-block size-2.5 shrink-0 rounded-full ${color}`} aria-hidden />;
}

export default async function HomePage() {
  const rows = await collectStatus();
  const failing = rows.filter((row) => row.ok === false).length;

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <header className="mb-10">
        <p className="text-xs font-medium tracking-widest text-[var(--color-ink-muted)] uppercase">
          Phase 0 · Foundations
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Test Center</h1>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-[var(--color-ink-muted)]">
          Ingest test results from any framework, then triage and trend them. This page is the Phase
          0 status board — it is replaced by the run list in Phase 1.
        </p>
      </header>

      <section
        className="overflow-hidden rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)]"
        aria-label="System status"
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-5 py-3">
          <h2 className="text-sm font-medium">System status</h2>
          <span className="text-xs text-[var(--color-ink-muted)]">
            {failing === 0 ? "all checks passing" : `${failing} check(s) failing`}
          </span>
        </div>
        <ul className="divide-y divide-[var(--color-border-subtle)]">
          {rows.map((row) => (
            <li key={row.label} className="flex gap-3 px-5 py-3.5">
              <span className="mt-1.5">
                <StatusDot ok={row.ok} />
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-sm font-medium">{row.label}</span>
                  <span className="font-mono text-xs text-[var(--color-ink-muted)]">
                    {row.value}
                  </span>
                </div>
                {row.hint ? (
                  <p className="mt-1 text-xs leading-relaxed text-[var(--color-ink-muted)]">
                    {row.hint}
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-8 rounded-xl border border-[var(--color-border-subtle)] px-5 py-4">
        <h2 className="text-sm font-medium">Next: Phase 1</h2>
        <p className="mt-2 text-xs leading-relaxed text-[var(--color-ink-muted)]">
          JUnit/xUnit XML ingest (covers pytest, Playwright, Surefire, Gradle, jest-junit, Cypress,
          Robot and TestNG), upload UI and API, run list and run detail, and tagging v1.
        </p>
        <p className="mt-2 text-xs text-[var(--color-ink-muted)]">
          Health JSON: <code className="font-mono">/api/health?deep=1</code>
        </p>
      </section>
    </main>
  );
}
