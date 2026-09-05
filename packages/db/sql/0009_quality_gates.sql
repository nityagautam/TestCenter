-- ─────────────────────────────────────────────────────────────────────────────
-- 0009_quality_gates — configurable go/no-go on a run, and the record of it
--
-- WHY THIS IS NOT A COLUMN ON runs
--
-- `run_verdicts` already answers "was this build acceptable" and it is a person's
-- answer. This is the machine's. The two must stay separable: a gate can be wrong
-- in ways only a human can see, and a human sign-off does not make a pass rate
-- acceptable. The product already draws this line once — failure_category is read
-- from the report, failure_triage is claimed by somebody — and a gate is the same
-- distinction applied to a whole run.
--
-- THREE LAYERS, ONE ROW EACH
--
-- An organisation sets a floor, a project tightens it, a branch tightens it again:
-- main can demand no regressions while a feature branch does not. The layer a row
-- belongs to is *derived* from which columns are null rather than stored beside
-- them, because a stored `scope` column can disagree with its own keys and then
-- nothing tells you which one lied. The CHECK below is what keeps the three shapes
-- the only legal ones.
--
-- WHY THE RESULT STORES ITS OWN CONFIG
--
-- A gate result is a decision CI acted on. "Why did build 4812 fail the gate" has
-- to stay answerable after somebody edits the thresholds, so the resolved config is
-- snapshotted onto the result rather than joined at read time. This is the same
-- reasoning failure_triage uses for denormalising its label, and it is also what
-- pays for layered config being assembled from three places: however it was
-- composed, the answer afterwards is in one row.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS quality_gates (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- NULL at the organisation layer.
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  -- NULL unless this row is a branch override.
  branch     text,
  -- A Partial<GateConfig>: only the fields this layer means to set. Absent fields
  -- inherit, which is what lets a branch change one threshold without restating the
  -- rest and then drifting from the layer it copied.
  config     jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT quality_gates_layer_shape CHECK (
    (project_id IS NULL     AND branch IS NULL)     OR  -- org
    (project_id IS NOT NULL AND branch IS NULL)     OR  -- project
    (project_id IS NOT NULL AND branch IS NOT NULL)     -- branch
  )
);

-- One row per layer. Partial indexes rather than a single unique key, because NULL
-- is not equal to itself in a unique constraint and two org-level rows would
-- otherwise be perfectly legal.
CREATE UNIQUE INDEX IF NOT EXISTS quality_gates_org_layer_idx
  ON quality_gates (org_id) WHERE project_id IS NULL AND branch IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS quality_gates_project_layer_idx
  ON quality_gates (org_id, project_id) WHERE project_id IS NOT NULL AND branch IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS quality_gates_branch_layer_idx
  ON quality_gates (org_id, project_id, branch) WHERE branch IS NOT NULL;

COMMENT ON TABLE quality_gates IS
  'Layered gate policy. The layer is derived from which of project_id and branch are null; more specific layers override, field by field.';

CREATE TABLE IF NOT EXISTS run_gate_results (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id          uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  outcome         text NOT NULL,
  -- True whenever a rule was broken, even under advisory enforcement. Without it
  -- "what would this gate have blocked" is unanswerable, which is the entire
  -- purpose of running advisory first.
  breached        boolean NOT NULL,
  enforcement     text NOT NULL,
  gate_version    smallint NOT NULL,
  resolved_config jsonb NOT NULL,
  -- Per-rule outcomes, so a CI log can say which rule and by how much rather than
  -- sending somebody to the UI to find out.
  rule_results    jsonb NOT NULL,
  -- The facts judged. Kept because the run's counters keep moving — a re-ingest or
  -- a deleted run rewrites them — and a verdict whose inputs cannot be reconstructed
  -- is not auditable.
  facts           jsonb NOT NULL,
  evaluated_at    timestamptz NOT NULL DEFAULT now()
);

-- One result per run: the gate is a property of the finished run, not a log of
-- opinions about it. Re-evaluation replaces rather than accumulates, which is the
-- opposite of run_verdicts and failure_triage — those record who claimed what, and
-- this records what the rules computed.
CREATE UNIQUE INDEX IF NOT EXISTS run_gate_results_run_idx ON run_gate_results (run_id);
CREATE INDEX IF NOT EXISTS run_gate_results_project_idx
  ON run_gate_results (org_id, project_id, evaluated_at DESC);

COMMENT ON TABLE run_gate_results IS
  'Mechanical go/no-go per run, with the resolved config and facts it judged. Distinct from run_verdicts, which is a person''s judgement.';
