-- DRY-RUN + POST-DEPLOY verification for S1 RLS lockdown
-- Three sections: PART A (baseline pre-apply), PART B (post-apply,
-- in-transaction SET LOCAL ROLE), PART C (PostgREST curl check, run
-- from a shell with the anon public key).

-- PART A - BASELINE (run BEFORE migration.sql).
-- Expect: rls_enabled = false, policy_count = 0 for all 30.
SELECT
  c.relname AS table_name,
  c.relrowsecurity AS rls_enabled,
  c.relforcerowsecurity AS rls_forced,
  (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policy_count
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relname IN ('attendance_sessions', 'dpr_photo', 'dpr_revision', 'notification', 'employees', 'attendance', 'inspection_photo', 'leave_request', 'training_course', 'email_log', 'revoked_token', 'refresh_token', 'digest_run', 'training_enrollment', 'notification_preference', 'digest_item', '_prisma_migrations', 'admin_digest_run', 'upload_intent', 'boq_item', 'drawing', 'project', 'dpr', 'inspection_record', 'project_assignment', 'boq_execution', 'project_attachment', 'billing_certification', 'variation_order', 'request_dedupe')
ORDER BY c.relname;

-- PART B - POLICY VERIFICATION (run AFTER migration.sql).
-- Expect: rls_enabled = true, policy_count = 2 for all 30.
SELECT
  c.relname AS table_name,
  c.relrowsecurity AS rls_enabled,
  (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policy_count
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relname IN ('attendance_sessions', 'dpr_photo', 'dpr_revision', 'notification', 'employees', 'attendance', 'inspection_photo', 'leave_request', 'training_course', 'email_log', 'revoked_token', 'refresh_token', 'digest_run', 'training_enrollment', 'notification_preference', 'digest_item', '_prisma_migrations', 'admin_digest_run', 'upload_intent', 'boq_item', 'drawing', 'project', 'dpr', 'inspection_record', 'project_assignment', 'boq_execution', 'project_attachment', 'billing_certification', 'variation_order', 'request_dedupe')
ORDER BY c.relname;

-- Per-role read attempt. Wrap in a transaction so SET LOCAL ROLE scopes
-- to this block; rollback keeps the database unchanged.
BEGIN;
  SET LOCAL ROLE anon;
  SELECT 'employees' AS tbl, count(*) AS anon_rows FROM public.employees;
  SELECT 'attendance_sessions' AS tbl, count(*) AS anon_rows FROM public.attendance_sessions;
  SELECT 'refresh_token' AS tbl, count(*) AS anon_rows FROM public.refresh_token;
  SELECT 'dpr' AS tbl, count(*) AS anon_rows FROM public.dpr;
  SELECT 'project' AS tbl, count(*) AS anon_rows FROM public.project;
  SET LOCAL ROLE authenticated;
  SELECT 'employees' AS tbl, count(*) AS auth_rows FROM public.employees;
  SELECT 'attendance_sessions' AS tbl, count(*) AS auth_rows FROM public.attendance_sessions;
  SELECT 'refresh_token' AS tbl, count(*) AS auth_rows FROM public.refresh_token;
  SELECT 'dpr' AS tbl, count(*) AS auth_rows FROM public.dpr;
  SELECT 'project' AS tbl, count(*) AS auth_rows FROM public.project;
ROLLBACK;

-- PART C - PostgREST attack-surface check (curl, not SQL).
-- For each of the 30 tables, expect HTTP 200 with body "[]" (or 401/403
-- depending on PostgREST version), NEVER a 200 with row data. Replace
-- $ANON with the anon key.
--
--   for tbl in attendance_sessions dpr_photo dpr_revision notification \
--     employees attendance inspection_photo leave_request training_course \
--     email_log revoked_token refresh_token digest_run training_enrollment \
--     notification_preference digest_item _prisma_migrations admin_digest_run \
--     upload_intent boq_item drawing project dpr inspection_record \
--     project_assignment boq_execution project_attachment billing_certification \
--     variation_order request_dedupe; do
--     echo -n "$tbl: ";
--     curl -s -o /tmp/r.json -w "HTTP %{http_code} bytes %{size_download}" \
--       -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
--       "https://tqmmspqvqtajbijbbsii.supabase.co/rest/v1/$tbl?select=id&limit=1";
--     echo " body=$(cat /tmp/r.json)";
--   done
--
-- PASS criterion: HTTP 200 with body "[]" (or 401/403, depending on
-- PostgREST version + presence of policies). FAIL: any body containing
-- row data.
