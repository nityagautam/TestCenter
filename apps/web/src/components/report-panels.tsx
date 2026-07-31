import type { ReportPanel } from "@testcenter/core";
import { RankedBars } from "@/components/charts/ranked-bars";
import { TrendChart } from "@/components/charts/trend-chart";
import { VolumeChart } from "@/components/charts/volume-chart";
import { Card, StatTile } from "@/components/ui";

/**
 * Renders whatever panels a report produced.
 *
 * This is the only place that knows how a panel kind becomes pixels, which is the point of
 * the panel contract: questions decide *what* to answer, this decides *how it looks*, and
 * neither knows about the other. A free-form chart builder can later emit the same specs and
 * get this renderer, the print stylesheet and the export path for free.
 *
 * `tc-panel` on every panel is what the print stylesheet hooks to keep a chart and its
 * caption on one page.
 */
export function ReportPanels({ panels }: { panels: ReportPanel[] }) {
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      {panels.map((panel) => (
        <Card
          key={panel.id}
          className={`tc-panel p-4 ${panel.width === "full" ? "lg:col-span-2" : ""}`}
        >
          <PanelBody panel={panel} />
          {panel.footnote ? (
            <p className="mt-2 text-[11px] leading-relaxed text-[var(--color-ink-muted)]">
              {panel.footnote}
            </p>
          ) : null}
        </Card>
      ))}
    </div>
  );
}

function PanelBody({ panel }: { panel: ReportPanel }) {
  const { data } = panel;

  switch (data.kind) {
    case "stat":
      // Reuses the dashboard tile so a number means the same thing and is coloured by the
      // same bands wherever it appears.
      return (
        <StatTile
          label={panel.title}
          value={data.value}
          tone={data.tone ?? "neutral"}
          hint={data.hint}
        />
      );

    case "trend":
      return (
        <TrendChart
          title={panel.title}
          points={data.points}
          format={data.format ?? "number"}
          unit={data.unit ?? ""}
          {...(data.yMax === undefined ? {} : { yMax: data.yMax })}
        />
      );

    case "ranked":
      return (
        <RankedBars
          title={panel.title}
          bars={data.bars}
          {...(data.domainMax === undefined ? {} : { domainMax: data.domainMax })}
          emptyMessage="No rows in this window."
        />
      );

    case "volume":
      return <VolumeChart title={panel.title} days={data.days} mode={data.mode ?? "counts"} />;

    case "table":
      return <PanelTable panel={panel} columns={data.columns} rows={data.rows} />;
  }
}

/**
 * The values behind the chart.
 *
 * Every report carries one. On screen it is the detail a chart deliberately omits; in print
 * it is what someone quoting a figure actually reads; and for a screen reader it is the
 * non-visual equivalent that the visualization rules require any chart to have.
 */
function PanelTable({
  panel,
  columns,
  rows,
}: {
  panel: ReportPanel;
  columns: { key: string; label: string; align?: "left" | "right" }[];
  rows: Record<string, string>[];
}) {
  if (rows.length === 0) {
    return (
      <figure>
        <figcaption className="mb-2 text-xs font-medium">{panel.title}</figcaption>
        <p className="rounded-md border border-[var(--color-border-subtle)] px-3 py-6 text-center text-[11px] text-[var(--color-ink-muted)]">
          Nothing in this window.
        </p>
      </figure>
    );
  }

  return (
    <figure className="min-w-0">
      <figcaption className="mb-2 flex items-baseline justify-between gap-2 text-xs font-medium">
        {panel.title}
        <span className="font-mono text-[10px] font-normal text-[var(--color-ink-muted)]">
          {rows.length} row{rows.length === 1 ? "" : "s"}
        </span>
      </figcaption>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-[var(--color-border-subtle)] text-[10px] tracking-wide text-[var(--color-ink-muted)] uppercase">
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  className={`px-2 py-1.5 font-medium ${column.align === "right" ? "text-right" : ""}`}
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border-subtle)]">
            {rows.map((row, index) => (
              <tr key={index}>
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={`max-w-xs px-2 py-1.5 ${
                      column.align === "right"
                        ? "text-right font-mono whitespace-nowrap tabular-nums"
                        : // Truncated on screen with the full value on hover; the print
                          // stylesheet unsets this, because paper has no hover.
                          "tc-cell-truncate"
                    }`}
                    title={row[column.key] ?? ""}
                  >
                    {row[column.key] ?? "—"}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
