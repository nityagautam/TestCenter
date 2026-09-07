-- ─────────────────────────────────────────────────────────────────────────────
-- 0010_group_inline_values — a project's claim about how it names its tests
--
-- Parameterised tests are grouped by hoisting their parameters out of the
-- reported name, which the parser can do exactly wherever a framework leaves a
-- delimiter: pytest's test_login[alice-secret], JUnit 5's add(int, int)[1],
-- Cucumber's "Example #1.2". Those rules are facts about a format and need no
-- configuration.
--
-- Some suites instead interpolate their example values straight into the scenario
-- title, with nothing to key off:
--
--   Test export on cluster "TIRAUAT" as case no "1"
--   Test export on cluster "JMDUAT"  as case no "2"
--
-- Treating every quoted literal as a parameter recovers those. Measured on a real
-- project it takes 2,542 reported tests to 540 canonical ones, 4.7x, and turns a
-- dashboard that ranked rows into one that ranks scenarios.
--
-- It is also wrong for somebody else. A suite whose titles legitimately quote
-- things — returns "404" for a brand, returns "200" for a brand — has those two
-- merged into one test, and no rule can tell that apart from an outline. The
-- previous attempt applied this globally and was wrong for four of the six
-- producers this product reads.
--
-- So it is a per-project switch, defaulting to off. A project turning it on is
-- asserting something true about its own naming conventions, which is a claim the
-- product cannot make on anybody's behalf.
--
-- CHANGING IT REWRITES IDENTITY
--
-- The flag changes what goes in `name` and `parameters`, and both feed the
-- fingerprint, so flipping it re-keys every test case in the project. Existing
-- rows must be re-derived in place — same id, new fingerprint — or history
-- detaches from its results. See `rederive-test-identity` in packages/db/scripts.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS group_inline_values boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN projects.group_inline_values IS
  'Treat quoted literals and <PLACEHOLDER> tokens in a test name as data-driven parameters. Off by default: correct for suites that inline example values into scenario titles, wrong for suites whose titles legitimately quote things.';
