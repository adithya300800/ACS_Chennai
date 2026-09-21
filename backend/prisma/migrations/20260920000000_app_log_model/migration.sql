-- ─────────────────────────────────────────────────────────────────────────────
-- Round-40 — Structured logging (AppLog model + RLS lockdown).
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Trigger:
--   Backend had 248 console.* calls across 28 files, three separate request-id
--   minting sites, and 14 fire-and-forget call sites that swallowed errors
--   silently (11 fan-out .catch() + 3 .catch(() => [])). The only durable
--   store was Render's free-tier 7-day stdout retention, which is gone the
--   moment a deploy happens. This round adds a structured `app_log` table so
--   request/error/silent-fanout events have a real home for 30 days sliding.
--
-- Why a new migration (not bundled into rls_lockdown_s1 or a future round):
--   Migrations are append-only. The Phase-4 P0 postmortem
--   (memory: phase-4-p0-s3-6-typo-and-baseline-hazard.md) caught
--   "prisma migrate resolve --applied" LIES that left ALTER TABLE unrun.
--   A new migration is independently auditable + reversible.
--
-- RLS policy design — same shape as rls_lockdown_s1 (20260910000000):
--   1. ENABLE ROW LEVEL SECURITY on app_log (PostgREST becomes gated).
--   2. CREATE POLICY app_log_deny_anon            TO anon          USING (false)
--                                                                    WITH CHECK (false)
--   3. CREATE POLICY app_log_deny_authenticated  TO authenticated USING (false)
--                                                                    WITH CHECK (false)
--   * The "postgres" role is BYPASSRLS so all Prisma traffic (the logger's
--     fire-and-forget INSERTs included) continues to work untouched. We do
--     NOT call FORCE ROW LEVEL SECURITY — that would defeat BYPASSRLS and
--     break the backend.
--   * USING (false) + WITH CHECK (false) is the canonical default-deny for
--     SELECT visibility and INSERT/UPDATE/DELETE.
--
-- Why RLS-on-table-from-day-1 is non-negotiable:
--   app_log carries employeeHash, requestId, errorStack, and the full
--   call-site context (which has already been redacted but is still
--   sensitive in aggregate). Without RLS, an anon-key holder on the Supabase
--   PostgREST surface could SELECT every log row — the same exposure that
--   prompted the round-26 RLS lockdown. Lock it down at create-time, not as
--   a follow-up.
--
-- Idempotency:
--   CREATE TABLE uses IF NOT EXISTS so re-runs of the migration don't
--   fail. CREATE INDEX IF NOT EXISTS ditto. The DO $$ block guarding
--   ENABLE RLS + CREATE POLICY mirrors the rls_lockdown_s1 pattern
--   (pg_class check + DROP POLICY IF EXISTS).
--
-- Schema choices + rationale (matches backend/prisma/schema.prisma's
-- AppLog model header — keep the two in sync):
--   * level / source stay as String (not enum) so adding values is a code
--     change, not a migration. round-40 section A.1.
--   * employeeHash only — no raw employeeId column. DPDP-minimization +
--     hash-only end-to-end so an operator forensic-lookup hashes locally.
--   * Two indexes (createdAt, requestId). Every other filter is single-
--     column scan at projected ~30k rows/day; adding more indexes would
--     only cost a write per insert.
--   * errorStack nullable + null in production unless LOG_STACK_TRACE=1.
--   * No FK to employees: employeeHash is for grep correlation, not join.
--     Adding a raw employeeId FK "for convenience" would violate hash-only.
--
-- Index / column order pinned to match the schema:
--   created_at  timestamptz(6) — sub-second ordering under firehose
--   request_id  nullable text  — the second stated debugging use case
--
-- Rollback (NOT bundled in this file, see scripts/...):
--   DROP POLICY app_log_deny_* + DROP INDEX IF EXISTS app_log_request_id_idx
--   + DROP INDEX IF EXISTS app_log_created_at_idx + DROP TABLE app_log. The
--   portal keeps running with console.* in either state — only the durable
--   log capture disappears.
--
-- Out of scope (separate rounds, not this migration):
--   * lib/log.js scaffold (the only writer) — backend/src/lib/log.js
--   * request-id consolidation + requestLogger middleware — round-40 #2
--   * safeAsync wrapper migration — round-40 #3
--   * retention cron endpoint + Render schedule — round-40 #4
--
-- Lint IDs to re-check after apply:
--   * 0013 rls_disabled_in_public — must list app_log as enabled after apply.
--   * 0023 sensitive_columns_exposed — should also clear (employeeHash +
--     errorStack match the column-name pattern; RLS-on makes the lint pass).
--

BEGIN;

-- ── app_log table ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.app_log (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  level         TEXT         NOT NULL,
  source        TEXT         NOT NULL,
  message       TEXT         NOT NULL,
  context       JSONB        NOT NULL,
  request_id    TEXT,
  employee_hash TEXT,
  route         TEXT,
  method        TEXT,
  status        INTEGER,
  latency_ms    INTEGER,
  error_code    TEXT,
  error_stack   TEXT,
  created_at    TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS app_log_created_at_idx ON public.app_log (created_at);
CREATE INDEX IF NOT EXISTS app_log_request_id_idx ON public.app_log (request_id);

-- ── app_log RLS lockdown ────────────────────────────────────────────────────
DO $$
BEGIN
  -- Enable RLS only if not already on (re-runs of this migration must not error).
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'app_log' AND n.nspname = 'public'
       AND c.relrowsecurity = TRUE
  ) THEN
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', 'app_log');
  END IF;

  -- Drop any prior copies of the deny policies so re-runs are safe.
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'app_log_deny_anon', 'app_log');
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'app_log_deny_authenticated', 'app_log');

  -- Create the deny policies. USING (false) + WITH CHECK (false) is the
  -- canonical default-deny for both SELECT visibility and INSERT/UPDATE/DELETE.
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO anon
      USING (false) WITH CHECK (false)',
    'app_log_deny_anon', 'app_log');
  EXECUTE format('
    CREATE POLICY %I ON public.%I
      FOR ALL TO authenticated
      USING (false) WITH CHECK (false)',
    'app_log_deny_authenticated', 'app_log');
END
$$;

COMMIT;
