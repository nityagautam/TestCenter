import type { ReactNode } from "react";
import type { RecentOutcome } from "@testcenter/db";
import { RUN_VERDICTS, RUN_VERDICT_LABELS, type RunVerdict } from "@testcenter/core";
import { OutcomeStrip } from "@/components/charts/outcome-strip";
import { RankedBars } from "@/components/charts/ranked-bars";
import { TrendChart } from "@/components/charts/trend-chart";
import { VolumeChart } from "@/components/charts/volume-chart";
import { CiSnippet } from "@/components/ci-snippet";
import { FilterMenu } from "@/components/filter-menu";
import {
  FingerprintPipeline,
  FlakeFlip,
  IngestFlow,
  SignatureClustering,
} from "@/components/help-illustrations";
import { ThemeToggle } from "@/components/theme-toggle";
import { SearchBox } from "@/components/search-box";
import { Card, CardHeader, ResultBar, StatTile, StatusBadge, TagChip } from "@/components/ui";
import { VerdictBadge } from "@/components/verdict-badge";
import { CREDIT } from "@/lib/credit";
import type { ThemePreference } from "@/lib/theme";

/**
 * Help — the narrative front door.
 *
 * Reference documentation answers "what does this button do". Nobody arriving at a test
 * dashboard for the first time has that question; they have "my build is red, now what".
 * So this is a story in five acts, each one a question somebody actually asks, in the order
 * they ask them — a run arrives, something is red, is it always red, how are we doing, and
 * who is allowed to do what. `docs/user-guide.md` stays the exhaustive reference; this is
 * the thing you send someone on their first day.
 *
 * **Everything illustrated here is a live component or a concept diagram, never a
 * screenshot.** A screenshot of the run page is stale the first time a column moves and
 * nothing tells us. The badges, strips, bars and charts below are the same components the
 * app renders, given sample props — if `VerdictBadge` changes shape, this page changes with
 * it. What remains as artwork is only what has no screen of its own: how a fingerprint is
 * computed and why failures cluster. Those are ideas, and ideas do not drift.
 *
 * It renders unauthenticated on purpose. The most valuable moment for this page is before
 * someone has an account — in the invitation mail, in a pipeline's README — and a help page
 * behind a login cannot be there. Nothing on it reads the database, so it also survives the
 * outage somebody might be trying to understand.
 */

const ACTS = [
  { id: "ingest", title: "Your CI just ran", hint: "runs and ingest" },
  { id: "triage", title: "Something is red", hint: "triage and verdicts" },
  { id: "history", title: "Is it always red?", hint: "history and flakiness" },
  { id: "trends", title: "How are we doing?", hint: "dashboards and reports" },
  { id: "access", title: "Who can do what", hint: "roles, tokens, CI" },
] as const;

export function Help({
  appHref,
  appLabel,
  theme,
  sampleVerdict,
  sampleSearch,
}: {
  appHref: string;
  appLabel: string;
  /** Read from the same cookie the app uses, so arriving here does not change the theme. */
  theme: ThemePreference;
  /** URL-backed state for the live runs-list example; no tenant data is read. */
  sampleVerdict: "all" | "todo" | RunVerdict;
  sampleSearch: string;
}) {
  return (
    <>
      <HelpHeader appHref={appHref} appLabel={appLabel} theme={theme} />

      <main id="content" tabIndex={-1} className="mx-auto max-w-3xl px-5 pt-8 pb-20 lg:px-6">
        <p className="text-[13px] leading-relaxed text-[var(--color-ink-muted)]">
          Test Center takes the report your test runner already writes — JUnit or xUnit XML from
          pytest, Playwright, Cucumber, Surefire, jest-junit, TestNG and the rest — and keeps the
          history. One upload is a fact. A thousand uploads are the difference between{" "}
          <em>&ldquo;this test failed&rdquo;</em> and{" "}
          <em>&ldquo;this test has failed on main every night since Tuesday&rdquo;</em>.
        </p>
        <p className="mt-3 text-[13px] leading-relaxed text-[var(--color-ink-muted)]">
          What follows is one build, followed from the moment CI finishes to the moment somebody
          decides whose problem it is. Five questions, in the order people ask them.
        </p>

        <Contents />

        <ActOne />
        <ActTwo sampleVerdict={sampleVerdict} sampleSearch={sampleSearch} />
        <ActThree />
        <ActFour />
        <ActFive />

        <Footer appHref={appHref} appLabel={appLabel} />
      </main>
    </>
  );
}

/**
 * The same header chrome as the application, without tenant controls.
 *
 * The shell needs an organisation, a project list and a signed-in viewer to render its
 * switchers and counts, and this page has none of those guaranteed. The height, full-width
 * spacing, borders, colour tokens and control treatment still match the app header so Help
 * reads as part of Test Center rather than a detached microsite.
 */
function HelpHeader({
  appHref,
  appLabel,
  theme,
}: {
  appHref: string;
  appLabel: string;
  theme: ThemePreference;
}) {
  return (
    <header
      className="tc-print-hide sticky top-0 z-30 h-12 border-b border-[var(--color-chrome-border)] bg-[var(--color-chrome)] text-[var(--color-chrome-ink)]"
      style={{
        ["--color-surface" as string]: "var(--color-chrome)",
        ["--color-surface-raised" as string]: "var(--color-chrome-raised)",
        ["--color-border-subtle" as string]: "var(--color-chrome-border)",
        ["--color-ink" as string]: "var(--color-chrome-ink)",
        ["--color-ink-muted" as string]: "var(--color-chrome-ink-muted)",
      }}
    >
      <div className="flex h-full items-center gap-2 px-3 lg:px-4">
        <a
          href="/"
          className="flex h-9 min-w-0 items-center gap-2 rounded-md border border-[var(--color-border-subtle)] px-3 text-xs font-semibold tracking-tight hover:border-[var(--color-ink-muted)]"
        >
          <span
            className="inline-block size-2.5 shrink-0 rounded-full bg-[var(--color-chrome-ink)]"
            aria-hidden
          />
          <span className="truncate">Test Center</span>
        </a>
        <span className="text-[var(--color-chrome-ink-muted)]" aria-hidden>
          /
        </span>
        <h1 className="text-xs font-medium">Help</h1>
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle initial={theme} />
          <a
            href={appHref}
            className="rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1.5 text-xs hover:border-[var(--color-ink-muted)]"
          >
            {appLabel}
          </a>
        </div>
      </div>
    </header>
  );
}

function Contents() {
  return (
    <nav aria-label="Contents" className="tc-print-hide mt-7">
      <ol className="divide-y divide-[var(--color-border-subtle)] overflow-hidden rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)]">
        {ACTS.map((act, index) => (
          <li key={act.id}>
            <a
              href={`#${act.id}`}
              className="flex items-baseline gap-3 px-4 py-2.5 hover:bg-[var(--color-surface)]"
            >
              <span className="font-mono text-[11px] text-[var(--color-ink-muted)] tabular-nums">
                {index + 1}
              </span>
              <span className="text-[13px] font-medium">{act.title}</span>
              <span className="ml-auto text-[11px] text-[var(--color-ink-muted)]">{act.hint}</span>
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/* ── Act 1 ─────────────────────────────────────────────────────────────────── */

function ActOne() {
  return (
    <Act id="ingest" number={1} title="Your CI just ran">
      <P>
        The unit here is a <Term>run</Term>: one report file, uploaded once, from one execution of
        one suite. Everything else in the product hangs off it. A run knows its project, its branch
        and commit, when it started, how long it took, and every individual result inside it.
      </P>

      <Illustration caption="A run header, drawn with the app's own components and sample numbers.">
        <Card className="overflow-hidden">
          <CardHeader
            title={
              <span className="flex flex-wrap items-center gap-2">
                <span className="truncate">Nightly regression · checkout-web</span>
                <StatusBadge status="complete" />
                <VerdictBadge verdict={null} size="sm" />
              </span>
            }
          />
          <div className="space-y-3 px-5 py-4">
            <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-[var(--color-ink-muted)]">
              <span>main</span>
              <span aria-hidden>·</span>
              <span>a91f0c2</span>
              <span aria-hidden>·</span>
              <span>4m 12s</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <TagChip tagKey="suite" value="regression" />
              <TagChip tagKey="env" value="staging" />
            </div>
            <div>
              <ResultBar passed={142} failed={4} skipped={2} flaky={3} total={148} />
              {/* Counts as text beside the bar, always. Under deuteranopia the passed and
                  failed fills are 4.1 ΔE apart, so the numbers are not a convenience. */}
              <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px]">
                <span className="text-[var(--color-status-failed)]">4 failed</span>
                <span className="text-[var(--color-status-flaky)]">3 flaky</span>
                <span className="text-[var(--color-status-passed)]">142 passed</span>
                <span className="text-[var(--color-ink-muted)]">2 skipped</span>
              </div>
            </div>
          </div>
        </Card>
      </Illustration>

      <P>
        Uploading does not block on parsing. The request returns a run id immediately and a worker
        reads the file behind it, which is why a large report does not time out your pipeline and
        why the run page fills in while you watch it.
      </P>

      <IngestFlow />

      <P>
        Out of each <Code>testcase</Code> element comes the name, the suite or class it belongs to,
        the status, the duration, and — when it failed — the message, the stack trace and whatever
        the test printed to stdout and stderr. Retries are recognised rather than counted twice: a
        test that failed and then passed on its second attempt is one result, marked as having
        needed a retry. That mark is what makes flakiness measurable at all.
      </P>

      <Note title="A run is named, or it is remembered as its framework">
        Naming the run at upload takes two seconds and is what every list, link and report
        identifies it by afterwards. Drop several files at once and each becomes its own run, with
        the file name appended so they stay distinguishable.
      </Note>

      <P>
        Wiring this into a pipeline is one <Code>curl</Code>. That is act five, because the
        interesting part comes first: the run is red.
      </P>
    </Act>
  );
}

/* ── Act 2 ─────────────────────────────────────────────────────────────────── */

function ActTwo({
  sampleVerdict,
  sampleSearch,
}: {
  sampleVerdict: "all" | "todo" | RunVerdict;
  sampleSearch: string;
}) {
  return (
    <Act id="triage" number={2} title="Something is red">
      <P>
        Open the run and the failures are already at the top — a result table that sorted the
        passing 142 below the failing four would be answering a question nobody asked. Selecting a
        failure gives you everything the report carried about it, which is usually more than the CI
        log showed you, because captured output survives here and scrollback does not.
      </P>

      <Illustration caption="The failure detail, as the run page composes it.">
        <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <StatusBadge status="failed" />
            <span className="min-w-0 font-mono text-[11px]">
              tests/checkout/test_refund.py · test_refund_partial_amount
            </span>
            <span className="font-mono text-[10px] text-[var(--color-ink-muted)]">
              2 attempts · 1.42s
            </span>
          </div>
          <pre className="mt-2 overflow-x-auto rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
            {`AssertionError: expected refund status 200, got 402
  at tests/checkout/test_refund.py:88 in test_refund_partial_amount
  at src/payments/client.py:214 in post_refund`}
          </pre>
          <div className="mt-2 font-mono text-[10px] text-[var(--color-ink-muted)]">
            stdout · stderr · attempt history — all kept, all searchable
          </div>
        </div>
      </Illustration>

      <P>
        When a run goes red at scale, the first question is not <em>&ldquo;what failed&rdquo;</em>{" "}
        but <em>&ldquo;how many problems is this&rdquo;</em>. Every failure is given a{" "}
        <Term>signature</Term> at ingest — the normalized error type plus the top three frames of{" "}
        <em>your</em> code, with framework frames dropped because they are identical across
        unrelated failures and would collapse everything into one useless cluster. Twenty-four red
        results with two signatures is two problems.
      </P>

      <SignatureClustering />

      <P>
        Then comes the part no amount of parsing can do for you. &ldquo;96%, four failing&rdquo;
        does not distinguish a real regression from a UAT cluster being down, and that distinction
        decides who gets handed the problem. So somebody records a <Term>verdict</Term>.
      </P>

      <Illustration caption="Every verdict, plus the state of a run nobody has looked at yet.">
        <div className="flex flex-wrap items-center gap-2">
          {RUN_VERDICTS.map((verdict) => (
            <VerdictBadge key={verdict} verdict={verdict} />
          ))}
          <VerdictBadge verdict={null} />
        </div>
      </Illustration>

      <Table
        columns={["Verdict", "Means", "Goes to"]}
        rows={[
          [RUN_VERDICT_LABELS.pass, "Reviewed; the failures are known and tolerated", "nobody"],
          [RUN_VERDICT_LABELS["product-bug"], "A genuine regression", "a developer"],
          [
            RUN_VERDICT_LABELS.infra,
            "Environment or data, not the code under test",
            "whoever owns the environment",
          ],
          [
            RUN_VERDICT_LABELS.flaky,
            "Non-deterministic, so not a real signal",
            "the test's author",
          ],
          [RUN_VERDICT_LABELS.investigating, "Seen, not yet judged", "you, later"],
        ]}
      />

      <P>
        A run nobody has judged shows the blue dashed <Term>TODO</Term>, so &ldquo;what still needs
        review?&rdquo; is answerable at a glance from the runs list. TODO is never stored — it
        simply means no verdict row exists, which is what keeps it distinct from{" "}
        <em>Investigating</em>, where somebody did look and has not finished.
      </P>

      <P>
        On the runs list, the <Term>Verdict</Term> filter selects the latest judgement or{" "}
        <Term>TODO / unreviewed</Term>. TODO includes only runs ready for review — complete, partial
        or failed — rather than uploads that are still parsing. The choice lives in{" "}
        <Code>?verdict=</Code>, so the review queue is a shareable link and stays applied when
        loading older runs.
      </P>

      <VerdictFilterExample verdict={sampleVerdict} search={sampleSearch} />

      <Note title="Verdicts are append-only, and change no number">
        Changing your mind records a new entry; the previous one stays in the run&rsquo;s verdict
        log, marked superseded, because <em>&ldquo;who called this infra, and when?&rdquo;</em> has
        to stay answerable after the call changes. And pass rates, trends and flake scores ignore
        verdicts entirely — no chart shifts meaning because somebody labelled a run.
      </Note>
    </Act>
  );
}

type HelpVerdictSelection = "all" | "todo" | RunVerdict;

const HELP_VERDICT_OPTIONS: { value: HelpVerdictSelection; label: string }[] = [
  { value: "all", label: "All" },
  { value: "todo", label: "TODO / unreviewed" },
  ...RUN_VERDICTS.map((value) => ({ value, label: RUN_VERDICT_LABELS[value] })),
];

function helpVerdictHref(verdict: HelpVerdictSelection, search: string): string {
  const params = new URLSearchParams({ verdict });
  if (search) params.set("search", search);
  return `/help?${params.toString()}#triage`;
}

/**
 * The actual runs-list controls and badges, fed sample rows rather than tenant data.
 *
 * The filter is deliberately URL-backed even here. A decorative menu would teach the right
 * appearance and the wrong behaviour: on the real page the choice survives reloads, can be
 * shared, and composes with search. Keeping those semantics in the example makes the help page
 * demonstrate the product instead of merely resembling it.
 */
function VerdictFilterExample({
  verdict,
  search,
}: {
  verdict: HelpVerdictSelection;
  search: string;
}) {
  const selectedVerdict = verdict === "todo" ? null : verdict === "all" ? undefined : verdict;
  const rows = [
    {
      name: "Checkout · Playwright",
      branch: "main",
      commit: "a91f0c2",
      tests: 248,
      verdict: selectedVerdict ?? null,
    },
    {
      name: "Payments API · pytest",
      branch: "release/4.8",
      commit: "d371be8",
      tests: 96,
      verdict: selectedVerdict ?? (verdict === "all" ? "product-bug" : null),
    },
  ].filter((run) => {
    const needle = search.trim().toLocaleLowerCase();
    return (
      !needle ||
      run.name.toLocaleLowerCase().includes(needle) ||
      run.branch.toLocaleLowerCase().includes(needle) ||
      run.commit.includes(needle)
    );
  });

  const summary =
    verdict === "todo"
      ? "Reviewable runs without a verdict"
      : verdict === "all"
        ? "Runs with any latest verdict"
        : `Runs whose latest verdict is ${RUN_VERDICT_LABELS[verdict]}`;

  return (
    <Illustration caption="Filter the runs list by its latest verdict. Try the real controls below.">
      <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4">
        <div className="flex flex-wrap items-center gap-2">
          <SearchBox
            action="/help#triage"
            name="search"
            label="Search sample runs"
            defaultValue={search}
            placeholder="Search run name, branch or commit…"
            hidden={{ verdict }}
            className="min-w-0 flex-1 basis-[16rem]"
          />
          <FilterMenu
            label="Verdict"
            options={HELP_VERDICT_OPTIONS.map((option) => ({
              label: option.label,
              href: helpVerdictHref(option.value, search),
              active: verdict === option.value,
            }))}
          />
        </div>

        <div className="mt-4 overflow-hidden rounded-lg border border-[var(--color-border-subtle)]">
          {rows.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-[var(--color-ink-muted)]">
              No sample runs match that search.
            </p>
          ) : (
            <ul className="divide-y divide-[var(--color-border-subtle)]">
              {rows.map((run, index) => (
                // Two sample names could eventually share a label; their ordered position is
                // the identity, just as it is for marks in the real per-run charts.
                <li key={index} className="px-4 py-3">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">{run.name}</span>
                    <StatusBadge status="complete" />
                    <VerdictBadge verdict={run.verdict} size="sm" />
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-[var(--color-ink-muted)]">
                    <span>{run.branch}</span>
                    <span>{run.commit}</span>
                    <span>{run.tests} tests</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="mt-3 flex items-center gap-2 text-[11px] text-[var(--color-ink-muted)]">
          <span className="size-1.5 shrink-0 rounded-full bg-[var(--color-series-1)]" aria-hidden />
          {summary}
        </p>
      </div>
    </Illustration>
  );
}

/* ── Act 3 ─────────────────────────────────────────────────────────────────── */

/** Sample outcomes for `OutcomeStrip`, written as a pattern so the shape is readable. */
function outcomes(pattern: string): RecentOutcome[] {
  const start = Date.UTC(2026, 6, 20, 2, 0, 0);
  return [...pattern].map((mark, index) => ({
    testCaseId: 1,
    resultId: index + 1,
    runId: `sample-${index + 1}`,
    status: mark === "x" ? "failed" : mark === "-" ? "skipped" : "passed",
    wasFlaky: mark === "~",
    startedAt: new Date(start + index * 86_400_000),
  }));
}

function ActThree() {
  return (
    <Act id="history" number={3} title="Is it always red?">
      <P>
        This is where a dashboard earns its keep, and it depends entirely on one thing: knowing that
        the test that failed tonight is the <em>same test</em> that failed on Tuesday. That is
        harder than it sounds. The same test arrives with an absolute path from a laptop and a
        different one from a runner, carrying a shard tag, a retry suffix, and a uuid in its
        parameters. Treat those as different tests and the history fragments into five tests with no
        history each.
      </P>

      <FingerprintPipeline />

      <P>
        With identity settled, a test&rsquo;s past is a strip: one cell per execution, oldest on the
        left. The whole strip is a link to the full history, and the glyphs are not decoration —{" "}
        <Code>✓</Code> pass, <Code>✕</Code> fail, <Code>–</Code> skipped, with amber for
        &ldquo;passed, but only on a retry&rdquo;. Colour never carries a status by itself anywhere
        in this app.
      </P>

      <Illustration caption="Three real OutcomeStrip components, given three different histories.">
        <dl className="space-y-2.5">
          <StripRow
            term="Healthy"
            detail="boring, which is the goal"
            cells={outcomes("........")}
          />
          <StripRow
            term="Flaky"
            detail="passes and fails without the code changing"
            cells={outcomes(".x.~..x~")}
          />
          <StripRow
            term="Broken"
            detail="consistent, and telling you something"
            cells={outcomes("..xxxxxx")}
          />
        </dl>
      </Illustration>

      <P>
        The middle row and the bottom row are routinely lumped together as &ldquo;flaky
        tests&rdquo;, and that single mistake is what makes most flake dashboards worthless. They
        are opposites.
      </P>

      <FlakeFlip />

      <P>
        The <Term>flake score</Term> measures inconsistency — how often a test needed a retry to
        pass, and how often its result changed with no change underneath it. A test that fails every
        time scores zero, and shows up under <em>most-failing</em> instead. Both lists exist, side
        by side, and they deliberately do not overlap.
      </P>

      <P>
        A test&rsquo;s own page adds the rest: fail rate, average and p95 duration, its distinct
        failure modes grouped by the signature from act two, and every failure in full with branch,
        commit, attempts, stack and captured output. If a test is known-flaky and drowning the
        dashboards, <Term>quarantine</Term> it — the test stays visible and still reported, it just
        stops dominating the numbers. Quarantine is not skipping, and it is not deleting.
      </P>
    </Act>
  );
}

function StripRow({
  term,
  detail,
  cells,
}: {
  term: string;
  detail: string;
  cells: RecentOutcome[];
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <dt className="w-16 shrink-0 text-[11px] font-medium">{term}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-3">
        <OutcomeStrip cells={cells} href="#history" testName={`${term} example`} />
        <span className="text-[11px] text-[var(--color-ink-muted)]">{detail}</span>
      </dd>
    </div>
  );
}

/* ── Act 4 ─────────────────────────────────────────────────────────────────── */

const HELP_RUN_POINTS = [
  {
    label: "09:08",
    detail: "Checkout · main",
    passed: 141,
    failed: 3,
    skipped: 2,
    flaky: 1,
    passRate: 96.6,
    durationMs: 247_000,
  },
  {
    label: "09:26",
    detail: "Payments API · main",
    passed: 146,
    failed: 1,
    skipped: 1,
    flaky: 0,
    passRate: 98.6,
    durationMs: 222_000,
  },
  {
    label: "10:01",
    detail: "Checkout · feature/refunds",
    passed: 132,
    failed: 12,
    skipped: 3,
    flaky: 2,
    passRate: 89.8,
    durationMs: 318_000,
  },
  {
    label: "10:38",
    detail: "Billing · main",
    passed: 145,
    failed: 2,
    skipped: 1,
    flaky: 1,
    passRate: 97.3,
    durationMs: 259_000,
  },
  {
    label: "11:12",
    detail: "Checkout · main",
    passed: 147,
    failed: 0,
    skipped: 1,
    flaky: 0,
    passRate: 99.3,
    durationMs: 231_000,
  },
  {
    label: "11:47",
    detail: "Payments API · release/4.8",
    passed: 143,
    failed: 3,
    skipped: 2,
    flaky: 1,
    passRate: 96.6,
    durationMs: 274_000,
  },
  {
    label: "12:19",
    detail: "Checkout · main",
    passed: 146,
    failed: 1,
    skipped: 1,
    flaky: 0,
    passRate: 98.6,
    durationMs: 238_000,
  },
] as const;

function ActFour() {
  return (
    <Act id="trends" number={4} title="How are we doing?">
      <P>
        Zoom out from one test and the dashboards answer the question a team lead has: is this
        getting better or worse, and where is the damage concentrated. Headline numbers first, for
        the window you choose.
      </P>

      <Illustration caption="StatTile, the same component the dashboards use.">
        <Card className="grid grid-cols-2 divide-x divide-y divide-[var(--color-border-subtle)] sm:grid-cols-4 sm:divide-y-0">
          <StatTile label="Pass rate" value="96.2%" tone="passed" hint="last 30 days" />
          <StatTile label="Runs" value="330" hint="last 30 days" />
          <StatTile label="Failing" value="14" tone="failed" hint="tests, last 30 days" />
          <StatTile label="Flaky" value="9" tone="flaky" hint="score ≥ 20" />
        </Card>
      </Illustration>

      <P>
        The chart under them plots <Term>one point per run</Term>, not one per day. That is the
        whole reason it is drawn this way: a daily rollup averages the executions inside it, so a
        single run at 40% beside four at 100% reads as a mildly bad day and the bad run disappears.
        Every execution in the window is a point, and clicking one opens that run.
      </P>

      <Illustration caption="The current dashboard charts, rendered from seven sample publishes. Hover or focus any run for its details.">
        <div className="space-y-4">
          <Card className="p-4">
            <VolumeChart
              title="Execution over time"
              shape="area"
              height={150}
              days={HELP_RUN_POINTS.map((run) => ({
                label: run.label,
                detail: run.detail,
                passed: run.passed,
                failed: run.failed,
                skipped: run.skipped,
                flaky: run.flaky,
                runs: 1,
              }))}
            />
          </Card>
          <div className="grid gap-4 md:grid-cols-2">
            <Card className="p-4">
              <TrendChart
                title="Pass rate"
                height={150}
                points={HELP_RUN_POINTS.map((run) => ({
                  label: run.label,
                  value: run.passRate,
                  detail: run.detail,
                }))}
                unit="%"
                yMax={100}
                format="percent"
              />
            </Card>
            <Card className="p-4">
              <TrendChart
                title="CI time per run"
                height={150}
                points={HELP_RUN_POINTS.map((run) => ({
                  label: run.label,
                  value: run.durationMs,
                  detail: run.detail,
                }))}
                color="var(--color-series-2)"
                format="duration"
                shape="bars-line"
              />
            </Card>
          </div>
        </div>
      </Illustration>

      <P>
        Two charts carry a toggle, and the toggle changes the <em>question</em>, not the drawing:
      </P>

      <Table
        columns={["Chart", "Toggle", "The two questions"]}
        rows={[
          ["Execution over time", "counts / share", "how much did we run · what proportion failed"],
          ["Pass rate", "over time / by branch", "is the org healthy · is main healthy"],
        ]}
      />

      <P>
        <Term>CI time per run</Term> needs no toggle: its bars show each publish exactly, while the
        line shows the trailing five-run average on the same duration axis.
      </P>

      <P>
        Beside it, <Term>when runs happen</Term> folds the same window into a punchcard — hour of
        day across, weekday down — which answers what a time series cannot: whether the suite is on
        a schedule at all. A nightly job is a vertical band; a nightly job that stopped is a band
        with a hole in it.
      </P>

      <P>
        Below them sit the named lists — slowest tests by p95, because a test that is usually fast
        and occasionally slow is the one worth finding; failure concentration, which answers
        &ldquo;one bad test or systemic?&rdquo;; and the flake score distribution.
      </P>

      <Illustration caption="RankedBars with sample values — the failure concentration list.">
        <RankedBars
          title="Failure concentration · last 30 days"
          bars={[
            {
              label: "test_refund_partial_amount",
              value: 76,
              display: "76 (41%)",
              detail: "checkout-web",
            },
            {
              label: "test_webhook_retry_backoff",
              value: 38,
              display: "38 (21%)",
              detail: "payments-service",
            },
            {
              label: "test_cart_merge_on_login",
              value: 24,
              display: "24 (13%)",
              detail: "checkout-web",
            },
            {
              label: "test_invoice_pdf_render",
              value: 12,
              display: "12 (6%)",
              detail: "billing-api",
            },
          ]}
          footnote="Four tests account for 81% of every failure in the window. That is a fixable morning, not a quality crisis."
        />
      </Illustration>

      <P>
        Every filter, window and toggle lives in the <Term>URL</Term>. Nothing here is client state,
        which is a deliberate constraint rather than an implementation detail: a view you can paste
        into Slack, reload, and reach with the back button is worth more than one that animates
        nicely. <Code>?days=</Code>, <Code>?volume=share</Code>, <Code>?rate=branch</Code>,{" "}
        <Code>?tag=k:v</Code>, <Code>?verdict=todo</Code>.
      </P>

      <P>
        <Term>Reports</Term> is the same data asked a different way: you pick a question with blanks
        in it — <em>&ldquo;which tests failed most on branch ___ in the last ___ days&rdquo;</em> —
        and get a finished answer with a chart, a table and the caveat printed under it. Questions
        carry their intent; a chart builder produces charts nobody can later explain. Print any
        report and the stylesheet turns it into a document: chrome gone, panels kept whole, nothing
        depending on hover or on colour.
      </P>
    </Act>
  );
}

/* ── Act 5 ─────────────────────────────────────────────────────────────────── */

const ROLE_ROWS: [string, string, string, string, string, string][] = [
  ["Read everything", "✓", "✓", "✓", "✓", "✓"],
  ["Upload results, edit tags, quarantine", "", "✓", "✓", "✓", "✓"],
  ["Create and edit projects", "", "", "✓", "✓", "✓"],
  ["Rename a run, record a verdict, delete a run", "", "", "", "✓", "✓"],
  ["Archive and restore projects", "", "", "", "✓", "✓"],
  ["Manage members and API tokens", "", "", "", "✓", "✓"],
  ["Delete a project or the organisation", "", "", "", "", "✓"],
];

function ActFive() {
  return (
    <Act id="access" number={5} title="Who can do what">
      <P>
        Membership is of an <Term>organisation</Term>, and it grants access to every project in it.
        Roles are ordered — each includes everything below it — and they control what you can{" "}
        <em>do</em>, never what you can see.
      </P>

      <div className="mt-4 overflow-x-auto rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)]">
        <table className="w-full min-w-[34rem] text-left text-[12px]">
          <thead>
            <tr className="border-b border-[var(--color-border-subtle)] text-[10px] tracking-widest text-[var(--color-ink-muted)] uppercase">
              <th className="px-4 py-2 font-medium">Can</th>
              {["viewer", "member", "maintainer", "admin", "owner"].map((role) => (
                <th key={role} className="px-3 py-2 text-center font-medium">
                  {role}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border-subtle)]">
            {ROLE_ROWS.map((row) => (
              <tr key={row[0]}>
                <td className="px-4 py-2">{row[0]}</td>
                {row.slice(1).map((cell, index) => (
                  <td key={index} className="px-3 py-2 text-center">
                    {cell ? (
                      <span className="text-[var(--color-status-passed)]" aria-label="yes">
                        ✓
                      </span>
                    ) : (
                      <span className="text-[var(--color-ink-muted)]" aria-label="no">
                        ·
                      </span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <P>
        The interface hides what your role cannot do and the server refuses it independently. Hiding
        a button is a convenience; the check behind it is the enforcement. Reaching a forbidden URL
        directly gives you a page saying{" "}
        <em>&ldquo;requires the admin role, yours is viewer&rdquo;</em> — not a 500, and not a
        silent success.
      </P>

      <Note title="Organisations cannot see each other, by construction">
        Every query that touches tenant data takes an organisation id explicitly; there is
        deliberately no variant that omits one. A query that forgets it returns nothing rather than
        somebody else&rsquo;s rows, and the isolation is proved from the outside in the test suite
        using ids that are perfectly valid in their own tenant.
      </Note>

      <H3>Tokens and CI</H3>

      <P>
        CI authenticates with a bearer token scoped to a project. One is minted the moment you
        create a project — that is the minute you are actually ready to wire up a pipeline — and
        more come from <Term>Settings → API tokens</Term>. A token is shown once and only its sha256
        hash is stored, so the copy button matters more than it looks.
      </P>

      <div className="mt-4 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4">
        <CiSnippet projectKey="your-project" token={null} />
      </div>

      <P>
        The results land on the project&rsquo;s runs list within seconds, and act one starts again.
      </P>
    </Act>
  );
}

/* ── Footer ────────────────────────────────────────────────────────────────── */

function Footer({ appHref, appLabel }: { appHref: string; appLabel: string }) {
  return (
    <section className="mt-14 border-t border-[var(--color-border-subtle)] pt-6">
      <H3>Keyboard</H3>
      <Table
        columns={["Key", "Does"]}
        rows={[
          ["⌘K / Ctrl-K", "Command palette — jump to a project, test or page"],
          ["?", "This page, from anywhere in the app"],
          ["[", "Collapse or expand the sidebar"],
          ["esc", "Close the palette, a dropdown, or the mobile nav"],
        ]}
      />

      <p className="mt-6 text-[12px] leading-relaxed text-[var(--color-ink-muted)]">
        This page is the narrative. The exhaustive reference — every role boundary measured rather
        than described, the seeded accounts, the scenario projects, troubleshooting — lives in{" "}
        <Code>docs/user-guide.md</Code> in the repository, with the developer reference beside it in{" "}
        <Code>docs/architecture.md</Code>.
      </p>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-border-subtle)] pt-4 text-[12px]">
        <a href={appHref} className="underline hover:text-[var(--color-ink)]">
          {appLabel}
        </a>
        <p className="text-[var(--color-ink-muted)]">
          Made with{" "}
          <span
            role="img"
            aria-label="love"
            className="text-[var(--color-status-failed)]"
            title="love"
          >
            ♥
          </span>{" "}
          by <span className="text-[var(--color-ink)]">{CREDIT.name}</span>
        </p>
      </div>
    </section>
  );
}

/* ── Small building blocks ─────────────────────────────────────────────────── */

function Act({
  id,
  number,
  title,
  children,
}: {
  id: string;
  number: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="tc-help-anchor mt-14">
      <div className="flex items-baseline gap-3 border-b border-[var(--color-border-subtle)] pb-2">
        <span className="font-mono text-[11px] text-[var(--color-ink-muted)] tabular-nums">
          {number}
        </span>
        <h2 className="text-base font-semibold tracking-tight">{title}</h2>
      </div>
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

function H3({ children }: { children: ReactNode }) {
  return <h3 className="mt-8 text-[13px] font-semibold">{children}</h3>;
}

function P({ children }: { children: ReactNode }) {
  return <p className="text-[13px] leading-relaxed">{children}</p>;
}

/** Bold-ish, never a link: the vocabulary being introduced, marked once. */
function Term({ children }: { children: ReactNode }) {
  return <strong className="font-medium">{children}</strong>;
}

function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-[var(--color-surface-raised)] px-1 py-0.5 font-mono text-[11px]">
      {children}
    </code>
  );
}

/**
 * Wraps a live component so a reader is never left wondering whether the numbers are
 * theirs. Everything inside is sample data; the component around it is the real one.
 */
function Illustration({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <figure className="mt-4">
      {children}
      <figcaption className="mt-2 text-[11px] text-[var(--color-ink-muted)]">
        <span className="font-mono">sample data</span> · {caption}
      </figcaption>
    </figure>
  );
}

function Note({ title, children }: { title: string; children: ReactNode }) {
  return (
    <aside className="rounded-lg border-l-2 border-[var(--color-series-1)] bg-[var(--color-surface-raised)] px-4 py-3">
      <p className="text-[12px] font-medium">{title}</p>
      <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-ink-muted)]">{children}</p>
    </aside>
  );
}

function Table({ columns, rows }: { columns: string[]; rows: string[][] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)]">
      <table className="w-full min-w-[30rem] text-left text-[12px]">
        <thead>
          <tr className="border-b border-[var(--color-border-subtle)] text-[10px] tracking-widest text-[var(--color-ink-muted)] uppercase">
            {columns.map((column) => (
              <th key={column} className="px-4 py-2 font-medium">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border-subtle)]">
          {rows.map((row) => (
            <tr key={row[0]}>
              {row.map((cell, index) => (
                <td
                  key={index}
                  className={`px-4 py-2 ${index === 0 ? "font-medium" : "text-[var(--color-ink-muted)]"}`}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
