import Link from "next/link";
import { notFound } from "next/navigation";
import { fillTemplate, type BlankOptions, type QuestionDefinition } from "@testcenter/core";
import {
  findProjectByKey,
  findQuestion,
  REPORT_QUESTIONS,
  resolveBlanks,
  runReport,
} from "@testcenter/db";
import { PrintButton } from "@/components/print-button";
import { ReportPanels } from "@/components/report-panels";
import { Card, CardHeader, EmptyState } from "@/components/ui";
import { getServices } from "@/lib/services";
import { requirePageContext } from "@/lib/viewer";

/**
 * Reports — a question with blanks, answered.
 *
 * The premise is that a chart builder asks the wrong thing of the reader. Choosing a
 * dimension, a measure and a chart type requires knowing the schema, and the report it
 * produces has no stated intent: whoever opens it later has to reconstruct what question it
 * was meant to answer. A question carries its intent in its own title.
 *
 * Everything is in the URL — `?q=` plus one parameter per blank — so a report is shareable,
 * bookmarkable and reloadable with no saved-report table. That is also why nothing here is
 * client state.
 *
 * Reading data is a viewer capability, so this page adds no gate of its own.
 */
export interface ReportsParams {
  q?: string;
  days?: string;
  branch?: string;
  environment?: string;
  suite?: string;
  project?: string;
  topN?: string;
  verdict?: string;
}

export async function Reports({
  orgSlug,
  basePath,
  scopedProjectKey,
  params,
}: {
  orgSlug: string;
  basePath: string;
  scopedProjectKey: string | null;
  params: ReportsParams;
}) {
  const context = await requirePageContext(orgSlug);
  const { sql } = getServices();
  const orgId = context.org.id;

  const project = scopedProjectKey
    ? await findProjectByKey(sql, { orgId, key: scopedProjectKey })
    : null;
  if (scopedProjectKey && !project) notFound();

  const scope = { orgId, projectId: project?.id };
  const scopeLabel = project ? project.name : context.org.name;

  // A project-scoped question makes no sense org-wide, and vice versa.
  const available = REPORT_QUESTIONS.filter(
    (question) =>
      question.scope === "both" || question.scope === (scopedProjectKey ? "project" : "org"),
  );

  const question = findQuestion(params.q);
  const selected = question && available.includes(question) ? question : undefined;

  const href = (changes: Record<string, string | null>): string => {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === "string" && value) next.set(key, value);
    }
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    const query = next.toString();
    return query ? `${basePath}?${query}` : basePath;
  };

  const blanks = selected ? await resolveBlanks(sql, selected, scope) : [];
  const report = selected
    ? await runReport(sql, selected, params as Record<string, string | undefined>, {
        ...scope,
        scopeLabel,
        orgSlug,
      })
    : null;

  return (
    <main className="mx-auto max-w-7xl px-6 py-6">
      {/* tc-print-hide: the chrome is not part of the report. */}
      <div className="tc-print-hide mb-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Reports</h1>
            <p className="mt-0.5 text-xs text-[var(--color-ink-muted)]">
              Pick a question, fill in the blanks. {scopeLabel}
              {scopedProjectKey ? (
                <>
                  {" · "}
                  <Link href={`/o/${orgSlug}/reports`} className="underline">
                    all projects
                  </Link>
                </>
              ) : null}
            </p>
          </div>
          {report && !report.empty ? <PrintButton /> : null}
        </div>
      </div>

      {/* The catalog. Reads as a list of sentences, which is the whole idea — you choose by
          recognising your own question rather than by learning a schema. */}
      <Card className="tc-print-hide mb-5 overflow-hidden">
        <CardHeader
          title={selected ? "Question" : `Choose a question (${available.length})`}
          action={
            selected ? (
              <Link href={basePath} className="text-[11px] text-[var(--color-ink-muted)] underline">
                choose another
              </Link>
            ) : undefined
          }
        />
        {selected ? (
          <div className="px-5 py-4">
            <QuestionForm question={selected} blanks={blanks} params={params} href={href} />
          </div>
        ) : (
          <ul className="divide-y divide-[var(--color-border-subtle)]">
            {available.map((entry) => (
              <li key={entry.id}>
                <Link
                  href={href({ q: entry.id })}
                  className="block px-5 py-3 hover:bg-[var(--color-surface)]"
                >
                  <span className="block text-sm font-medium">
                    {fillTemplate(entry.template, entry.blanks, {})}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-relaxed text-[var(--color-ink-muted)]">
                    {entry.purpose}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {report ? (
        <>
          {/* The report's own header, which prints. A page separated from its screen has to
              state what it measured, or the numbers on it mean nothing next week. */}
          <header className="mb-5">
            <h2 className="text-base font-semibold tracking-tight">{report.title}</h2>
            <p className="mt-0.5 font-mono text-[11px] text-[var(--color-ink-muted)]">
              {report.subtitle} · generated{" "}
              {new Date().toISOString().replace("T", " ").slice(0, 16)} UTC
            </p>
          </header>

          {report.empty ? (
            <Card>
              <EmptyState
                title="No data in this window"
                description="The question is fine — there simply are no runs matching it. Try a longer window, or a different branch."
              />
            </Card>
          ) : (
            <ReportPanels panels={report.panels} />
          )}
        </>
      ) : null}
    </main>
  );
}

/**
 * The blanks, as selects laid out in sentence order.
 *
 * Rendered from the same `template` the title uses, so the form and the sentence cannot
 * drift: adding a blank to the template without a matching `BlankSpec` shows its placeholder
 * in both places rather than silently disappearing from one.
 *
 * Links, not a form submit, for the same reason every filter in this app is a link — the
 * result is a URL you can share, and it works before hydration.
 */
function QuestionForm({
  question,
  blanks,
  params,
  href,
}: {
  question: QuestionDefinition;
  blanks: BlankOptions[];
  params: ReportsParams;
  href: (changes: Record<string, string | null>) => string;
}) {
  const segments = question.template.split(/(\{\w+\})/g);

  /*
   * Inline flow, not a flex row.
   *
   * As a flex container the trailing "?" became its own flex item and wrapped onto a line of
   * its own once the choices filled the row, so the question read as ending mid-air. Inline
   * text with inline-flex chips lets the sentence wrap the way a sentence does, punctuation
   * still attached to the words before it.
   */
  return (
    <p className="text-sm leading-8">
      {segments.map((segment, index) => {
        const match = /^\{(\w+)\}$/.exec(segment);
        if (!match) return <span key={index}>{segment}</span>;

        const key = match[1] as string;
        const spec = question.blanks.find((blank) => blank.key === key);
        const resolved = blanks.find((blank) => blank.key === key);
        if (!spec || !resolved) return <span key={index}>{segment}</span>;

        const current =
          (params as Record<string, string | undefined>)[key] ?? resolved.defaultValue;

        return (
          <span key={index} className="mx-1 inline-flex flex-wrap items-center gap-1 align-middle">
            {/* The blank is a row of choices rather than a <select>, so the options are
                visible without a click and each one is a shareable URL. */}
            {!spec.required ? (
              <BlankChoice
                href={href({ [key]: null })}
                active={!current}
                label={spec.placeholder}
              />
            ) : null}
            {resolved.options.map((option) => (
              <BlankChoice
                key={option.value}
                href={href({ [key]: option.value })}
                active={current === option.value}
                label={option.label}
              />
            ))}
            {resolved.options.length === 0 ? (
              <span className="text-[11px] text-[var(--color-ink-muted)] italic">
                nothing recorded yet
              </span>
            ) : null}
          </span>
        );
      })}
    </p>
  );
}

function BlankChoice({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={`rounded border px-1.5 py-0.5 font-mono text-xs whitespace-nowrap transition-colors ${
        active
          ? "border-[var(--color-ink)] bg-[var(--color-ink)] font-semibold text-[var(--color-surface)]"
          : "border-[var(--color-border-subtle)] text-[var(--color-ink-muted)] hover:border-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
      }`}
    >
      {label}
    </Link>
  );
}
