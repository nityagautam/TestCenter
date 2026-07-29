-- ─────────────────────────────────────────────────────────────────────────────
-- 0004_multi_tenancy — real multi-tenancy, roles and self-serve organisations
--
-- Phase 0 shipped `org_id` on every tenant-scoped table but deferred enforcement
-- ("internal now, SaaS-ready later"). This migration calls that flip: access is
-- now decided by membership, users create their own organisations, and platform
-- admins can grant access to existing ones.
--
-- The data model needed no reshaping — only the access layer around it — which is
-- exactly the payoff for having carried org_id from the first migration.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── Users become first-class accounts ───────────────────────────────────────

-- Platform administrators can see and grant access to every organisation. Seeded
-- from TESTCENTER_ADMIN_EMAILS at first login rather than a self-service toggle,
-- so privilege cannot be granted from inside the app by its own users.
ALTER TABLE users ADD COLUMN is_platform_admin boolean NOT NULL DEFAULT false;

-- Onboarding state: a user who declines to create an organisation is legitimately
-- in the product with no access yet, and must be told so rather than shown an
-- empty dashboard that looks broken.
ALTER TABLE users ADD COLUMN onboarded_at timestamptz;

-- Set on the organisation auto-created for a user, so we can distinguish "my
-- personal space" from a shared team organisation in the UI.
ALTER TABLE organizations ADD COLUMN personal_for_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE organizations ADD COLUMN created_by uuid REFERENCES users(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX organizations_personal_key ON organizations (personal_for_user_id)
  WHERE personal_for_user_id IS NOT NULL;

-- ─── Membership grants, including ones that predate the user ─────────────────
--
-- An administrator grants access by email. A user row only exists after first
-- login, so a grant for someone who has never signed in has nothing to reference.
-- Storing the email lets the grant be created now and bound to the account on
-- first login — the ergonomics of an invite without needing to send mail.

ALTER TABLE memberships ADD COLUMN invited_email text;
ALTER TABLE memberships ADD COLUMN granted_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE memberships ADD COLUMN activated_at timestamptz;

-- user_id becomes optional: a pending grant has an email but no account yet.
ALTER TABLE memberships ALTER COLUMN user_id DROP NOT NULL;

-- Exactly one of user_id / invited_email must identify the grantee.
ALTER TABLE memberships ADD CONSTRAINT memberships_subject_check
  CHECK (num_nonnulls(user_id, invited_email) = 1);

-- Prevent duplicate pending grants for the same address in one org.
CREATE UNIQUE INDEX memberships_org_email_key
  ON memberships (org_id, lower(invited_email))
  WHERE invited_email IS NOT NULL;

CREATE INDEX memberships_pending_idx ON memberships (lower(invited_email))
  WHERE invited_email IS NOT NULL;

-- ─── Projects gain provenance ────────────────────────────────────────────────

ALTER TABLE projects ADD COLUMN created_by uuid REFERENCES users(id) ON DELETE SET NULL;

-- ─── Per-organisation guardrails ─────────────────────────────────────────────
--
-- Once users self-serve projects and uploads, one enthusiastic team can fill the
-- disk. A cheap ceiling now avoids a painful conversation later.

ALTER TABLE organizations ADD COLUMN max_projects integer NOT NULL DEFAULT 50;
ALTER TABLE organizations ADD COLUMN max_runs_per_day integer NOT NULL DEFAULT 5000;

-- ─── Test-case history support ───────────────────────────────────────────────
--
-- The test detail view answers "this failed 3 of its last 5 runs — show me each
-- failure". That is a lookup of one test's results ordered by time, filtered to
-- failures. The existing (test_case_id, started_at DESC) index serves the
-- ordering; this partial index keeps the failures-only variant cheap as history
-- accumulates.

CREATE INDEX test_results_case_failures_idx
  ON test_results (test_case_id, started_at DESC)
  WHERE status IN ('failed', 'error');

-- Distinct-failure-mode grouping for a single test.
CREATE INDEX test_results_case_signature_idx
  ON test_results (test_case_id, failure_signature)
  WHERE failure_signature IS NOT NULL;

-- Trigram index so test search can match mid-token ("payment" inside
-- "test_declines_expired_payment_card"), which full-text alone will not do.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX test_cases_name_trgm_idx ON test_cases USING gin (name gin_trgm_ops);

-- ─── Backfill ────────────────────────────────────────────────────────────────
--
-- Existing rows predate membership. Attach every current organisation to the
-- users who already exist so the app does not lock its own operators out after
-- this migration; new organisations get explicit memberships from the start.

INSERT INTO memberships (org_id, user_id, role, activated_at)
SELECT o.id, u.id, 'owner', now()
FROM organizations o
CROSS JOIN users u
WHERE NOT EXISTS (
  SELECT 1 FROM memberships m
  WHERE m.org_id = o.id AND m.user_id = u.id AND m.team_id IS NULL
)
ON CONFLICT DO NOTHING;

-- Memberships that existed before this migration are already active.
UPDATE memberships SET activated_at = created_at WHERE activated_at IS NULL AND user_id IS NOT NULL;
