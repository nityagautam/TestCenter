import type { DashboardWindowSummary, OrgSummary } from "@testcenter/db";
import { Card, StatTile } from "@/components/ui";
import { type DashboardDays, dashboardRangeLabel } from "@/lib/dashboard-range";
import { formatInteger, formatPercent } from "@/lib/format";
import { passRateTone } from "@/lib/health";

/**
 * The headline tiles, shared by the organisation dashboard and the project overview.
 *
 * One component because the two built their own and drifted: both read `orgSummary`, which is
 * fixed at 30 days whatever `?days=` says, so the range control moved every chart on the page
 * and left the headline numbers alone.
 *
 * The split between the two arguments is the whole point and is not cosmetic:
 *
 *   `windowed` is what the selected range measures, and it agrees with the charts *exactly* —
 *   `dashboardWindowSummary`, `runSeries` and `runActivity` share one window predicate, down
 *   to the `total > 0` term that excludes empty runs.
 *
 *   `current` is present state. A test is quarantined or it is not, right now; there is no
 *   window in which that is a rate, and `flake_score` is a maintained rollup rather than
 *   something recomputed per range. Those two tiles carry "now" in their hint so the range
 *   control above them cannot be read as applying to them.
 */
export function DashboardStatTiles({
  windowed,
  current,
  days,
  className,
}: {
  windowed: DashboardWindowSummary;
  current: Pick<OrgSummary, "runsToday" | "flakyTests" | "quarantined">;
  days: DashboardDays;
  className?: string;
}) {
  const rangeLabel = dashboardRangeLabel(days);
  return (
    <Card className={className}>
      {/* Six across, an exact fit for the six tiles: `divide-*` borders children by DOM order
          rather than by grid position, so a half-empty final row draws stray edges. */}
      <div className="grid grid-cols-2 divide-x divide-y divide-[var(--color-border-subtle)] sm:grid-cols-3 lg:grid-cols-6 lg:divide-y-0">
        <StatTile
          label="Pass rate"
          value={formatPercent(windowed.passRate)}
          tone={passRateTone(windowed.passRate)}
          hint={rangeLabel}
        />
        <StatTile
          label="Runs"
          value={formatInteger(windowed.runs)}
          // Redundant when the window *is* today, and a tile reading "4" above "4 today"
          // invites the reader to look for the difference between them.
          hint={days === 1 ? undefined : `${current.runsToday} today`}
        />
        {/* "Tests executed", not "Tests": this counts executions in the window, while the
            flaky and quarantined tiles beside it count test identities. The old label made
            those three look like three measurements of the same population. */}
        <StatTile label="Tests executed" value={formatInteger(windowed.tests)} />
        <StatTile
          label="Failed"
          value={formatInteger(windowed.failed)}
          tone={windowed.failed > 0 ? "failed" : "neutral"}
          hint="incl. errored"
        />
        <StatTile
          label="Flaky tests"
          value={formatInteger(current.flakyTests)}
          tone={current.flakyTests > 0 ? "flaky" : "neutral"}
          hint="now, score ≥ 20"
        />
        <StatTile
          label="Quarantined"
          value={formatInteger(current.quarantined)}
          tone="skipped"
          hint="now, excluded from gates"
        />
      </div>
    </Card>
  );
}
