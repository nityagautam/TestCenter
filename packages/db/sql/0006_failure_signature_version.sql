-- ─────────────────────────────────────────────────────────────────────────────
-- 0006_failure_signature_version — version the failure clustering key
--
-- `test_results.failure_signature` is what turns "forty-seven red tests" into
-- "one root cause". The algorithm behind it changed (v1 → v2: the reporter
-- preamble is stripped before hashing, because Playwright writes
-- `<spec>:<line>:<col> › <scenario title>` ahead of the real error and those
-- titles are unique by construction — measured on a real suite, 832 failures
-- produced 631 signatures before and 186 after).
--
-- Recording the version rather than silently rewriting is the same discipline
-- `test_cases.fingerprint_version` applies to test identity: a half-migrated
-- table has to be *detectable*, so a backfill can find stale rows, resume after
-- an interruption, and be verified afterwards. Without it the only way to know
-- whether a row is current is to recompute it and compare.
--
-- Why this is a cheap migration where a fingerprint change is not:
--
--   `fingerprint_version` covers test IDENTITY. Bump it and every test looks
--   new — flake scores, quarantine, ownership and "when did this start failing"
--   all detach from their history, which is why that column exists to let old
--   and new coexist through a long backfill.
--
--   A failure signature is only a GROUPING KEY. Nothing durable hangs off it:
--   no rollup, no aggregate, one `GROUP BY` in `testFailureModes`. Every input
--   needed to recompute it — project_id, failure_type, failure_message,
--   stack_trace — is still on the row. So this can be changed and backfilled
--   without touching identity, and `FINGERPRINT_VERSION` deliberately does not
--   move.
--
-- Nullable with no default, so this is a metadata-only change on a partitioned
-- table with no row rewrite. NULL means "written before versioning existed",
-- which is exactly the set the backfill has to visit — distinguishing it from
-- 1, which would claim the row had been checked.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE test_results
  ADD COLUMN IF NOT EXISTS failure_signature_version smallint;

-- Partial: only failing rows carry a signature, and only stale ones are of
-- interest. On a table where most rows are passes this stays small enough to be
-- worth having for the backfill's repeated "what is left?" scan.
CREATE INDEX IF NOT EXISTS test_results_stale_signature_idx
  ON test_results (project_id)
  WHERE failure_signature IS NOT NULL AND failure_signature_version IS DISTINCT FROM 2;

COMMENT ON COLUMN test_results.failure_signature_version IS
  'Which FAILURE_SIGNATURE_VERSION produced failure_signature. NULL = pre-versioning, needs backfill. Independent of test_cases.fingerprint_version, which versions test identity.';
