-- ─────────────────────────────────────────────────────────────────────────────
-- [security][s2] RLS lockdown follow-up — rotation_receipt
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Trigger:
--   2026-09-27 Supabase Security Advisor alert (CRITICAL) flagged two
--   lints on `acs-portal` (tqmmspqvqtajbijbbsii):
--     0013 rls_disabled_in_public      [ERROR, EXTERNAL] — rotation_receipt
--     0023 sensitive_columns_exposed   [ERROR, EXTERNAL] — rotation_receipt
--   Live confirmation on 2026-10-02 08:55 UTC via Supabase Management API:
--     * pg_class.relrowsecurity: 30 of 31 public tables = true, rotation_receipt = false
--     * pg_policy counts: every locked-down table = 2 policies (deny_anon +
--       deny_authenticated); rotation_receipt = 0 policies
--     * Lint 0023 is gated on lint 0013 + sensitive column-name match per
--       Supabase docs; `access_token` and `refresh_token` both match the
--       sensitive-name pattern. 0023 will auto-clear when 0013 is closed.
--
-- Why rotation_receipt was missed by rls_lockdown_s1 (2026-09-10):
--   The migration 20260924000000_dr002_rotation_receipt shipped AFTER the
--   2026-09-10 lockdown (its timestamp is 2026-09-24) and explicitly skipped
--   RLS, with the inline comment: "We do NOT add RLS — there is no PostgREST
--   anon surface reading this table; the only writer is the backend's
--   transaction body (postgres role, BYPASSRLS). All reads go through prisma.*."
--   That reasoning is wrong: PostgREST auto-exposes every public-schema
--   table to anyone holding the public anon key, regardless of whether the
--   backend itself uses PostgREST. The Supabase Security Advisor scans
--   PostgREST directly — that's why the lint fired 3 days after the
--   exposure opened on 2026-09-24.
--
-- Threat model (re-confirmed 2026-10-02 against live DB):
--   * Public anon key is a public credential, embedded in the SPA bundle.
--     Anyone with the project URL + anon key can `GET /rest/v1/rotation_receipt`
--     and harvest every row.
--   * `access_token` (TEXT, plaintext) is a JWT with a 15-minute TTL — by the
--     time anyone reads this migration most access tokens are stale.
--   * `refresh_token` (TEXT, plaintext) has a 7-day TTL matching the refresh
--     expiry. Tokens minted in the 2026-09-24 → 2026-10-02 window remain live.
--   * An attacker harvesting refresh tokens gets persistent account
--     takeover of every active user for the full 7-day refresh TTL.
--   * The "postgres" role has rolbypassrls = TRUE (verified 2026-09-09 per
--     rls_lockdown_s1 inline comment), so Prisma traffic continues to work
--     untouched after ENABLE ROW LEVEL SECURITY.
--
-- Policy design — same shape as rls_lockdown_s1 (20260910000000):
--   For rotation_receipt:
--     1. ENABLE ROW LEVEL SECURITY  (PostgREST becomes gated)
--     2. CREATE POLICY rotation_receipt_deny_anon            TO anon
--        USING (false) WITH CHECK (false)
--     3. CREATE POLICY rotation_receipt_deny_authenticated  TO authenticated
--        USING (false) WITH CHECK (false)
--   * USING (false) + WITH CHECK (false) is the canonical default-deny for
--     SELECT visibility AND INSERT/UPDATE/DELETE.
--   * No FORCE ROW LEVEL SECURITY — that would defeat BYPASSRLS for the
--     table owner and break the backend's Prisma traffic.
--   * No column-level REVOKEs in this migration. The row-level deny on
--     all four CRUD operations is sufficient because any column read still
--     passes through a policy that returns false. Column-privilege hardening
--     (esp. SELECT on access_token / refresh_token plaintext) is a separate
--     follow-up round if/when a non-PostgREST backend surface ever needs it.
--
-- Why a new migration (not a back-patch of 20260924000000_dr002_rotation_receipt
-- or rls_lockdown_s1):
--   Migrations are append-only. The Phase-4 P0 postmortem
--   (memory: phase-4-p0-s3-6-typo-and-baseline-hazard.md) caught
--   "prisma migrate resolve --applied" LIES that left ALTER TABLE unrun. The
--   safe pattern is a new migration that is independently auditable.
--
-- Idempotency:
--   The body is wrapped in a DO $$...$$ block with a pg_class.relrowsecurity
--   guard so re-runs of the migration do not fail with "table already has
--   RLS enabled". DROP POLICY IF EXISTS is called before every CREATE POLICY.
--
-- Verification (run live post-apply via Supabase Management API):
--   * pg_class.relrowsecurity on public.rotation_receipt must become true.
--   * pg_policy count on public.rotation_receipt must become 2.
--   * Lint 0013 must clear on the next Supabase Security Advisor scan
--     (advisor runs daily; manual probe via
--      GET /v1/projects/{ref}/advisors/security confirms immediately).
--   * Lint 0023 must auto-clear once 0013 closes (same gate per Supabase docs).
--   * PostgREST GET on /rest/v1/rotation_receipt with a real anon key must
--     return HTTP 200 with body "[]" (or 401/403, depending on PostgREST
--     version), never a 200 with row data.
--
-- Out of scope (separate rounds, not this migration):
--   * 0014 extension_in_public on `btree_gist` — known follow-up from
--     rls_lockdown_s1 comment line 64. Not bundled here.
--   * Postgres event trigger on ddl_command_end that auto-enables RLS +
--     deny policies for any future CREATE TABLE in `public`. Defer to a
--     dedicated convention-guard round; this migration is the targeted fix
--     for the Fresh24 regression.
--   * Rotation of active refresh tokens to invalidate any credentials
--     potentially harvested in the 2026-09-24 → 2026-10-02 window. Operator
--     decision: deferred per round policy. RLS lockdown stops future
--     exposure; residual risk of any tokens already harvested is bounded
--     by the 7-day refresh TTL and accepted.
--
-- Rollback (NOT bundled in this file, operator-only):
--   ALTER TABLE public.rotation_receipt DISABLE ROW LEVEL SECURITY;
--   DROP POLICY IF EXISTS rotation_receipt_deny_anon           ON public.rotation_receipt;
--   DROP POLICY IF EXISTS rotation_receipt_deny_authenticated ON public.rotation_receipt;
--   The portal keeps running in either state (BYPASSRLS); rollback only
--   re-opens the PostgREST exposure — use as a stopgap while fixing the
--   underlying issue, then re-apply.
--

BEGIN;

DO $$
BEGIN
  -- Enable RLS only if not already on (re-runs of this migration must not error).
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'rotation_receipt' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', 'rotation_receipt');
  END IF;

  -- Drop any prior copies of the deny policies so re-runs are safe.
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'rotation_receipt_deny_anon', 'rotation_receipt');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'rotation_receipt_deny_authenticated', 'rotation_receipt');

  -- Create the deny policies. USING (false) + WITH CHECK (false) is the
  -- canonical default-deny for both SELECT visibility and INSERT/UPDATE/DELETE.
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO anon
      USING (false) WITH CHECK (false)',
    'rotation_receipt_deny_anon', 'rotation_receipt');
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO authenticated
      USING (false) WITH CHECK (false)',
    'rotation_receipt_deny_authenticated', 'rotation_receipt');
END
$$;

COMMIT;