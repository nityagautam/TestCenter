-- ─────────────────────────────────────────────────────────────────────────────
-- 0008_failure_identity — store what a failure IS, extracted once at ingest
--
-- Until now the answer to "what kind of failure is this" was computed at read
-- time by a ~120-line SQL CASE over `failure_type`, `failure_message` and
-- `stack_trace`, with nested regexp_replace calls to strip the parts of reporter
-- output that describe the test rather than the error.
--
-- That had to go, for three reasons that all showed up in practice:
--
--   IT WAS DUPLICATED. `fingerprint.ts` already stripped the same reporter
--   preamble in TypeScript to build the clustering key. Two copies of one rule,
--   neither aware of the other.
--
--   IT WAS UNTESTABLE. The only way to check a rule was to run a query against
--   production-shaped data and eyeball the totals. Four real bugs were found that
--   way and only that way — stack frames returned as summaries, 570 of 838 rows
--   summarising as the single word "Error:", a banner line joined instead of the
--   description under it, and three failures called timeouts because the word
--   appeared in a stripped source excerpt rather than in the error.
--
--   SQL WAS THE WRONG HOST. The regexes live inside a TypeScript template
--   literal, which silently drops an unknown backslash escape, treats a backtick
--   as the end of the string, and reported "unterminated /* comment" when a block
--   comment ended early. Three separate escaping bugs, none of them about the
--   classification.
--
-- So: `extractFailureIdentity` in @testcenter/core does it once, at ingest, with
-- unit tests, and the result is stored. The read path becomes GROUP BY.
--
-- WHAT EACH COLUMN IS FOR
--
--   failure_class     the error class — AssertionError, java.net.SocketException.
--                     '' when the report named none. Groupable and displayable.
--   failure_summary   the first line that actually says something. This is the
--                     column that lets the UI show "SEO import job did not reach
--                     a terminal status" where it previously showed a scenario
--                     title, because 83% of one project's errors arrive in the
--                     <failure> BODY and never in the message attribute.
--   failure_category  one of the standard kinds. Was computed per read.
--   failure_source    which field the error was recovered from. Diagnoses the
--                     REPORTER rather than the test: all-'stack' means a reporter
--                     putting errors in the body, 'none' means it sent no error at
--                     all. That difference decides whether the fix is a rule here
--                     or a change upstream, and nothing else in the schema says it.
--
-- Nullable, no defaults: metadata-only on a partitioned table, no row rewrite.
-- NULL means "written before extraction existed", which is exactly the set the
-- backfill visits — distinguishable from a row that was visited and had nothing.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE test_results
  ADD COLUMN IF NOT EXISTS failure_class            text,
  ADD COLUMN IF NOT EXISTS failure_summary          text,
  ADD COLUMN IF NOT EXISTS failure_category         text,
  ADD COLUMN IF NOT EXISTS failure_source           text,
  ADD COLUMN IF NOT EXISTS failure_identity_version smallint;

-- The dashboard read: count failures per category within a window, per org/project.
CREATE INDEX IF NOT EXISTS test_results_category_idx
  ON test_results (org_id, project_id, failure_category, started_at DESC)
  WHERE failure_category IS NOT NULL;

-- The backfill's repeated "what is left?" scan.
CREATE INDEX IF NOT EXISTS test_results_stale_identity_idx
  ON test_results (project_id)
  WHERE status IN ('failed', 'error') AND failure_identity_version IS DISTINCT FROM 1;

COMMENT ON COLUMN test_results.failure_category IS
  'Standard failure kind from extractFailureIdentity in @testcenter/core. Derived, recomputable, versioned by failure_identity_version.';
COMMENT ON COLUMN test_results.failure_source IS
  'Which report field the error was recovered from: type, message, stack or none. Diagnoses the reporter, not the test.';
