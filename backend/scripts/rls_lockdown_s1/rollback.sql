-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK — S1 Supabase Security Advisor lockdown
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Purpose:
--   Reverse the rls_lockdown_s1 migration (20260910000000_rls_lockdown_s1)
--   by dropping the two deny policies per table and disabling RLS. Use this
--   ONLY as a stopgap if the lockdown migration unexpectedly breaks the
--   portal — running this re-opens the PostgREST exposure. The intended
--   remediation path is: investigate the break, fix the migration, re-apply.
--
-- Run from:
--   psql "$DIRECT_DATABASE_URL" -f scripts/rls_lockdown_s1_rollback.sql
--   (or paste into the Supabase SQL editor as the postgres role)
--
-- Idempotency:
--   DROP POLICY IF EXISTS + a pg_class.relrowsecurity guard on the DISABLE
--   step. Safe to run multiple times.
--
-- Companion file: scripts/rls_lockdown_s1_post_deploy_checks.sql runs after
-- the lockdown migration to verify policies are live and PostgREST is gated.
--

BEGIN;

-- ── attendance_sessions ────────────────────────────────────────────────────────
DO $$
BEGIN
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'attendance_sessions_deny_anon', 'attendance_sessions');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'attendance_sessions_deny_authenticated', 'attendance_sessions');
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'attendance_sessions' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', 'attendance_sessions');
  END IF;
END
$$;

-- ── dpr_photo ────────────────────────────────────────────────────────
DO $$
BEGIN
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'dpr_photo_deny_anon', 'dpr_photo');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'dpr_photo_deny_authenticated', 'dpr_photo');
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'dpr_photo' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', 'dpr_photo');
  END IF;
END
$$;

-- ── dpr_revision ────────────────────────────────────────────────────────
DO $$
BEGIN
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'dpr_revision_deny_anon', 'dpr_revision');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'dpr_revision_deny_authenticated', 'dpr_revision');
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'dpr_revision' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', 'dpr_revision');
  END IF;
END
$$;

-- ── notification ────────────────────────────────────────────────────────
DO $$
BEGIN
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'notification_deny_anon', 'notification');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'notification_deny_authenticated', 'notification');
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'notification' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', 'notification');
  END IF;
END
$$;

-- ── employees ────────────────────────────────────────────────────────
DO $$
BEGIN
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'employees_deny_anon', 'employees');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'employees_deny_authenticated', 'employees');
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'employees' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', 'employees');
  END IF;
END
$$;

-- ── attendance ────────────────────────────────────────────────────────
DO $$
BEGIN
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'attendance_deny_anon', 'attendance');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'attendance_deny_authenticated', 'attendance');
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'attendance' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', 'attendance');
  END IF;
END
$$;

-- ── inspection_photo ────────────────────────────────────────────────────────
DO $$
BEGIN
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'inspection_photo_deny_anon', 'inspection_photo');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'inspection_photo_deny_authenticated', 'inspection_photo');
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'inspection_photo' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', 'inspection_photo');
  END IF;
END
$$;

-- ── leave_request ────────────────────────────────────────────────────────
DO $$
BEGIN
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'leave_request_deny_anon', 'leave_request');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'leave_request_deny_authenticated', 'leave_request');
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'leave_request' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', 'leave_request');
  END IF;
END
$$;

-- ── training_course ────────────────────────────────────────────────────────
DO $$
BEGIN
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'training_course_deny_anon', 'training_course');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'training_course_deny_authenticated', 'training_course');
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'training_course' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', 'training_course');
  END IF;
END
$$;

-- ── email_log ────────────────────────────────────────────────────────
DO $$
BEGIN
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'email_log_deny_anon', 'email_log');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'email_log_deny_authenticated', 'email_log');
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'email_log' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', 'email_log');
  END IF;
END
$$;

-- ── revoked_token ────────────────────────────────────────────────────────
DO $$
BEGIN
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'revoked_token_deny_anon', 'revoked_token');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'revoked_token_deny_authenticated', 'revoked_token');
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'revoked_token' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', 'revoked_token');
  END IF;
END
$$;

-- ── refresh_token ────────────────────────────────────────────────────────
DO $$
BEGIN
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'refresh_token_deny_anon', 'refresh_token');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'refresh_token_deny_authenticated', 'refresh_token');
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'refresh_token' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', 'refresh_token');
  END IF;
END
$$;

-- ── digest_run ────────────────────────────────────────────────────────
DO $$
BEGIN
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'digest_run_deny_anon', 'digest_run');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'digest_run_deny_authenticated', 'digest_run');
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'digest_run' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', 'digest_run');
  END IF;
END
$$;

-- ── training_enrollment ────────────────────────────────────────────────────────
DO $$
BEGIN
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'training_enrollment_deny_anon', 'training_enrollment');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'training_enrollment_deny_authenticated', 'training_enrollment');
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'training_enrollment' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', 'training_enrollment');
  END IF;
END
$$;

-- ── notification_preference ────────────────────────────────────────────────────────
DO $$
BEGIN
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'notification_preference_deny_anon', 'notification_preference');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'notification_preference_deny_authenticated', 'notification_preference');
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'notification_preference' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', 'notification_preference');
  END IF;
END
$$;

-- ── digest_item ────────────────────────────────────────────────────────
DO $$
BEGIN
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'digest_item_deny_anon', 'digest_item');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'digest_item_deny_authenticated', 'digest_item');
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'digest_item' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', 'digest_item');
  END IF;
END
$$;

-- ── _prisma_migrations ────────────────────────────────────────────────────────
DO $$
BEGIN
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', '_prisma_migrations_deny_anon', '_prisma_migrations');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', '_prisma_migrations_deny_authenticated', '_prisma_migrations');
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = '_prisma_migrations' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', '_prisma_migrations');
  END IF;
END
$$;

-- ── admin_digest_run ────────────────────────────────────────────────────────
DO $$
BEGIN
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'admin_digest_run_deny_anon', 'admin_digest_run');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'admin_digest_run_deny_authenticated', 'admin_digest_run');
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'admin_digest_run' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', 'admin_digest_run');
  END IF;
END
$$;

-- ── upload_intent ────────────────────────────────────────────────────────
DO $$
BEGIN
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'upload_intent_deny_anon', 'upload_intent');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'upload_intent_deny_authenticated', 'upload_intent');
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'upload_intent' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', 'upload_intent');
  END IF;
END
$$;

-- ── boq_item ────────────────────────────────────────────────────────
DO $$
BEGIN
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'boq_item_deny_anon', 'boq_item');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'boq_item_deny_authenticated', 'boq_item');
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'boq_item' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', 'boq_item');
  END IF;
END
$$;

-- ── drawing ────────────────────────────────────────────────────────
DO $$
BEGIN
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'drawing_deny_anon', 'drawing');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'drawing_deny_authenticated', 'drawing');
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'drawing' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', 'drawing');
  END IF;
END
$$;

-- ── project ────────────────────────────────────────────────────────
DO $$
BEGIN
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'project_deny_anon', 'project');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'project_deny_authenticated', 'project');
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'project' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', 'project');
  END IF;
END
$$;

-- ── dpr ────────────────────────────────────────────────────────
DO $$
BEGIN
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'dpr_deny_anon', 'dpr');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'dpr_deny_authenticated', 'dpr');
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'dpr' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', 'dpr');
  END IF;
END
$$;

-- ── inspection_record ────────────────────────────────────────────────────────
DO $$
BEGIN
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'inspection_record_deny_anon', 'inspection_record');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'inspection_record_deny_authenticated', 'inspection_record');
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'inspection_record' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', 'inspection_record');
  END IF;
END
$$;

-- ── project_assignment ────────────────────────────────────────────────────────
DO $$
BEGIN
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'project_assignment_deny_anon', 'project_assignment');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'project_assignment_deny_authenticated', 'project_assignment');
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'project_assignment' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', 'project_assignment');
  END IF;
END
$$;

-- ── boq_execution ────────────────────────────────────────────────────────
DO $$
BEGIN
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'boq_execution_deny_anon', 'boq_execution');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'boq_execution_deny_authenticated', 'boq_execution');
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'boq_execution' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', 'boq_execution');
  END IF;
END
$$;

-- ── project_attachment ────────────────────────────────────────────────────────
DO $$
BEGIN
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'project_attachment_deny_anon', 'project_attachment');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'project_attachment_deny_authenticated', 'project_attachment');
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'project_attachment' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', 'project_attachment');
  END IF;
END
$$;

-- ── billing_certification ────────────────────────────────────────────────────────
DO $$
BEGIN
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'billing_certification_deny_anon', 'billing_certification');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'billing_certification_deny_authenticated', 'billing_certification');
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'billing_certification' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', 'billing_certification');
  END IF;
END
$$;

-- ── variation_order ────────────────────────────────────────────────────────
DO $$
BEGIN
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'variation_order_deny_anon', 'variation_order');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'variation_order_deny_authenticated', 'variation_order');
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'variation_order' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', 'variation_order');
  END IF;
END
$$;

-- ── request_dedupe ────────────────────────────────────────────────────────
DO $$
BEGIN
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'request_dedupe_deny_anon', 'request_dedupe');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'request_dedupe_deny_authenticated', 'request_dedupe');
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'request_dedupe' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', 'request_dedupe');
  END IF;
END
$$;

COMMIT;
