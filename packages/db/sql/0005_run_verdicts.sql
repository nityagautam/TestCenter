-- ─────────────────────────────────────────────────────────────────────────────
-- 0005_run_verdicts — a human judgement recorded against a run
--
-- Everything else in this schema is measured. This is the one thing the product
-- cannot compute: *why* a run looks the way it does. "96%, 2 failing" cannot
-- distinguish a genuine regression from a UAT cluster being down, and that
-- distinction decides who gets handed the problem. Today it lives in chat and is
-- lost by the next morning.
--
-- Append-only, not a column on `runs`. A verdict is a claim someone else will act
-- on later, so "who called this infra, and when?" has to remain answerable after
-- it is corrected. The run shows its newest row; the earlier ones stay.
--
-- Deliberately inert with respect to every metric. Pass rates, trends and flake
-- scores ignore verdicts entirely, so no chart changes meaning when someone
-- labels a run. Whether an `infra` verdict should be excluded from trends is a
-- real question, but it is one to answer after seeing whether the labels get
-- applied consistently — not before.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE run_verdicts (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),

  -- Tenant-scoped like every other table here, even though run_id alone would
  -- identify the row: every read path filters by org_id, and a query that forgets
  -- to should return nothing rather than another tenant's judgement.
  org_id      uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  run_id      uuid NOT NULL REFERENCES runs (id) ON DELETE CASCADE,

  /*
   * The five outcomes, checked in the database rather than only in application code.
   *
   *   pass           reviewed; the failures are known and tolerated
   *   product-bug    a genuine regression, owned by whoever owns the code
   *   infra          environment or data, not the code under test
   *   flaky          non-deterministic, so not a real signal either way
   *   investigating  seen, not yet judged
   *
   * They are separate because the action differs: a product bug goes to a
   * developer, infra to whoever owns the cluster, flakiness to the test's author.
   * A CHECK rather than an enum type so adding a sixth is an ordinary migration
   * instead of an ALTER TYPE that cannot run inside a transaction on older
   * Postgres.
   */
  verdict     text NOT NULL CHECK (
    verdict IN ('pass', 'product-bug', 'infra', 'flaky', 'investigating')
  ),

  -- The sentence that actually helps the next person. Optional, because forcing a
  -- note on every verdict produces "n/a".
  note        text,

  -- Nullable and ON DELETE SET NULL: the judgement outlives the account that made
  -- it. Losing the attribution is bad; losing the verdict because someone left the
  -- company is worse.
  created_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- The run page and the run list both want "the newest verdict for this run", which
-- is a backwards index scan stopping at the first row per run.
CREATE INDEX run_verdicts_run_idx ON run_verdicts (run_id, created_at DESC);

-- "Show me everything marked infra this week", scoped to the tenant.
CREATE INDEX run_verdicts_org_verdict_idx ON run_verdicts (org_id, verdict, created_at DESC);
