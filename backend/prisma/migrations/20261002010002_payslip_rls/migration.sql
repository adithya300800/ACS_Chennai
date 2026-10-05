-- ─────────────────────────────────────────────────────────────────────────────
-- [Payslips Stage 1 / commit 2] RLS lockdown — payslip
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Trigger:
--   2026-10-02 PAYSLIPS_STAGE1 pre-implementation audit. PostgREST
--   auto-exposes every public-schema table to anyone holding the
--   public anon key (embedded in the SPA bundle). Without RLS, an
--   attacker with the project URL + anon key could `GET
--   /rest/v1/payslip` and harvest:
--     * employee_id (UUID → join to /rest/v1/employees → name, email,
--       designation, department)
--     * year/month (which months have payslips → set of business dates
--       that map to the company's payroll calendar)
--     * blob_path (R2 key suffix → colludes with a leaked R2 SAS to
--       harvest every payslip PDF — the salary-bearing artifact)
--     * uploaded_by_id / published_by_id / revoked_by_id (which
--       admin did what — colludes with /rest/v1/employees for the
--       admin names)
--   None of that data is payroll-figure leakage, but the metadata
--   joins to /rest/v1/employees (which is also auto-exposed and is
--   separately locked down by `rls_lockdown_s1`) would yield the
--   payroll calendar + admin activity log. The PDF itself is R2-only,
--   so the marginal exposure is metadata only — but metadata is
--   enough for an HR-targeted phishing campaign.
--
-- Why a separate migration (not bundled into 20261002010000):
--   Migrations are append-only. The Phase-4 P0 postmortem
--   (memory: phase-4-p0-s3-6-typo-and-baseline-hazard.md) caught
--   "prisma migrate resolve --applied" lies that left DDL unrun.
--   Splitting CREATE TABLE and RLS into two timestamped migrations
--   means each step has a single, independently-auditable ledger row
--   — and the RLS step is replayable without re-creating the table.
--
-- Why a third migration (not part of `rls_lockdown_s1`):
--   `rls_lockdown_s1` shipped on 2026-09-10; commit-2 ships
--   `payslip_create_table` on 2026-10-02. The CREATE TABLE cannot
--   precede RLS in timestamp order — that's exactly the window this
--   migration closes (the table exists for microseconds between the
--   CREATE TABLE migration and this one, both run inside the same
--   deploy transaction).
--
-- Policy design — same shape as `rls_lockdown_s1` (20260910000000):
--   For payslip:
--       1. ENABLE ROW LEVEL SECURITY  (PostgREST becomes gated)
--       2. CREATE POLICY payslip_deny_anon            TO anon
--          USING (false) WITH CHECK (false)
--       3. CREATE POLICY payslip_deny_authenticated  TO authenticated
--          USING (false) WITH CHECK (false)
--   * USING (false) + WITH CHECK (false) is the canonical default-deny
--     for SELECT visibility AND INSERT/UPDATE/DELETE.
--   * No FORCE ROW LEVEL SECURITY — that would defeat BYPASSRLS for
--     the table owner and break the backend's Prisma traffic. The
--     "postgres" role has rolbypassrls = TRUE (verified 2026-09-09
--     per rls_lockdown_s1).
--   * No write policy for `authenticated` — writes go through Prisma
--     as `postgres` (commit 3 ships the routes). RLS is defense-in-
--     depth; the canonical tenant enforcement is in the controller
--     (e.g. `WHERE employeeId = req.employeeId`).
--
-- Loud-failure shape:
--   The body unconditionally:
--     1. ENABLE ROW LEVEL SECURITY (idempotent — Postgres doesn't error
--        if RLS is already enabled).
--     2. DROP POLICY IF EXISTS for both deny policies (idempotent).
--     3. CREATE POLICY for both deny policies (idempotent — the DROP
--        before each CREATE means a re-run always lands at the
--        canonical state).
--     4. Sanity check via RAISE EXCEPTION if pg_class.relrowsecurity
--        is not TRUE on public.payslip OR pg_policy count is not
--        exactly 2. Loud failure means a future migration that
--        accidentally disables RLS (e.g. via an `ALTER TABLE ...
--        DISABLE ROW LEVEL SECURITY` typo) trips the safety net on
--        re-run.
--   There is intentionally NO `EXCEPTION WHEN OTHERS THEN NULL`
--   swallow anywhere — earlier checkpoint feedback explicitly
--   requested that. A migration that succeeds with relrowsecurity
--   off would be a silent regression; the loud check refuses to
--   let that ship.
--
-- Verification (live post-apply):
--   * pg_class.relrowsecurity on public.payslip must be `t`.
--   * pg_policy count on public.payslip must be 2
--     (payslip_deny_anon + payslip_deny_authenticated).
--   * PostgREST GET on /rest/v1/payslip with a real anon key must
--     return HTTP 200 with body "[]" (or 401/403, depending on
--     PostgREST version), never a 200 with row data.
--   * Backend's Prisma traffic continues unchanged (postgres role
--     has BYPASSRLS).
--
-- Out of scope (separate rounds, not this migration):
--   * Column-level REVOKEs — same reasoning as
--     20261002000000_rls_lockdown_rotation_receipt line 55. The
--     row-level deny on all four CRUD operations is sufficient
--     because any column read still passes through a policy that
--     returns false.
--   * Postgres event trigger on ddl_command_end that auto-enables
--     RLS + deny policies for any future CREATE TABLE in `public`.
--     Defer to a dedicated convention-guard round; this migration
--     is the targeted fix for the payslip auto-exposure window.
--   * Audit log entry via AppLog row documenting the migration
--     apply — handled by the standard pre-deploy logging in
--     start.sh, not by this migration.
--
-- Rollback (NOT bundled in this file, operator-only):
--   ALTER TABLE public.payslip DISABLE ROW LEVEL SECURITY;
--   DROP POLICY IF EXISTS payslip_deny_anon           ON public.payslip;
--   DROP POLICY IF EXISTS payslip_deny_authenticated ON public.payslip;
--   The portal keeps running in either state (BYPASSRLS); rollback
--   only re-opens the PostgREST exposure — use as a stopgap while
--   fixing the underlying issue, then re-apply.

BEGIN;

ALTER TABLE public.payslip ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payslip_deny_anon           ON public.payslip;
DROP POLICY IF EXISTS payslip_deny_authenticated ON public.payslip;

CREATE POLICY payslip_deny_anon ON public.payslip
  FOR ALL TO anon
  USING (false) WITH CHECK (false);

CREATE POLICY payslip_deny_authenticated ON public.payslip
  FOR ALL TO authenticated
  USING (false) WITH CHECK (false);

-- Loud safety net: refuse to commit if RLS is somehow off OR if
-- the policy count is not exactly 2. The DR-031 lesson: a migration
-- that silently ships a half-applied security posture is worse than
-- a loud failure. The check runs after the CREATE POLICY statements
-- so a successful re-run always lands at the canonical state.
DO $$
DECLARE
  rls_enabled boolean;
  policy_count integer;
BEGIN
  SELECT relrowsecurity INTO rls_enabled
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'payslip';

  SELECT count(*) INTO policy_count
    FROM pg_policy WHERE polrelid = 'public.payslip'::regclass;

  IF rls_enabled IS NOT TRUE THEN
    RAISE EXCEPTION 'payslip RLS lockdown: relrowsecurity = % (expected true)', rls_enabled;
  END IF;
  IF policy_count <> 2 THEN
    RAISE EXCEPTION 'payslip RLS lockdown: policy count = % (expected 2)', policy_count;
  END IF;
END$$;

COMMIT;