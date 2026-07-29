-- ─────────────────────────────────────────────────────────────────────────────
-- 0003_repair_double_encoded_jsonb
--
-- Repairs rows written before jsonb values were bound with sql.json().
--
-- postgres.js JSON-encodes any value bound to a jsonb column or an explicit
-- ::jsonb cast. Pre-stringifying the value therefore encoded it twice and stored
-- a JSON *string* scalar where an object or array was intended. Nothing errored on
-- insert, which is what made it dangerous:
--
--   * `tags @> '{"suite":"smoke"}'` never matched, so tag filtering silently
--     returned nothing rather than failing loudly
--   * jsonb_array_length(warnings) raised "cannot get array length of a scalar",
--     taking down the run list entirely
--
-- `value #>> '{}'` extracts the scalar's text, which is the original JSON, and
-- re-casting parses it once. Guarded by jsonb_typeof so this is idempotent and a
-- no-op on correctly stored rows.
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE runs
   SET warnings = (warnings #>> '{}')::jsonb
 WHERE jsonb_typeof(warnings) = 'string';

UPDATE runs
   SET tags = (tags #>> '{}')::jsonb
 WHERE jsonb_typeof(tags) = 'string';

UPDATE test_results
   SET tags = (tags #>> '{}')::jsonb
 WHERE jsonb_typeof(tags) = 'string';

UPDATE test_cases
   SET parameters = (parameters #>> '{}')::jsonb
 WHERE parameters IS NOT NULL AND jsonb_typeof(parameters) = 'string';

UPDATE idempotency_keys
   SET response = (response #>> '{}')::jsonb
 WHERE response IS NOT NULL AND jsonb_typeof(response) = 'string';

-- Any row still holding a scalar after this means something writes jsonb without
-- sql.json(). Fail the migration rather than leave a silent correctness hole.
DO $$
DECLARE
  bad_count integer;
BEGIN
  SELECT
    (SELECT count(*) FROM runs WHERE jsonb_typeof(warnings) <> 'array')
  + (SELECT count(*) FROM runs WHERE jsonb_typeof(tags) <> 'object')
  + (SELECT count(*) FROM test_results WHERE jsonb_typeof(tags) <> 'object')
  INTO bad_count;

  IF bad_count > 0 THEN
    RAISE EXCEPTION
      'jsonb repair incomplete: % row(s) still hold a non-container value', bad_count;
  END IF;
END $$;
