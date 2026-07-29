-- ─────────────────────────────────────────────────────────────────────────────
-- 0002_run_warnings — surface non-fatal parse problems on the run
--
-- A report can import successfully while still losing something: illegal XML
-- characters stripped from captured output, a truncated document, a suite that
-- exceeded the retry-collapsing limit. Discarding those notes would make a
-- partial import indistinguishable from a clean one, so they are stored on the
-- run and shown next to its results.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE runs ADD COLUMN warnings jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Lets the run list flag affected runs without reading the whole column.
CREATE INDEX runs_with_warnings_idx ON runs (project_id, started_at DESC)
  WHERE warnings <> '[]'::jsonb;
