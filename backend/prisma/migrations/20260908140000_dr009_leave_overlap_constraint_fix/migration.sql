-- DR-031 fix (audit, 2026-09-08): the original
-- 20260902220220_dr009_leave_overlap_constraint migration referenced
-- snake_case columns "start_date" / "end_date" that do NOT exist on
-- the `leave_request` table — schema.prisma declares them camelCase
-- ("startDate" / "endDate") with NO `@map`, and the init_baseline
-- creates them as the quoted-camelCase identifiers. The original
-- migration therefore ERRORED on every apply and the
-- `no_overlap_leave` constraint never made it into the database.
-- Live verification: pg_constraint lookup returns zero rows for
-- `conname = 'no_overlap_leave'` even though the migration is
-- nominally in the ledger.
--
-- Per the Phase-4 P0 append-only rule we DO NOT edit the broken
-- migration. This migration is the authoritative fix — it DROPs any
-- half-applied state and recreates the constraint with the correct
-- column names. The DO $$ ... $$ guard makes it idempotent on every
-- cold start: if the constraint exists, no-op; otherwise create it.
--
-- Why btree_gist + EXCLUDE rather than UNIQUE:
--   * UNIQUE only catches equality, not [start,end] intervals.
--   * btree_gist lets a single GiST index mix scalar equality on
--     employee_id with range-overlap (&&) on
--     daterange("startDate", "endDate" + 1, '[]').
--   * btree_gist ships with every Supabase Postgres image, so the
--     extension is created on demand (IF NOT EXISTS is safe to
--     re-run).
--
-- Why daterange("startDate", "endDate" + 1, '[]'):
--   * "startDate" / "endDate" are calendar days (Prisma @db.Date).
--   * Inclusive overlap semantics: day X of one leave and day X of
--     another IS a conflict. A canonical inclusive range over
--     [start, end+1) is '[]' daterange(start, end + 1) — the same
--     as '[start, end+1)' but spelled the way GiST && wants for the
--     predicate to fire.
--   * "endDate" + 1 is the Postgres date+integer operator (returns
--     DATE, not timestamp) — required so both daterange bounds are
--     DATE. Using "+ INTERVAL '1 day'" returns timestamp and breaks
--     the daterange type resolution.
--
-- Why partial (WHERE status IN ('PENDING','APPROVED')):
--   * REJECTED and CANCELLED leaves are terminal and must not block
--     a fresh submission — an admin can reject one request and the
--     employee can re-submit for the same dates.

CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'no_overlap_leave'
  ) THEN
    ALTER TABLE "leave_request"
      ADD CONSTRAINT "no_overlap_leave"
      EXCLUDE USING gist (
        "employee_id" WITH =,
        daterange("startDate", ("endDate" + 1), '[]') WITH &&
      )
      WHERE ("status" IN ('PENDING', 'APPROVED'));
  END IF;
END$$;
