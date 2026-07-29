-- ─────────────────────────────────────────────────────────────────────────────
-- 0001_init — Test Center schema v1
--
-- Two decisions from docs/test-center-plan.md §1b are baked in here and are the
-- reason this migration looks the way it does:
--
--   1. org_id is on every tenant-scoped table and in every index prefix, even
--      though we ship as a single internal org. This is the entire cost of
--      staying SaaS-ready, and it is near-zero now versus a painful retrofit.
--
--   2. test_results is partitioned monthly. NOT for query performance — at
--      <50k tests/day a single Postgres handles this trivially — but because
--      retention then becomes DROP PARTITION (instant) instead of a DELETE that
--      bloats the table and holds locks for minutes.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─── uuidv7 ──────────────────────────────────────────────────────────────────
-- Time-ordered UUIDs: index locality on insert (runs arrive in time order) plus
-- opaque external ids. Postgres 18 ships uuidv7() natively; this shim covers 17
-- and below and is safe to keep afterwards.
CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid AS $$
DECLARE
  unix_ts_ms bytea;
  uuid_bytes bytea;
BEGIN
  unix_ts_ms := substring(int8send((extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3);
  uuid_bytes := unix_ts_ms || gen_random_bytes(10);
  -- version 7 in the high nibble of byte 6
  uuid_bytes := set_byte(uuid_bytes, 6, (get_byte(uuid_bytes, 6) & 15) | 112);
  -- RFC 4122 variant (10xx) in the high bits of byte 8
  uuid_bytes := set_byte(uuid_bytes, 8, (get_byte(uuid_bytes, 8) & 63) | 128);
  RETURN encode(uuid_bytes, 'hex')::uuid;
END
$$ LANGUAGE plpgsql VOLATILE;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

-- ─── Tenancy ─────────────────────────────────────────────────────────────────

CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  email       text NOT NULL,
  name        text,
  avatar_url  text,
  -- Auth.js Google OIDC subject; null until first sign-in.
  google_sub  text UNIQUE,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  last_seen_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));

CREATE TABLE teams (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  slug        text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name        text NOT NULL,
  -- Notification target for tests this team owns (Phase 4).
  chat_channel text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug)
);

CREATE TABLE memberships (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id     uuid REFERENCES teams(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('owner', 'admin', 'maintainer', 'member', 'viewer')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- One role per (user, org) at org level; one per (user, team) at team level.
CREATE UNIQUE INDEX memberships_org_user_key ON memberships (org_id, user_id) WHERE team_id IS NULL;
CREATE UNIQUE INDEX memberships_team_user_key ON memberships (team_id, user_id) WHERE team_id IS NOT NULL;
CREATE INDEX memberships_user_idx ON memberships (user_id);

CREATE TABLE projects (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  team_id         uuid REFERENCES teams(id) ON DELETE SET NULL,
  -- Stable human key used by CI: POST /api/v1/runs?project=checkout-web
  key             text NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9._-]{0,127}$'),
  name            text NOT NULL,
  description     text,
  default_branch  text NOT NULL DEFAULT 'main',
  repository_url  text,
  retention_days  integer NOT NULL DEFAULT 365 CHECK (retention_days BETWEEN 7 AND 3650),
  artifact_retention_days integer NOT NULL DEFAULT 90 CHECK (artifact_retention_days BETWEEN 1 AND 3650),
  settings        jsonb NOT NULL DEFAULT '{}'::jsonb,
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, key)
);
CREATE INDEX projects_team_idx ON projects (org_id, team_id);

CREATE TABLE api_tokens (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Null scope = org-wide token (can ingest into any project in the org).
  project_id   uuid REFERENCES projects(id) ON DELETE CASCADE,
  name         text NOT NULL,
  -- Only the hash is stored; the plaintext is shown once at creation.
  token_hash   bytea NOT NULL UNIQUE,
  token_prefix text NOT NULL,
  scopes       text[] NOT NULL DEFAULT ARRAY['runs:write'],
  last_used_at timestamptz,
  expires_at   timestamptz,
  revoked_at   timestamptz,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_tokens_org_idx ON api_tokens (org_id, project_id);

-- ─── Runs ────────────────────────────────────────────────────────────────────

CREATE TABLE runs (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name              text,
  framework         text,
  framework_version text,

  -- pending  : created, awaiting artifact upload
  -- parsing  : artifacts uploaded, worker processing
  -- complete : all artifacts parsed successfully
  -- partial  : some artifacts failed to parse; results shown with a warning
  -- failed   : nothing usable was parsed
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'parsing', 'complete', 'partial', 'failed')),

  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  duration_ms       integer,

  environment       text,
  branch            text,
  commit_sha        text,
  pr_number         integer,

  ci_provider       text,
  ci_build_id       text,
  ci_build_number   text,
  ci_job_name       text,
  ci_job_url        text,

  -- Sharded CI: many uploads, one logical run.
  run_group_id      text,
  shard_index       integer,
  shard_total       integer,
  attempt           integer NOT NULL DEFAULT 1,

  total             integer NOT NULL DEFAULT 0,
  passed            integer NOT NULL DEFAULT 0,
  failed            integer NOT NULL DEFAULT 0,
  skipped           integer NOT NULL DEFAULT 0,
  errored           integer NOT NULL DEFAULT 0,
  blocked           integer NOT NULL DEFAULT 0,
  flaky             integer NOT NULL DEFAULT 0,
  pass_rate         numeric(5, 2) NOT NULL DEFAULT 0,

  tags              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by_token_id uuid REFERENCES api_tokens(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- The run list is the most-hit query in the product: project + recency.
CREATE INDEX runs_project_started_idx ON runs (project_id, started_at DESC);
CREATE INDEX runs_project_branch_started_idx ON runs (project_id, branch, started_at DESC);
CREATE INDEX runs_project_status_idx ON runs (project_id, status, started_at DESC);
CREATE INDEX runs_org_started_idx ON runs (org_id, started_at DESC);
CREATE INDEX runs_commit_idx ON runs (project_id, commit_sha) WHERE commit_sha IS NOT NULL;
CREATE INDEX runs_group_idx ON runs (run_group_id) WHERE run_group_id IS NOT NULL;
-- jsonb_path_ops is roughly half the size of the default opclass and supports the
-- @> containment queries that tag filtering actually issues.
CREATE INDEX runs_tags_idx ON runs USING gin (tags jsonb_path_ops);

-- Idempotency for CI retries: the same build re-uploading must not create a
-- second run. Shard index and attempt are part of the key so genuine shards and
-- deliberate re-runs still get their own rows.
CREATE UNIQUE INDEX runs_ci_identity_key
  ON runs (project_id, ci_provider, ci_build_id, COALESCE(shard_index, -1), attempt)
  WHERE ci_build_id IS NOT NULL;

-- ─── Artifacts (the source of truth) ─────────────────────────────────────────
-- Raw uploads are immutable and kept independently of parsed results so that an
-- improved parser can be replayed over history instead of asking teams to
-- re-upload. Every row here is re-parseable.

CREATE TABLE artifacts (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id          uuid REFERENCES runs(id) ON DELETE CASCADE,
  filename        text NOT NULL,
  storage_key     text NOT NULL UNIQUE,
  bytes           bigint,
  content_type    text,
  sha256          bytea,
  declared_format text,
  detected_format text,
  detect_confidence numeric(3, 2),
  -- Parser version that produced the current results, so we know what to replay.
  parser_version  text,
  uploaded_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX artifacts_run_idx ON artifacts (run_id);
CREATE INDEX artifacts_project_created_idx ON artifacts (project_id, created_at DESC);
CREATE INDEX artifacts_sha_idx ON artifacts (project_id, sha256);

CREATE TABLE ingest_jobs (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  artifact_id   uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  run_id        uuid REFERENCES runs(id) ON DELETE CASCADE,
  stage         text NOT NULL DEFAULT 'detect'
                CHECK (stage IN ('detect','parse','normalize','persist','merge','rollup','analyze','notify')),
  state         text NOT NULL DEFAULT 'queued'
                CHECK (state IN ('queued','running','succeeded','failed','dead')),
  attempts      integer NOT NULL DEFAULT 0,
  error_message text,
  error_stack   text,
  -- Per-stage durations: this is how we answer "why was ingest slow today".
  timings       jsonb NOT NULL DEFAULT '{}'::jsonb,
  results_written integer NOT NULL DEFAULT 0,
  started_at    timestamptz,
  finished_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ingest_jobs_state_idx ON ingest_jobs (state, created_at DESC);
CREATE INDEX ingest_jobs_artifact_idx ON ingest_jobs (artifact_id);
-- Dead-letter inspection queue for the admin UI.
CREATE INDEX ingest_jobs_dead_idx ON ingest_jobs (project_id, created_at DESC) WHERE state = 'dead';

-- ─── Test identity ───────────────────────────────────────────────────────────
-- The fingerprint is what turns uploads into history. fingerprint_version is
-- stored so the algorithm can be changed with a backfill rather than a
-- stop-the-world rebuild (see packages/core/src/fingerprint.ts).

CREATE TABLE test_cases (
  id                  bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id          uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  fingerprint         bytea NOT NULL,
  fingerprint_version smallint NOT NULL DEFAULT 1,

  -- Display values keep their original text; only the fingerprint is normalized.
  suite               text,
  classname           text,
  name                text NOT NULL,
  parameters          jsonb,

  owner_team_id       uuid REFERENCES teams(id) ON DELETE SET NULL,

  first_seen_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  last_status         text,

  -- Maintained by the rollup stage so history views never scan test_results.
  runs_30d            integer NOT NULL DEFAULT 0,
  failures_30d        integer NOT NULL DEFAULT 0,
  fail_rate_30d       numeric(5, 2) NOT NULL DEFAULT 0,
  flake_score         numeric(5, 2) NOT NULL DEFAULT 0,
  avg_duration_ms     integer,
  p95_duration_ms     integer,

  quarantined         boolean NOT NULL DEFAULT false,
  quarantined_at      timestamptz,
  quarantine_reason   text,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, fingerprint, fingerprint_version)
);
CREATE INDEX test_cases_project_flake_idx ON test_cases (project_id, flake_score DESC)
  WHERE flake_score > 0;
CREATE INDEX test_cases_project_seen_idx ON test_cases (project_id, last_seen_at DESC);
CREATE INDEX test_cases_owner_idx ON test_cases (org_id, owner_team_id);
CREATE INDEX test_cases_quarantined_idx ON test_cases (project_id) WHERE quarantined;
-- Search across test names/suites (Phase 1 full-text search).
ALTER TABLE test_cases ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('simple',
      coalesce(name, '') || ' ' || coalesce(classname, '') || ' ' || coalesce(suite, ''))
  ) STORED;
CREATE INDEX test_cases_search_idx ON test_cases USING gin (search_vector);

-- ─── Results (partitioned) ───────────────────────────────────────────────────

-- Explicit sequence rather than an identity column: identity on partitioned
-- tables has had version-specific restrictions, and a plain sequence default is
-- portable across every supported Postgres.
CREATE SEQUENCE test_results_id_seq AS bigint;

CREATE TABLE test_results (
  id                bigint NOT NULL DEFAULT nextval('test_results_id_seq'),
  org_id            uuid NOT NULL,
  project_id        uuid NOT NULL,
  run_id            uuid NOT NULL,
  test_case_id      bigint NOT NULL,

  status            text NOT NULL CHECK (status IN ('passed','failed','skipped','error','blocked')),
  duration_ms       integer,
  retry_count       smallint NOT NULL DEFAULT 0,
  -- Passed only after an earlier attempt failed: the in-run flake signal.
  was_flaky         boolean NOT NULL DEFAULT false,

  failure_type      text,
  failure_message   text,
  -- Clustering key: populated at ingest from day one so that when the clustering
  -- UI lands in Phase 3 it opens against real history instead of an empty table.
  failure_signature bytea,
  stack_trace       text,
  stdout            text,
  stderr            text,
  message           text,

  tags              jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at        timestamptz NOT NULL,

  PRIMARY KEY (id, started_at),
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
  FOREIGN KEY (test_case_id) REFERENCES test_cases(id) ON DELETE CASCADE
) PARTITION BY RANGE (started_at);

-- Loading a run page: every result for one run.
CREATE INDEX test_results_run_idx ON test_results (run_id, status);
-- Test history: one test across time.
CREATE INDEX test_results_case_time_idx ON test_results (test_case_id, started_at DESC);
-- Failure clustering and cluster detail.
CREATE INDEX test_results_signature_idx ON test_results (project_id, failure_signature, started_at DESC)
  WHERE failure_signature IS NOT NULL;
CREATE INDEX test_results_tags_idx ON test_results USING gin (tags jsonb_path_ops);

-- Safety net: a result whose timestamp falls outside every provisioned monthly
-- partition still lands rather than failing the ingest. Rows appearing here mean
-- the partition maintenance job has stopped running — it is monitored, not
-- expected to be used.
CREATE TABLE test_results_default PARTITION OF test_results DEFAULT;

CREATE TABLE attachments (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id     uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id         uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  test_case_id   bigint REFERENCES test_cases(id) ON DELETE CASCADE,
  -- Not an FK: test_results is partitioned and a composite FK here would buy
  -- little while complicating retention drops.
  test_result_id bigint,
  kind           text NOT NULL CHECK (kind IN ('screenshot','video','trace','log','har','report','diff','other')),
  name           text NOT NULL,
  storage_key    text NOT NULL,
  content_type   text,
  bytes          bigint,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachments_run_idx ON attachments (run_id);
CREATE INDEX attachments_result_idx ON attachments (test_result_id);

-- ─── Rollups ─────────────────────────────────────────────────────────────────
-- Dashboards read one row per day per branch instead of aggregating results.

CREATE TABLE project_daily_stats (
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  day             date NOT NULL,
  branch          text NOT NULL DEFAULT '',
  runs            integer NOT NULL DEFAULT 0,
  tests           integer NOT NULL DEFAULT 0,
  passed          integer NOT NULL DEFAULT 0,
  failed          integer NOT NULL DEFAULT 0,
  skipped         integer NOT NULL DEFAULT 0,
  flaky           integer NOT NULL DEFAULT 0,
  pass_rate       numeric(5, 2) NOT NULL DEFAULT 0,
  avg_duration_ms integer,
  total_duration_ms bigint NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, day, branch)
);
CREATE INDEX project_daily_stats_day_idx ON project_daily_stats (org_id, day DESC);

-- ─── API idempotency ─────────────────────────────────────────────────────────
-- CI retries uploads far more often than you would expect. An Idempotency-Key
-- plus this table means a retried POST returns the original response instead of
-- creating a duplicate run.

CREATE TABLE idempotency_keys (
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key          text NOT NULL,
  request_hash bytea NOT NULL,
  response     jsonb,
  status_code  integer,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, key)
);
CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);

-- ─── updated_at triggers ─────────────────────────────────────────────────────

CREATE TRIGGER organizations_updated_at BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER teams_updated_at BEFORE UPDATE ON teams
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER memberships_updated_at BEFORE UPDATE ON memberships
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER projects_updated_at BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER api_tokens_updated_at BEFORE UPDATE ON api_tokens
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER runs_updated_at BEFORE UPDATE ON runs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER artifacts_updated_at BEFORE UPDATE ON artifacts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER ingest_jobs_updated_at BEFORE UPDATE ON ingest_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER test_cases_updated_at BEFORE UPDATE ON test_cases
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
