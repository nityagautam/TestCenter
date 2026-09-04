-- ─────────────────────────────────────────────────────────────────────────────
-- 0007_failure_triage — a human category attached to a failure signature
--
-- `failureCategories` already reads a category out of every failure mechanically
-- (assertion, timeout, infra…). That answers "what kind of error is this". It
-- cannot answer "whose problem is it", and those are different axes: an assertion
-- failure may be a product bug or a wrong test, and a timeout may be the
-- environment or genuinely slow code. Only a person knows which.
--
-- WHY THE SIGNATURE AND NOT THE RUN
--
-- `run_verdicts` records a judgement per run, which is the right grain for "was
-- this build acceptable". It is the wrong grain for a bug: the same root cause
-- appears in run after run, and re-judging it every time is work that never ends.
-- Attaching the category to the signature means triaging a cause *once* and having
-- every later occurrence inherit it — including occurrences in tests nobody has
-- looked at yet, since a signature spans tests.
--
-- APPEND-ONLY, like run_verdicts
--
-- A correction is a new row, not an UPDATE. "Who called this infra, and when?"
-- has to stay answerable after someone changes their mind, because the earlier
-- claim is what a developer acted on. Reads take the newest row per signature.
--
-- WHY THE LABEL IS DENORMALISED ONTO THIS TABLE
--
-- `title` and `sample_message` are copied here rather than joined from
-- `test_results`, and that is not a caching decision. `test_results` is
-- partitioned monthly with a retention window, so the failures a triage describes
-- are eventually dropped. Without a stored label an older triage row renders as a
-- bare 64-char hex digest — a category attached to something nobody can identify.
-- The label has to outlive the evidence.
--
-- SCOPE
--
-- `computeFailureSignature` hashes the project id, so a signature is
-- project-scoped by construction: the same error in two projects is two
-- signatures and needs two triages. `project_id` is stored anyway, so a
-- project-scoped read does not have to go through test_results to find out which
-- project a signature belonged to.
--
-- VERSIONING
--
-- `failure_signature_version` is recorded because the digest is only meaningful
-- under the algorithm that produced it. When FAILURE_SIGNATURE_VERSION moves, the
-- backfill rewrites the digests on test_results and these rows would silently
-- stop matching anything; keeping the version makes that detectable rather than
-- mysterious, so a future migration can map or expire them deliberately.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS failure_triage (
  id                        uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id                    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id                uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  failure_signature         bytea NOT NULL,
  failure_signature_version smallint NOT NULL,
  category                  text NOT NULL,
  note                      text,
  -- Survives the retention of the failures it describes. See the note above.
  title                     text NOT NULL,
  sample_message            text,
  created_by                uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at                timestamptz NOT NULL DEFAULT now()
);

-- The read every consumer performs: newest row for a set of signatures in one org.
CREATE INDEX IF NOT EXISTS failure_triage_lookup_idx
  ON failure_triage (org_id, failure_signature, created_at DESC);

-- For the dashboard breakdown, which counts current triages per project.
CREATE INDEX IF NOT EXISTS failure_triage_project_idx
  ON failure_triage (org_id, project_id, created_at DESC);

COMMENT ON TABLE failure_triage IS
  'Append-only human category per failure signature. Newest row per (org_id, failure_signature) wins. Distinct from run_verdicts, which judges a run rather than a cause.';
