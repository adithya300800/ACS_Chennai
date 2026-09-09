-- ─────────────────────────────────────────────────────────────────────────────
-- S1 — Supabase Security Advisor CRITICAL lockdown
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Trigger:
--   Security Advisor alert (2026-09-08): rls_disabled_in_public [0013, ERROR,
--   EXTERNAL] on 30 public-schema tables, plus sensitive_columns_exposed
--   [0023, ERROR, EXTERNAL] on the subset of those tables whose columns
--   match sensitive-name patterns.
--
-- Threat model (re-confirmed in Phase 0):
--   * The portal's only data path is browser → acs-portal-spa → acs-chennai
--     (Express + Prisma) → Supabase Postgres pooler URL.
--   * No @supabase/supabase-js in src/ or backend/. No direct PostgREST calls
--     from the SPA. No SUPABASE_ANON_KEY / SUPABASE_SERVICE_KEY in env.
--   * DATABASE_URL connects as the "postgres" database role (Supabase
--     pooler convention). Confirmed in the Supabase SQL editor on 2026-09-09:
--     rolbypassrls = TRUE for "postgres".
--   * Attack surface: PostgREST Data API at https://tqmmspqvqtajbijbbsii
--     .supabase.co/rest/v1/* with anon + authenticated keys. Currently any
--     holder of the anon key can SELECT / INSERT / UPDATE / DELETE every row
--     of every table on this list.
--
-- Policy design — explicit per role, default deny:
--   For each table:
--     1. ENABLE ROW LEVEL SECURITY  (PostgREST becomes gated)
--     2. CREATE POLICY <t>_deny_anon            TO anon          USING (false)
--                                                                 WITH CHECK (false)
--     3. CREATE POLICY <t>_deny_authenticated  TO authenticated USING (false)
--                                                                 WITH CHECK (false)
--   * The "postgres" role is BYPASSRLS so all Prisma traffic continues to work
--     untouched. We do NOT call FORCE ROW LEVEL SECURITY — that would defeat
--     BYPASSRLS for the table owner and break the backend.
--   * USING (false) + WITH CHECK (false) is the canonical "deny" pattern: rows
--     are invisible to SELECT and every INSERT/UPDATE/DELETE is rejected.
--   * No column-level REVOKEs in this migration. The row-level deny on all
--     four CRUD operations is sufficient because any column read still
--     passes through a policy that returns false. Column-privilege hardening
--     (esp. SELECT on employees.password / zoho_*token and refresh_token
--     .token_hash) is LPR-011 scope, separate round.
--
-- Idempotency:
--   Each block is wrapped in a DO $>...</> so re-runs of the migration do not
--   fail with "policy already exists". DROP POLICY IF EXISTS is called before
--   every CREATE POLICY, and the RLS enable is guarded by a pg_class check.
--
-- Why a new migration (not a back-patch of n5_cube_tests or any prior round):
--   Migrations are append-only. The Phase-4 P0 postmortem
--   (memory: phase-4-p0-s3-6-typo-and-baseline-hazard.md) caught
--   "prisma migrate resolve --applied" LIES that left ALTER TABLE unrun. The
--   safe pattern is a new migration that is independently auditable.
--
-- Rollback (NOT bundled in this file, see scripts/rls_lockdown_s1_rollback.sql):
--   DROP POLICY per table + ALTER TABLE ... DISABLE ROW LEVEL SECURITY. The
--   user-facing portal keeps running unaffected either way (BYPASSRLS), but
--   the PostgREST exposure re-opens immediately — run rollback only as a
--   stopgap, then re-apply.
--
-- Lint IDs to re-check after apply:
--   * 0013 rls_disabled_in_public  — should clear once ENABLE is applied
--   * 0023 sensitive_columns_exposed — should also clear (per Supabase docs
--     0023 checks the same rls_disabled_in_public condition plus column-name
--     match; both lints gate on RLS being enabled)
--
-- Out of scope, separate follow-ups:
--   * 0014 extension_in_public for btree_gist — separate migration.
--   * LPR-011 column-level hardening for password / zoho_*token / token_hash.
--   * The Supabase MCP reload (config already in ~/.claude/.mcp.json; user to
--     restart Claude Code so mcp__supabase__* tools load — saves future key
--     hand-offs).
--

BEGIN;

-- ── attendance_sessions ────────────────────────────────────────────────────────
DO $$
BEGIN
  -- Enable RLS only if not already on (re-runs of this migration must not error).
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'attendance_sessions' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', 'attendance_sessions');
  END IF;

  -- Drop any prior copies of the deny policies so re-runs are safe.
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'attendance_sessions_deny_anon', 'attendance_sessions');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'attendance_sessions_deny_authenticated', 'attendance_sessions');

  -- Create the deny policies. USING (false) + WITH CHECK (false) is the
  -- canonical default-deny for both SELECT visibility and INSERT/UPDATE/DELETE.
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO anon
      USING (false) WITH CHECK (false)',
    'attendance_sessions_deny_anon', 'attendance_sessions');
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO authenticated
      USING (false) WITH CHECK (false)',
    'attendance_sessions_deny_authenticated', 'attendance_sessions');
END
$$;

-- ── dpr_photo ────────────────────────────────────────────────────────
DO $$
BEGIN
  -- Enable RLS only if not already on (re-runs of this migration must not error).
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'dpr_photo' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', 'dpr_photo');
  END IF;

  -- Drop any prior copies of the deny policies so re-runs are safe.
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'dpr_photo_deny_anon', 'dpr_photo');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'dpr_photo_deny_authenticated', 'dpr_photo');

  -- Create the deny policies. USING (false) + WITH CHECK (false) is the
  -- canonical default-deny for both SELECT visibility and INSERT/UPDATE/DELETE.
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO anon
      USING (false) WITH CHECK (false)',
    'dpr_photo_deny_anon', 'dpr_photo');
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO authenticated
      USING (false) WITH CHECK (false)',
    'dpr_photo_deny_authenticated', 'dpr_photo');
END
$$;

-- ── dpr_revision ────────────────────────────────────────────────────────
DO $$
BEGIN
  -- Enable RLS only if not already on (re-runs of this migration must not error).
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'dpr_revision' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', 'dpr_revision');
  END IF;

  -- Drop any prior copies of the deny policies so re-runs are safe.
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'dpr_revision_deny_anon', 'dpr_revision');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'dpr_revision_deny_authenticated', 'dpr_revision');

  -- Create the deny policies. USING (false) + WITH CHECK (false) is the
  -- canonical default-deny for both SELECT visibility and INSERT/UPDATE/DELETE.
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO anon
      USING (false) WITH CHECK (false)',
    'dpr_revision_deny_anon', 'dpr_revision');
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO authenticated
      USING (false) WITH CHECK (false)',
    'dpr_revision_deny_authenticated', 'dpr_revision');
END
$$;

-- ── notification ────────────────────────────────────────────────────────
DO $$
BEGIN
  -- Enable RLS only if not already on (re-runs of this migration must not error).
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'notification' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', 'notification');
  END IF;

  -- Drop any prior copies of the deny policies so re-runs are safe.
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'notification_deny_anon', 'notification');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'notification_deny_authenticated', 'notification');

  -- Create the deny policies. USING (false) + WITH CHECK (false) is the
  -- canonical default-deny for both SELECT visibility and INSERT/UPDATE/DELETE.
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO anon
      USING (false) WITH CHECK (false)',
    'notification_deny_anon', 'notification');
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO authenticated
      USING (false) WITH CHECK (false)',
    'notification_deny_authenticated', 'notification');
END
$$;

-- ── employees ────────────────────────────────────────────────────────
DO $$
BEGIN
  -- Enable RLS only if not already on (re-runs of this migration must not error).
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'employees' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', 'employees');
  END IF;

  -- Drop any prior copies of the deny policies so re-runs are safe.
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'employees_deny_anon', 'employees');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'employees_deny_authenticated', 'employees');

  -- Create the deny policies. USING (false) + WITH CHECK (false) is the
  -- canonical default-deny for both SELECT visibility and INSERT/UPDATE/DELETE.
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO anon
      USING (false) WITH CHECK (false)',
    'employees_deny_anon', 'employees');
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO authenticated
      USING (false) WITH CHECK (false)',
    'employees_deny_authenticated', 'employees');
END
$$;

-- ── attendance ────────────────────────────────────────────────────────
DO $$
BEGIN
  -- Enable RLS only if not already on (re-runs of this migration must not error).
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'attendance' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', 'attendance');
  END IF;

  -- Drop any prior copies of the deny policies so re-runs are safe.
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'attendance_deny_anon', 'attendance');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'attendance_deny_authenticated', 'attendance');

  -- Create the deny policies. USING (false) + WITH CHECK (false) is the
  -- canonical default-deny for both SELECT visibility and INSERT/UPDATE/DELETE.
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO anon
      USING (false) WITH CHECK (false)',
    'attendance_deny_anon', 'attendance');
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO authenticated
      USING (false) WITH CHECK (false)',
    'attendance_deny_authenticated', 'attendance');
END
$$;

-- ── inspection_photo ────────────────────────────────────────────────────────
DO $$
BEGIN
  -- Enable RLS only if not already on (re-runs of this migration must not error).
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'inspection_photo' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', 'inspection_photo');
  END IF;

  -- Drop any prior copies of the deny policies so re-runs are safe.
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'inspection_photo_deny_anon', 'inspection_photo');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'inspection_photo_deny_authenticated', 'inspection_photo');

  -- Create the deny policies. USING (false) + WITH CHECK (false) is the
  -- canonical default-deny for both SELECT visibility and INSERT/UPDATE/DELETE.
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO anon
      USING (false) WITH CHECK (false)',
    'inspection_photo_deny_anon', 'inspection_photo');
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO authenticated
      USING (false) WITH CHECK (false)',
    'inspection_photo_deny_authenticated', 'inspection_photo');
END
$$;

-- ── leave_request ────────────────────────────────────────────────────────
DO $$
BEGIN
  -- Enable RLS only if not already on (re-runs of this migration must not error).
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'leave_request' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', 'leave_request');
  END IF;

  -- Drop any prior copies of the deny policies so re-runs are safe.
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'leave_request_deny_anon', 'leave_request');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'leave_request_deny_authenticated', 'leave_request');

  -- Create the deny policies. USING (false) + WITH CHECK (false) is the
  -- canonical default-deny for both SELECT visibility and INSERT/UPDATE/DELETE.
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO anon
      USING (false) WITH CHECK (false)',
    'leave_request_deny_anon', 'leave_request');
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO authenticated
      USING (false) WITH CHECK (false)',
    'leave_request_deny_authenticated', 'leave_request');
END
$$;

-- ── training_course ────────────────────────────────────────────────────────
DO $$
BEGIN
  -- Enable RLS only if not already on (re-runs of this migration must not error).
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'training_course' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', 'training_course');
  END IF;

  -- Drop any prior copies of the deny policies so re-runs are safe.
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'training_course_deny_anon', 'training_course');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'training_course_deny_authenticated', 'training_course');

  -- Create the deny policies. USING (false) + WITH CHECK (false) is the
  -- canonical default-deny for both SELECT visibility and INSERT/UPDATE/DELETE.
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO anon
      USING (false) WITH CHECK (false)',
    'training_course_deny_anon', 'training_course');
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO authenticated
      USING (false) WITH CHECK (false)',
    'training_course_deny_authenticated', 'training_course');
END
$$;

-- ── email_log ────────────────────────────────────────────────────────
DO $$
BEGIN
  -- Enable RLS only if not already on (re-runs of this migration must not error).
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'email_log' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', 'email_log');
  END IF;

  -- Drop any prior copies of the deny policies so re-runs are safe.
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'email_log_deny_anon', 'email_log');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'email_log_deny_authenticated', 'email_log');

  -- Create the deny policies. USING (false) + WITH CHECK (false) is the
  -- canonical default-deny for both SELECT visibility and INSERT/UPDATE/DELETE.
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO anon
      USING (false) WITH CHECK (false)',
    'email_log_deny_anon', 'email_log');
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO authenticated
      USING (false) WITH CHECK (false)',
    'email_log_deny_authenticated', 'email_log');
END
$$;

-- ── revoked_token ────────────────────────────────────────────────────────
DO $$
BEGIN
  -- Enable RLS only if not already on (re-runs of this migration must not error).
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'revoked_token' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', 'revoked_token');
  END IF;

  -- Drop any prior copies of the deny policies so re-runs are safe.
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'revoked_token_deny_anon', 'revoked_token');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'revoked_token_deny_authenticated', 'revoked_token');

  -- Create the deny policies. USING (false) + WITH CHECK (false) is the
  -- canonical default-deny for both SELECT visibility and INSERT/UPDATE/DELETE.
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO anon
      USING (false) WITH CHECK (false)',
    'revoked_token_deny_anon', 'revoked_token');
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO authenticated
      USING (false) WITH CHECK (false)',
    'revoked_token_deny_authenticated', 'revoked_token');
END
$$;

-- ── refresh_token ────────────────────────────────────────────────────────
DO $$
BEGIN
  -- Enable RLS only if not already on (re-runs of this migration must not error).
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'refresh_token' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', 'refresh_token');
  END IF;

  -- Drop any prior copies of the deny policies so re-runs are safe.
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'refresh_token_deny_anon', 'refresh_token');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'refresh_token_deny_authenticated', 'refresh_token');

  -- Create the deny policies. USING (false) + WITH CHECK (false) is the
  -- canonical default-deny for both SELECT visibility and INSERT/UPDATE/DELETE.
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO anon
      USING (false) WITH CHECK (false)',
    'refresh_token_deny_anon', 'refresh_token');
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO authenticated
      USING (false) WITH CHECK (false)',
    'refresh_token_deny_authenticated', 'refresh_token');
END
$$;

-- ── digest_run ────────────────────────────────────────────────────────
DO $$
BEGIN
  -- Enable RLS only if not already on (re-runs of this migration must not error).
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'digest_run' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', 'digest_run');
  END IF;

  -- Drop any prior copies of the deny policies so re-runs are safe.
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'digest_run_deny_anon', 'digest_run');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'digest_run_deny_authenticated', 'digest_run');

  -- Create the deny policies. USING (false) + WITH CHECK (false) is the
  -- canonical default-deny for both SELECT visibility and INSERT/UPDATE/DELETE.
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO anon
      USING (false) WITH CHECK (false)',
    'digest_run_deny_anon', 'digest_run');
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO authenticated
      USING (false) WITH CHECK (false)',
    'digest_run_deny_authenticated', 'digest_run');
END
$$;

-- ── training_enrollment ────────────────────────────────────────────────────────
DO $$
BEGIN
  -- Enable RLS only if not already on (re-runs of this migration must not error).
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'training_enrollment' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', 'training_enrollment');
  END IF;

  -- Drop any prior copies of the deny policies so re-runs are safe.
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'training_enrollment_deny_anon', 'training_enrollment');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'training_enrollment_deny_authenticated', 'training_enrollment');

  -- Create the deny policies. USING (false) + WITH CHECK (false) is the
  -- canonical default-deny for both SELECT visibility and INSERT/UPDATE/DELETE.
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO anon
      USING (false) WITH CHECK (false)',
    'training_enrollment_deny_anon', 'training_enrollment');
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO authenticated
      USING (false) WITH CHECK (false)',
    'training_enrollment_deny_authenticated', 'training_enrollment');
END
$$;

-- ── notification_preference ────────────────────────────────────────────────────────
DO $$
BEGIN
  -- Enable RLS only if not already on (re-runs of this migration must not error).
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'notification_preference' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', 'notification_preference');
  END IF;

  -- Drop any prior copies of the deny policies so re-runs are safe.
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'notification_preference_deny_anon', 'notification_preference');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'notification_preference_deny_authenticated', 'notification_preference');

  -- Create the deny policies. USING (false) + WITH CHECK (false) is the
  -- canonical default-deny for both SELECT visibility and INSERT/UPDATE/DELETE.
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO anon
      USING (false) WITH CHECK (false)',
    'notification_preference_deny_anon', 'notification_preference');
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO authenticated
      USING (false) WITH CHECK (false)',
    'notification_preference_deny_authenticated', 'notification_preference');
END
$$;

-- ── digest_item ────────────────────────────────────────────────────────
DO $$
BEGIN
  -- Enable RLS only if not already on (re-runs of this migration must not error).
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'digest_item' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', 'digest_item');
  END IF;

  -- Drop any prior copies of the deny policies so re-runs are safe.
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'digest_item_deny_anon', 'digest_item');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'digest_item_deny_authenticated', 'digest_item');

  -- Create the deny policies. USING (false) + WITH CHECK (false) is the
  -- canonical default-deny for both SELECT visibility and INSERT/UPDATE/DELETE.
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO anon
      USING (false) WITH CHECK (false)',
    'digest_item_deny_anon', 'digest_item');
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO authenticated
      USING (false) WITH CHECK (false)',
    'digest_item_deny_authenticated', 'digest_item');
END
$$;

-- ── _prisma_migrations ────────────────────────────────────────────────────────
DO $$
BEGIN
  -- Enable RLS only if not already on (re-runs of this migration must not error).
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = '_prisma_migrations' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', '_prisma_migrations');
  END IF;

  -- Drop any prior copies of the deny policies so re-runs are safe.
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', '_prisma_migrations_deny_anon', '_prisma_migrations');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', '_prisma_migrations_deny_authenticated', '_prisma_migrations');

  -- Create the deny policies. USING (false) + WITH CHECK (false) is the
  -- canonical default-deny for both SELECT visibility and INSERT/UPDATE/DELETE.
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO anon
      USING (false) WITH CHECK (false)',
    '_prisma_migrations_deny_anon', '_prisma_migrations');
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO authenticated
      USING (false) WITH CHECK (false)',
    '_prisma_migrations_deny_authenticated', '_prisma_migrations');
END
$$;

-- ── admin_digest_run ────────────────────────────────────────────────────────
DO $$
BEGIN
  -- Enable RLS only if not already on (re-runs of this migration must not error).
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'admin_digest_run' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', 'admin_digest_run');
  END IF;

  -- Drop any prior copies of the deny policies so re-runs are safe.
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'admin_digest_run_deny_anon', 'admin_digest_run');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'admin_digest_run_deny_authenticated', 'admin_digest_run');

  -- Create the deny policies. USING (false) + WITH CHECK (false) is the
  -- canonical default-deny for both SELECT visibility and INSERT/UPDATE/DELETE.
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO anon
      USING (false) WITH CHECK (false)',
    'admin_digest_run_deny_anon', 'admin_digest_run');
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO authenticated
      USING (false) WITH CHECK (false)',
    'admin_digest_run_deny_authenticated', 'admin_digest_run');
END
$$;

-- ── upload_intent ────────────────────────────────────────────────────────
DO $$
BEGIN
  -- Enable RLS only if not already on (re-runs of this migration must not error).
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'upload_intent' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', 'upload_intent');
  END IF;

  -- Drop any prior copies of the deny policies so re-runs are safe.
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'upload_intent_deny_anon', 'upload_intent');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'upload_intent_deny_authenticated', 'upload_intent');

  -- Create the deny policies. USING (false) + WITH CHECK (false) is the
  -- canonical default-deny for both SELECT visibility and INSERT/UPDATE/DELETE.
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO anon
      USING (false) WITH CHECK (false)',
    'upload_intent_deny_anon', 'upload_intent');
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO authenticated
      USING (false) WITH CHECK (false)',
    'upload_intent_deny_authenticated', 'upload_intent');
END
$$;

-- ── boq_item ────────────────────────────────────────────────────────
DO $$
BEGIN
  -- Enable RLS only if not already on (re-runs of this migration must not error).
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'boq_item' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', 'boq_item');
  END IF;

  -- Drop any prior copies of the deny policies so re-runs are safe.
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'boq_item_deny_anon', 'boq_item');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'boq_item_deny_authenticated', 'boq_item');

  -- Create the deny policies. USING (false) + WITH CHECK (false) is the
  -- canonical default-deny for both SELECT visibility and INSERT/UPDATE/DELETE.
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO anon
      USING (false) WITH CHECK (false)',
    'boq_item_deny_anon', 'boq_item');
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO authenticated
      USING (false) WITH CHECK (false)',
    'boq_item_deny_authenticated', 'boq_item');
END
$$;

-- ── drawing ────────────────────────────────────────────────────────
DO $$
BEGIN
  -- Enable RLS only if not already on (re-runs of this migration must not error).
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'drawing' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', 'drawing');
  END IF;

  -- Drop any prior copies of the deny policies so re-runs are safe.
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'drawing_deny_anon', 'drawing');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'drawing_deny_authenticated', 'drawing');

  -- Create the deny policies. USING (false) + WITH CHECK (false) is the
  -- canonical default-deny for both SELECT visibility and INSERT/UPDATE/DELETE.
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO anon
      USING (false) WITH CHECK (false)',
    'drawing_deny_anon', 'drawing');
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO authenticated
      USING (false) WITH CHECK (false)',
    'drawing_deny_authenticated', 'drawing');
END
$$;

-- ── project ────────────────────────────────────────────────────────
DO $$
BEGIN
  -- Enable RLS only if not already on (re-runs of this migration must not error).
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'project' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', 'project');
  END IF;

  -- Drop any prior copies of the deny policies so re-runs are safe.
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'project_deny_anon', 'project');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'project_deny_authenticated', 'project');

  -- Create the deny policies. USING (false) + WITH CHECK (false) is the
  -- canonical default-deny for both SELECT visibility and INSERT/UPDATE/DELETE.
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO anon
      USING (false) WITH CHECK (false)',
    'project_deny_anon', 'project');
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO authenticated
      USING (false) WITH CHECK (false)',
    'project_deny_authenticated', 'project');
END
$$;

-- ── dpr ────────────────────────────────────────────────────────
DO $$
BEGIN
  -- Enable RLS only if not already on (re-runs of this migration must not error).
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'dpr' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', 'dpr');
  END IF;

  -- Drop any prior copies of the deny policies so re-runs are safe.
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'dpr_deny_anon', 'dpr');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'dpr_deny_authenticated', 'dpr');

  -- Create the deny policies. USING (false) + WITH CHECK (false) is the
  -- canonical default-deny for both SELECT visibility and INSERT/UPDATE/DELETE.
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO anon
      USING (false) WITH CHECK (false)',
    'dpr_deny_anon', 'dpr');
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO authenticated
      USING (false) WITH CHECK (false)',
    'dpr_deny_authenticated', 'dpr');
END
$$;

-- ── inspection_record ────────────────────────────────────────────────────────
DO $$
BEGIN
  -- Enable RLS only if not already on (re-runs of this migration must not error).
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'inspection_record' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', 'inspection_record');
  END IF;

  -- Drop any prior copies of the deny policies so re-runs are safe.
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'inspection_record_deny_anon', 'inspection_record');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'inspection_record_deny_authenticated', 'inspection_record');

  -- Create the deny policies. USING (false) + WITH CHECK (false) is the
  -- canonical default-deny for both SELECT visibility and INSERT/UPDATE/DELETE.
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO anon
      USING (false) WITH CHECK (false)',
    'inspection_record_deny_anon', 'inspection_record');
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO authenticated
      USING (false) WITH CHECK (false)',
    'inspection_record_deny_authenticated', 'inspection_record');
END
$$;

-- ── project_assignment ────────────────────────────────────────────────────────
DO $$
BEGIN
  -- Enable RLS only if not already on (re-runs of this migration must not error).
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'project_assignment' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', 'project_assignment');
  END IF;

  -- Drop any prior copies of the deny policies so re-runs are safe.
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'project_assignment_deny_anon', 'project_assignment');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'project_assignment_deny_authenticated', 'project_assignment');

  -- Create the deny policies. USING (false) + WITH CHECK (false) is the
  -- canonical default-deny for both SELECT visibility and INSERT/UPDATE/DELETE.
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO anon
      USING (false) WITH CHECK (false)',
    'project_assignment_deny_anon', 'project_assignment');
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO authenticated
      USING (false) WITH CHECK (false)',
    'project_assignment_deny_authenticated', 'project_assignment');
END
$$;

-- ── boq_execution ────────────────────────────────────────────────────────
DO $$
BEGIN
  -- Enable RLS only if not already on (re-runs of this migration must not error).
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'boq_execution' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', 'boq_execution');
  END IF;

  -- Drop any prior copies of the deny policies so re-runs are safe.
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'boq_execution_deny_anon', 'boq_execution');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'boq_execution_deny_authenticated', 'boq_execution');

  -- Create the deny policies. USING (false) + WITH CHECK (false) is the
  -- canonical default-deny for both SELECT visibility and INSERT/UPDATE/DELETE.
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO anon
      USING (false) WITH CHECK (false)',
    'boq_execution_deny_anon', 'boq_execution');
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO authenticated
      USING (false) WITH CHECK (false)',
    'boq_execution_deny_authenticated', 'boq_execution');
END
$$;

-- ── project_attachment ────────────────────────────────────────────────────────
DO $$
BEGIN
  -- Enable RLS only if not already on (re-runs of this migration must not error).
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'project_attachment' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', 'project_attachment');
  END IF;

  -- Drop any prior copies of the deny policies so re-runs are safe.
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'project_attachment_deny_anon', 'project_attachment');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'project_attachment_deny_authenticated', 'project_attachment');

  -- Create the deny policies. USING (false) + WITH CHECK (false) is the
  -- canonical default-deny for both SELECT visibility and INSERT/UPDATE/DELETE.
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO anon
      USING (false) WITH CHECK (false)',
    'project_attachment_deny_anon', 'project_attachment');
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO authenticated
      USING (false) WITH CHECK (false)',
    'project_attachment_deny_authenticated', 'project_attachment');
END
$$;

-- ── billing_certification ────────────────────────────────────────────────────────
DO $$
BEGIN
  -- Enable RLS only if not already on (re-runs of this migration must not error).
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'billing_certification' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', 'billing_certification');
  END IF;

  -- Drop any prior copies of the deny policies so re-runs are safe.
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'billing_certification_deny_anon', 'billing_certification');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'billing_certification_deny_authenticated', 'billing_certification');

  -- Create the deny policies. USING (false) + WITH CHECK (false) is the
  -- canonical default-deny for both SELECT visibility and INSERT/UPDATE/DELETE.
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO anon
      USING (false) WITH CHECK (false)',
    'billing_certification_deny_anon', 'billing_certification');
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO authenticated
      USING (false) WITH CHECK (false)',
    'billing_certification_deny_authenticated', 'billing_certification');
END
$$;

-- ── variation_order ────────────────────────────────────────────────────────
DO $$
BEGIN
  -- Enable RLS only if not already on (re-runs of this migration must not error).
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'variation_order' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', 'variation_order');
  END IF;

  -- Drop any prior copies of the deny policies so re-runs are safe.
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'variation_order_deny_anon', 'variation_order');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'variation_order_deny_authenticated', 'variation_order');

  -- Create the deny policies. USING (false) + WITH CHECK (false) is the
  -- canonical default-deny for both SELECT visibility and INSERT/UPDATE/DELETE.
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO anon
      USING (false) WITH CHECK (false)',
    'variation_order_deny_anon', 'variation_order');
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO authenticated
      USING (false) WITH CHECK (false)',
    'variation_order_deny_authenticated', 'variation_order');
END
$$;

-- ── request_dedupe ────────────────────────────────────────────────────────
DO $$
BEGIN
  -- Enable RLS only if not already on (re-runs of this migration must not error).
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'request_dedupe' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', 'request_dedupe');
  END IF;

  -- Drop any prior copies of the deny policies so re-runs are safe.
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'request_dedupe_deny_anon', 'request_dedupe');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'request_dedupe_deny_authenticated', 'request_dedupe');

  -- Create the deny policies. USING (false) + WITH CHECK (false) is the
  -- canonical default-deny for both SELECT visibility and INSERT/UPDATE/DELETE.
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO anon
      USING (false) WITH CHECK (false)',
    'request_dedupe_deny_anon', 'request_dedupe');
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO authenticated
      USING (false) WITH CHECK (false)',
    'request_dedupe_deny_authenticated', 'request_dedupe');
END
$$;

COMMIT;
