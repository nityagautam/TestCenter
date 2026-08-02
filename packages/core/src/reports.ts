/**
 * The report panel contract.
 *
 * This is the seam that lets a question catalog ship now and a free-form chart builder
 * arrive later without a rewrite. A panel is a *finished answer*: a title, the data, and
 * which form to draw it in. Nothing downstream knows or cares whether the spec came from a
 * curated question, a builder, a saved report or a scheduled job.
 *
 * The alternative — questions rendering their own JSX — would tie every question to a
 * layout, and the print stylesheet and any future builder would have to handle each one
 * separately. Here they all flow through one renderer, so print, page breaks and empty
 * states are solved once.
 *
 * Lives in `core` rather than `db` because both the query layer (which produces panels) and
 * the web app (which renders them) depend on it, and `core` is what they already share.
 */

/**
 * Which form to draw a panel in.
 *
 * A closed set on purpose. The chart form is chosen by the question's author, who knows
 * what the data means — not by the reader, and not by whatever a builder UI happens to
 * offer. Adding a kind is a deliberate act with a renderer to match.
 */
export type ReportPanelKind = "stat" | "trend" | "ranked" | "volume" | "table";

/** A single headline number, optionally with its trend direction stated in words. */
export interface StatPanelData {
  value: string;
  /** e.g. "last 30 days" — the qualifier that stops a bare number being a lie. */
  hint?: string;
  /** Mirrors StatTile's tones, including `skipped` for deliberately-excluded things. */
  tone?: "neutral" | "passed" | "flaky" | "failed" | "skipped";
}

/** An ordered series over time. Nulls are gaps, not zeroes. */
export interface TrendPanelData {
  points: { label: string; value: number | null; detail?: string }[];
  unit?: string;
  format?: "number" | "percent" | "duration";
  /** Fixed axis maximum, for ratios that must not rescale to their own range. */
  yMax?: number;
}

/** Magnitude compared across named things, biggest first. */
export interface RankedPanelData {
  bars: { label: string; value: number; display: string; detail?: string | null; href?: string }[];
  /** Set for ratios so a small gap is drawn as a small gap. */
  domainMax?: number;
}

/** Composition over time — counts or share. */
export interface VolumePanelData {
  days: {
    label: string;
    passed: number;
    failed: number;
    skipped: number;
    flaky: number;
    runs: number;
  }[];
  mode?: "counts" | "share";
}

/**
 * Rows and columns, for answers a chart would flatten.
 *
 * Every report gets one of these alongside its chart where the underlying rows are
 * meaningful: a chart is for the shape, a table is for the values, and a printed report is
 * read by people who need to quote a number. It is also the accessible fallback the
 * visualization rules require.
 */
export interface TablePanelData {
  columns: { key: string; label: string; align?: "left" | "right" }[];
  rows: Record<string, string>[];
}

export type ReportPanelData =
  | ({ kind: "stat" } & StatPanelData)
  | ({ kind: "trend" } & TrendPanelData)
  | ({ kind: "ranked" } & RankedPanelData)
  | ({ kind: "volume" } & VolumePanelData)
  | ({ kind: "table" } & TablePanelData);

export interface ReportPanel {
  /** Stable within a report, so print CSS and tests can target a panel. */
  id: string;
  /** The question this panel answers, with its blanks already filled in. */
  title: string;
  /** Why the number is what it is, or what it excludes. Rendered under the panel. */
  footnote?: string;
  /** How wide the panel wants to be. The renderer decides how to honour it. */
  width?: "half" | "full";
  data: ReportPanelData;
}

/**
 * What a report is: a filled-in question plus the panels that answer it.
 *
 * `subtitle` carries the scope and window — a printed page separated from its screen has
 * to state what it was measuring, or the numbers on it mean nothing a week later.
 */
export interface ReportResult {
  questionId: string;
  title: string;
  subtitle: string;
  panels: ReportPanel[];
  /** True when the window genuinely holds no data, so the view says so rather than drawing empty axes. */
  empty: boolean;
}

// ─── Questions ───────────────────────────────────────────────────────────────

/**
 * A blank in a question sentence.
 *
 * `kind` decides how the blank is filled *and* validated. Blanks are never free text:
 * options come from the data that exists, so a report cannot be built around a branch name
 * nobody has ever pushed. A typo would otherwise produce an empty report that looks like a
 * broken feature rather than a mistyped filter.
 */
export type BlankKind =
  "project" | "branch" | "environment" | "suite" | "days" | "topN" | "verdict";

export interface BlankSpec {
  key: string;
  kind: BlankKind;
  /** Shown in the sentence before a choice is made, e.g. "any branch". */
  placeholder: string;
  /** False when the question is answerable without it — "on any branch". */
  required?: boolean;
}

/** Resolved options for one blank, built from what the organisation actually has. */
export interface BlankOptions {
  key: string;
  options: { value: string; label: string }[];
  /** Pre-selected when the user has not chosen — the sensible default, not the first item. */
  defaultValue?: string;
}

/**
 * A question in the catalog.
 *
 * `template` uses `{key}` placeholders matching `blanks`, so the sentence and its inputs
 * cannot drift apart: rendering the title and rendering the form read the same source.
 */
export interface QuestionDefinition {
  id: string;
  /** e.g. "Which tests failed most in the last {days} days on {branch}?" */
  template: string;
  /** One line on what the answer is good for, shown under the question in the picker. */
  purpose: string;
  blanks: BlankSpec[];
  /** Where the question makes sense. A project-only question is hidden at org scope. */
  scope: "org" | "project" | "both";
}

/** Fills `{key}` placeholders, leaving the placeholder text where nothing was chosen. */
export function fillTemplate(
  template: string,
  blanks: readonly BlankSpec[],
  params: Readonly<Record<string, string | undefined>>,
): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const chosen = params[key];
    if (chosen) return chosen;
    return blanks.find((blank) => blank.key === key)?.placeholder ?? key;
  });
}

/** Days presets offered for every `days` blank, so windows are consistent across questions. */
export const REPORT_DAY_OPTIONS = [7, 14, 30, 60, 90] as const;

/** Top-N presets, likewise. */
export const REPORT_TOP_N_OPTIONS = [5, 10, 20] as const;
