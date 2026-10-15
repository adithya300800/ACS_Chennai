-- [feat/google-login-allowlist] Additive table for "Sign in with Google".
--
-- One allowlist row per Gmail address that may sign in. A row is an
-- explicit operator grant — the mere existence of a row (with
-- is_active = true) is the only way Google's OAuth flow can produce a
-- session for an external Gmail address. No Employee is created at
-- add-time; the row stores user_id NULL until the first successful
-- Google login, when the row is back-linked to the newly provisioned
-- (or pre-existing matching) Employee.
--
-- employees.id is TEXT (see 20260101000000_init_baseline:187 and the
-- Employee model in schema.prisma). user_id matches that type so the
-- FK can be enforced at the database level.
--
-- Email invariant: every row stores a lowercase email, enforced by
-- a CHECK constraint combined with a plain unique index on `email`.
-- We deliberately do NOT use a lower(email) functional index — the
-- Prisma model declares `email String @unique` (a plain unique), and
-- the migration names the index `google_login_allowlist_email_key`
-- so `prisma migrate diff` reports no schema drift.
--
-- The CHECK constraint and the partial active index below are
-- migration-only concerns (Prisma's schema language has no syntax
-- for either). Both are expected to appear in the diff output —
-- every OTHER shape in this migration must match the Prisma model
-- byte-for-byte, otherwise `prisma migrate diff` flags drift.
--
-- Idempotent for manual apply via the Supabase SQL editor: if the
-- operator ran this file by hand before `migrate deploy` saw the
-- ledger row, the IF NOT EXISTS guards prevent a re-apply error.
-- After a manual apply, the operator records the migration in the
-- Prisma ledger with:
--   npx prisma migrate resolve --applied 20261014000000_google_login_allowlist
-- (Documented in docs/google-login-allowlist.md.)
BEGIN;

CREATE TABLE IF NOT EXISTS public.google_login_allowlist (
  id            text PRIMARY KEY,
  email         text NOT NULL,
  user_id       text NULL,
  google_sub    text NULL,
  is_active     boolean NOT NULL DEFAULT true,
  note          text NULL,
  added_by      text NULL,
  created_at    timestamptz(6) NOT NULL DEFAULT now(),
  updated_at    timestamptz(6) NOT NULL DEFAULT now(),
  last_login_at timestamptz(6) NULL,
  CONSTRAINT google_login_allowlist_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES public.employees(id) ON DELETE SET NULL
);

-- Application-level invariant: every email stored is already lowercase.
-- Combined with the plain unique on `email` below, this gives us a
-- case-insensitive uniqueness contract without functional indexes.
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'google_login_allowlist_email_lowercase_chk'
  ) THEN
    ALTER TABLE public.google_login_allowlist
      ADD CONSTRAINT google_login_allowlist_email_lowercase_chk
      CHECK (email = lower(email));
  END IF;
END
$do$;

-- Plain unique index. Name is the one Prisma auto-generates for
-- `email String @unique` on a `@@map("google_login_allowlist")` model:
--   <table>_<column>_key   ->   google_login_allowlist_email_key
-- The migration pins the same name so `prisma migrate diff` does not
-- flag a drift between schema.prisma and the applied DDL.
CREATE UNIQUE INDEX IF NOT EXISTS google_login_allowlist_email_key
  ON public.google_login_allowlist (email);

-- `userId` is `@unique` on the Prisma model (1:1 relation — an
-- Employee can be linked from at most one allowlist row, because the
-- row's `email` is also unique). Prisma generates a unique index
-- named `<table>_<column>_key` for every `@unique` column, so we
-- pin the same name here.
CREATE UNIQUE INDEX IF NOT EXISTS google_login_allowlist_user_id_key
  ON public.google_login_allowlist (user_id);

-- Hot path: the OAuth callback's allowlist lookup filters to active
-- rows. A partial index keeps the index small as the table grows.
-- Partial indexes are not expressible in Prisma's schema language, so
-- this lives in the migration only and is expected to appear in the
-- `prisma migrate diff` output.
CREATE INDEX IF NOT EXISTS google_login_allowlist_active_email_idx
  ON public.google_login_allowlist (email)
  WHERE is_active = true;

-- RLS — deny anon and authenticated. App connects as the `postgres`
-- role (rolbypassrls = TRUE, verified 2026-09-09), so Prisma traffic
-- is unaffected. Wrapped in the same BEGIN so the table + RLS are
-- atomic. Idempotent: skip the ENABLE if relrowsecurity is already on.
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'google_login_allowlist' AND relrowsecurity
  ) THEN
    ALTER TABLE public.google_login_allowlist ENABLE ROW LEVEL SECURITY;
    CREATE POLICY google_login_allowlist_deny_anon ON public.google_login_allowlist
      FOR ALL TO anon USING (false) WITH CHECK (false);
    CREATE POLICY google_login_allowlist_deny_authenticated ON public.google_login_allowlist
      FOR ALL TO authenticated USING (false) WITH CHECK (false);
  END IF;
END
$do$;

COMMIT;
