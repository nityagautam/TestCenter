import { StatusBadge } from "@/components/ui";

/**
 * Illustrations for the help narrative.
 *
 * Two rules hold this file together.
 *
 * **No screenshots.** A screenshot of the run page is wrong the day someone moves a
 * column, and nothing in CI will ever tell us. Everything here is either a real component
 * from the app rendered with sample props — `StatusBadge` below, `OutcomeStrip`,
 * `VerdictBadge`, `ResultBar` and `RankedBars` in the narrative itself — or a diagram of a
 * *concept* that has no screen of its own: how a fingerprint is computed and why failures
 * cluster. Concepts do not go stale when the layout changes; screens do.
 *
 * **Motion only where it teaches.** Two loops in the whole page, both animating something
 * static art cannot state: results arriving progressively, and a test disagreeing with
 * itself across identical reruns. Their keyframes live in `globals.css` alongside the note
 * explaining why each ends where it does.
 *
 * The diagrams are inline SVG at a fixed size inside a horizontally scrolling box rather
 * than a `width: 100%` drawing. Scaling one down to a 360px phone takes 11px labels to
 * about six, which is decorative rather than readable; scrolling keeps the text at the size
 * it was drawn for. Every diagram carries `role="img"` with a full sentence as its name,
 * and the paragraph beside it makes the same point in prose — the SVG is never the only
 * copy of anything.
 */

/** Sample data. Same shape as a real run, chosen to make the point being illustrated. */
const PARSE_CELLS = [
  "passed",
  "passed",
  "passed",
  "failed",
  "passed",
  "passed",
  "passed",
  "skipped",
  "passed",
  "passed",
  "failed",
  "passed",
  "passed",
  "passed",
] as const;

const CELL_WIDTH = 14;
const CELL_GAP = 3;
const STRIP_WIDTH = PARSE_CELLS.length * CELL_WIDTH + (PARSE_CELLS.length - 1) * CELL_GAP;

const GLYPH: Record<string, string> = { passed: "✓", failed: "✕", skipped: "–" };

function colorFor(status: string): string {
  if (status === "failed") return "var(--color-status-failed)";
  if (status === "skipped") return "var(--color-status-skipped)";
  return "var(--color-status-passed)";
}

function ParseCells({ ghost = false }: { ghost?: boolean }) {
  return (
    <div className="flex" style={{ gap: CELL_GAP, width: STRIP_WIDTH }} aria-hidden>
      {PARSE_CELLS.map((status, index) => (
        <span
          key={index}
          className="flex items-center justify-center rounded-[2px] text-[9px] leading-none font-bold text-white"
          style={{
            width: CELL_WIDTH,
            height: 18,
            background: ghost ? "var(--color-border-subtle)" : colorFor(status),
          }}
        >
          {ghost ? "" : GLYPH[status]}
        </span>
      ))}
    </div>
  );
}

/**
 * A run being parsed: a report arrives, results appear, the status settles.
 *
 * The one thing a new reader gets wrong about ingest is thinking the upload *is* the
 * result. It is not — the upload returns immediately with a run id, a worker parses the
 * file, and the page fills in while you watch. Three status pills and a filling strip say
 * that in a way a sentence has to argue for.
 */
export function IngestFlow() {
  return (
    <figure className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-4">
      <div className="flex flex-wrap items-center gap-4">
        <div className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-2">
          <div className="font-mono text-[11px]">junit.xml</div>
          <div className="mt-0.5 font-mono text-[10px] text-[var(--color-ink-muted)]">
            14 testcase elements
          </div>
        </div>

        <svg
          viewBox="0 0 40 12"
          className="h-3 w-10 shrink-0 text-[var(--color-ink-muted)]"
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
          aria-hidden
        >
          <path d="M0 6h34" strokeDasharray="3 3" />
          <path d="M31 3l4 3-4 3" />
        </svg>

        <div>
          {/* The three real badges, stacked in one grid cell so the pill changes in place
              rather than the row reflowing three times per loop. */}
          <div className="grid justify-items-start">
            <span className="tc-help-cue-pending col-start-1 row-start-1">
              <StatusBadge status="pending" />
            </span>
            <span className="tc-help-cue-parsing col-start-1 row-start-1">
              <StatusBadge status="parsing" />
            </span>
            <span className="tc-help-cue-complete col-start-1 row-start-1">
              <StatusBadge status="complete" />
            </span>
          </div>

          <div className="relative mt-2" style={{ width: STRIP_WIDTH, height: 18 }}>
            <div className="absolute inset-0">
              <ParseCells ghost />
            </div>
            {/* Clipping window, not per-cell delays — see the keyframe note in globals.css. */}
            <div className="tc-help-reveal absolute inset-y-0 left-0 overflow-hidden">
              <ParseCells />
            </div>
          </div>
        </div>
      </div>

      <figcaption className="mt-3 text-[11px] leading-relaxed text-[var(--color-ink-muted)]">
        Uploading returns a run id straight away; a worker parses the report behind it. The run page
        streams progress, so you watch this happen rather than reloading. It ends{" "}
        <span className="font-medium">complete</span>, or{" "}
        <span className="font-medium">partial</span> if some of the file could not be read, or{" "}
        <span className="font-medium">failed</span> if none of it could.
      </figcaption>
    </figure>
  );
}

/**
 * The same test, the same commit, four reruns — beside a test that is simply broken.
 *
 * This is the distinction the whole flake feature rests on, and it is the one people
 * routinely collapse. Animating it costs a reader nothing and settles the argument: the top
 * row cannot make up its mind, the bottom row is perfectly consistent and perfectly red.
 */
export function FlakeFlip() {
  return (
    <figure className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-4">
      <div className="space-y-3">
        <FlipRow
          label="Flaky"
          hint="same commit, four reruns — the result is not a fact about the code"
          cells={
            <>
              <FlipCell flipClass="tc-help-flip-1" />
              <FlipCell flipClass="tc-help-flip-2" />
              <FlipCell flipClass="tc-help-flip-3" />
              <FlipCell flipClass="tc-help-flip-4" />
            </>
          }
        />
        <FlipRow
          label="Broken"
          hint="same commit, four reruns — the result is a fact about the code"
          cells={
            <>
              <StaticCell />
              <StaticCell />
              <StaticCell />
              <StaticCell />
            </>
          }
        />
      </div>
      <figcaption className="mt-3 text-[11px] leading-relaxed text-[var(--color-ink-muted)]">
        A test that always fails scores <span className="font-mono">0</span> for flakiness. It is
        not unreliable — it is reliably telling you something. That is why the flaky list and the
        most-failing list are separate lists, and why mixing them makes both useless.
      </figcaption>
    </figure>
  );
}

function FlipRow({ label, hint, cells }: { label: string; hint: string; cells: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="w-14 shrink-0 text-[11px] font-medium">{label}</span>
      <div className="flex gap-[3px]" aria-hidden>
        {cells}
      </div>
      <span className="min-w-0 flex-1 text-[11px] text-[var(--color-ink-muted)]">{hint}</span>
    </div>
  );
}

/**
 * A permanent pass layer with a fail layer blinking over it.
 *
 * Both layers are always in the DOM and always the same size, so nothing reflows and the
 * cell never reports a different accessible state — the row is `aria-hidden` and the
 * caption carries the meaning, because "a square that is sometimes red" is not something a
 * screen reader should be asked to narrate.
 */
function FlipCell({ flipClass }: { flipClass: string }) {
  return (
    <span className="relative grid size-5">
      <span
        className="col-start-1 row-start-1 flex items-center justify-center rounded-sm text-[10px] leading-none font-bold text-white"
        style={{ background: "var(--color-status-passed)" }}
      >
        ✓
      </span>
      <span
        className={`col-start-1 row-start-1 flex items-center justify-center rounded-sm text-[10px] leading-none font-bold text-white ${flipClass}`}
        style={{ background: "var(--color-status-failed)" }}
      >
        ✕
      </span>
    </span>
  );
}

function StaticCell() {
  return (
    <span
      className="flex size-5 items-center justify-center rounded-sm text-[10px] leading-none font-bold text-white"
      style={{ background: "var(--color-status-failed)" }}
    >
      ✕
    </span>
  );
}

/** Horizontal scroll rather than scaling, so 11px labels stay 11px. */
function Diagram({
  label,
  width,
  height,
  children,
}: {
  label: string;
  width: number;
  height: number;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-4">
      <svg
        role="img"
        aria-label={label}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="max-w-none"
      >
        {children}
      </svg>
    </div>
  );
}

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

/*
 * Palette tokens reach the SVG through `style`, never through a presentation attribute.
 *
 * `style={INK}` is a presentation attribute, and support for `var()` in one is
 * not universal — where it is unsupported the value is simply invalid and the shape falls
 * back to solid black. That failure is silent, renders as a diagram of black boxes, and
 * would only ever be noticed by whoever happened to open the page in the wrong browser.
 * Inline styles are plain CSS and resolve everywhere, which is also how the rest of the app
 * hands token colours to markup.
 *
 * `fill` and `stroke` inherit, so setting them on a `<g>` covers its children.
 */
const INK = { fill: "var(--color-ink)" };
const MUTED = { fill: "var(--color-ink-muted)" };
const FAILED = { fill: "var(--color-status-failed)" };
const IDENTITY = { fill: "var(--color-series-1)" };
const PANEL = { fill: "var(--color-surface-raised)", stroke: "var(--color-border-subtle)" };
const RULE = { stroke: "var(--color-border-subtle)" };
const ARROW = { stroke: "var(--color-ink-muted)" };

/**
 * Why twenty-four red results are usually two problems.
 *
 * The signature is computed at ingest from the normalized error type and the top three
 * frames of *your* code — framework frames are dropped, because they are identical across
 * unrelated failures and would collapse everything into one useless cluster.
 */
export function SignatureClustering() {
  const columns = 6;
  const rows = 4;
  const dots = Array.from({ length: columns * rows }, (_, index) => index);

  return (
    <Diagram
      width={620}
      height={186}
      label="Twenty-four failed results from one run, grouped by failure signature into two clusters: a ConnectionError seen seventeen times, and an AssertionError seen seven times."
    >
      <text x="0" y="12" fontSize="11" style={MUTED}>
        24 red results, one run
      </text>
      {dots.map((index) => (
        <rect
          key={index}
          x={(index % columns) * 20}
          y={26 + Math.floor(index / columns) * 20}
          width="15"
          height="15"
          rx="2"
          style={FAILED}
        />
      ))}
      <text x="0" y="126" fontSize="11" style={MUTED}>
        every one of them says
      </text>
      <text x="0" y="141" fontSize="11" style={MUTED}>
        &quot;the suite is broken&quot;
      </text>

      {/* Fan-in: many results, two causes. */}
      <path d="M124 60 C 170 60, 190 52, 232 52" fill="none" style={RULE} strokeWidth="1.5" />
      <path d="M124 76 C 170 76, 190 112, 232 112" fill="none" style={RULE} strokeWidth="1.5" />
      <text x="132" y="34" fontSize="10" style={MUTED}>
        grouped by failure signature
      </text>
      <text x="132" y="47" fontSize="10" style={MUTED}>
        (error type + your top 3 frames)
      </text>

      <g>
        <rect x="238" y="30" width="370" height="44" rx="6" style={PANEL} />
        <text x="252" y="48" fontSize="11" fontWeight="600" style={INK}>
          ConnectionError
        </text>
        <text x="596" y="48" fontSize="11" textAnchor="end" fontFamily={MONO} style={FAILED}>
          17×
        </text>
        <text x="252" y="64" fontSize="10" fontFamily={MONO} style={MUTED}>
          connection refused: payments-stub:8080
        </text>
      </g>

      <g>
        <rect x="238" y="90" width="370" height="44" rx="6" style={PANEL} />
        <text x="252" y="108" fontSize="11" fontWeight="600" style={INK}>
          AssertionError
        </text>
        <text x="596" y="108" fontSize="11" textAnchor="end" fontFamily={MONO} style={FAILED}>
          7×
        </text>
        <text x="252" y="124" fontSize="10" fontFamily={MONO} style={MUTED}>
          expected 200, got 402
        </text>
      </g>

      <text x="238" y="156" fontSize="11" style={MUTED}>
        one dead dependency, and one genuine regression
      </text>
      <text x="238" y="171" fontSize="11" style={MUTED}>
        — two problems, two owners
      </text>
    </Diagram>
  );
}

/**
 * How a test keeps its identity when everything around its name changes.
 *
 * The single highest-leverage thing to understand about this product: without a stable
 * identity there is no history, and without history there is no flakiness, no "when did
 * this start failing", no duration trend and no quarantine.
 */
export function FingerprintPipeline() {
  return (
    <Diagram
      width={700}
      height={214}
      label="A suite path, a test name carrying a shard and retry suffix, and a parameter are normalized — shard and worker tags stripped, retry suffixes dropped, uuids and timestamps scrubbed — then hashed with the project id into one sha256 identity that stays the same across every run."
    >
      <text x="0" y="12" fontSize="11" style={MUTED}>
        what the report said
      </text>

      <g fontFamily={MONO} fontSize="11" style={INK}>
        <rect x="0" y="22" width="250" height="26" rx="4" style={PANEL} />
        <text x="10" y="39">
          /home/runner/work/app/tests/refund.py
        </text>

        <rect x="0" y="56" width="250" height="26" rx="4" style={PANEL} />
        <text x="10" y="73">
          test_refund[shard-3] (retry #2)
        </text>

        <rect x="0" y="90" width="250" height="26" rx="4" style={PANEL} />
        <text x="10" y="107">
          run=8f21c0e4-…, currency=EUR
        </text>
      </g>

      <path d="M256 69h26" style={ARROW} strokeWidth="1" strokeDasharray="3 3" fill="none" />
      <path d="M279 66l4 3-4 3" style={ARROW} strokeWidth="1" fill="none" />

      <rect x="290" y="22" width="188" height="94" rx="6" style={PANEL} />
      <text x="302" y="40" fontSize="11" fontWeight="600" style={INK}>
        normalize
      </text>
      <g fontSize="10" style={MUTED}>
        <text x="302" y="58">
          · path → repo-relative
        </text>
        <text x="302" y="74">
          · strip shard / worker tags
        </text>
        <text x="302" y="90">
          · drop retry suffixes
        </text>
        <text x="302" y="106">
          · scrub uuids, timestamps
        </text>
      </g>

      <path d="M484 69h26" style={ARROW} strokeWidth="1" strokeDasharray="3 3" fill="none" />
      <path d="M507 66l4 3-4 3" style={ARROW} strokeWidth="1" fill="none" />

      <rect x="518" y="34" width="176" height="70" rx="6" style={PANEL} />
      <text x="530" y="52" fontSize="11" fontWeight="600" style={INK}>
        sha256
      </text>
      <text x="530" y="68" fontSize="10" fontFamily={MONO} style={MUTED}>
        v1 ␀ project ␀ suite ␀
      </text>
      <text x="530" y="82" fontSize="10" fontFamily={MONO} style={MUTED}>
        class ␀ name ␀ params
      </text>
      <text x="530" y="98" fontSize="11" fontFamily={MONO} style={IDENTITY}>
        9f2c4e…
      </text>

      <text x="0" y="146" fontSize="11" style={MUTED}>
        The same test on a laptop, on a CI runner, on shard 3, on its second retry, with a fresh
        uuid in its
      </text>
      <text x="0" y="162" fontSize="11" style={MUTED}>
        parameters — one identity, so the history below it belongs to one test rather than
        fragmenting
      </text>
      <text x="0" y="178" fontSize="11" style={MUTED}>
        into five. The displayed name always keeps the original text; only the hashed form is
        scrubbed.
      </text>
      <text x="0" y="200" fontSize="10" fontFamily={MONO} style={MUTED}>
        fingerprint_version is stored on every row, so the algorithm can change without a
        stop-the-world rebuild.
      </text>
    </Diagram>
  );
}
