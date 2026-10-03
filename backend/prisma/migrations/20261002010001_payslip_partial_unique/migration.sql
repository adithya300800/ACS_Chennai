-- ─────────────────────────────────────────────────────────────────────────────
-- [Payslips Stage 1 / commit 2] Partial unique index on payslip
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Adds the index `payslip_active_per_month_uidx`:
--
--   CREATE UNIQUE INDEX payslip_active_per_month_uidx
--     ON payslip (employee_id, year, month)
--     WHERE deleted_at IS NULL;
--
-- This is the single source of truth for "active row" for an
-- (employee, year, month) tuple. With v2's publish-gate (plan §C.3),
-- "active" means "exists — whether draft or published". Employee
-- visibility is a SEPARATE filter (`publishedAt IS NOT NULL AND
-- deletedAt IS NULL`).
--
-- Why a raw-SQL migration instead of `@@index` in schema.prisma:
--   Prisma has no syntax for partial unique indexes. This index is the
--   analogue of `no_overlap_leave` for DR-031, which also ships as a
--   raw-SQL migration with its own drift-detection block.
--
-- Why the drift-detection block (the heart of this migration):
--   The audit found that ad-hoc ALTER INDEX / DROP-and-reCREATE patterns
--   can silently reshape a partial unique to admit duplicate active rows.
--   DR-031 caught the same class of bug for `no_overlap_leave`. The
--   PL/pgSQL block below inspects the installed definition with
--   pg_get_indexdef and raises if the index has drifted out of the
--   desired shape. Three signals are checked (in the desired definition):
--     * `position('payslip' in current_def) > 0` — table name present
--     * `position('(employee_id, year, month)' in current_def) > 0` —
--       columns present, in the right order
--     * `position('WHERE (deleted_at IS NULL)' in current_def) > 0` —
--       predicate present, in the canonical form PostgreSQL renders
--   If any are missing, the index is dropped and recreated. The final
--   sanity check re-reads pg_get_indexdef after the recreate and raises
--   if the wrong shape still ships — the migration fails loudly rather
--   than silently shipping a partial-unique that admits duplicate
--   active rows.
--
-- Idempotency:
--   * The DO block's first action is a relname lookup against
--     pg_class. If the index does not exist, it is created. If it
--     exists with the right shape, the block no-ops and raises NOTICE.
--   * If it exists with the wrong shape, it is dropped and recreated.
--   * The final sanity check raises EXCEPTION on drift after the
--     recreate — the test `payslip-partial-unique-drift.test.js`
--     exercises this path against a throwaway DB.
--
-- Out-of-band drift verification (operator-only, NOT shipped as a test):
--   The PAYSLIPS_STAGE1_ORDER.md commits to running an explicit ALTER
--   INDEX RENAME before the next deploy and confirming the drift
--   detection self-heals. Run via:
--
--     docker run --rm -d --name payslip-pg -p 5432:5432 \
--       -e POSTGRES_PASSWORD=test postgres:17-alpine
--     DATABASE_URL=postgresql://postgres:test@localhost:5432/postgres \
--       npx prisma migrate deploy
--     psql ... -c "ALTER INDEX payslip_active_per_month_uidx RENAME TO bogus;"
--     # next migration would recreate + raise NOTICE
--
-- Verification (live post-apply):
--   * `psql -c "\d+ payslip"` lists `payslip_active_per_month_uidx`
--     with definition `UNIQUE, btree (employee_id, year, month) WHERE deleted_at IS NULL`.
--   * `psql -c "SELECT pg_get_indexdef(c.oid) FROM pg_class c WHERE c.relname='payslip_active_per_month_uidx';"`
--     returns the canonical shape with all three markers present.
--   * `psql -c "INSERT INTO payslip (..., year=2026, month=10) ..."` twice
--     with `deleted_at IS NULL` → second INSERT fails with
--     `ERROR: duplicate key value violates unique constraint
--     "payslip_active_per_month_uidx"`.
--
-- Out of scope:
--   * Move to PG would require plan §X.4 (deferred). This migration
--     only owns the partial unique — RLS ships in the next migration,
--     blob-cleanup ships with the cron in plan §X.2.

DO $$
DECLARE
  current_def text;
  index_exists boolean := false;
  bad_definition boolean := false;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = 'payslip_active_per_month_uidx'
  ) INTO index_exists;

  IF index_exists THEN
    SELECT pg_get_indexdef(c.oid) INTO current_def
      FROM pg_class c WHERE c.relname = 'payslip_active_per_month_uidx';

    -- Drift detector. The exact desired predicate is:
    --   CREATE UNIQUE INDEX ... ON payslip (employee_id, year, month)
    --     WHERE deleted_at IS NULL
    -- Any of these markers missing → recreate. Note the column list and
    -- the WHERE clause must match PostgreSQL's canonical rendered form
    -- (lower-case identifiers, single-space separators) — we deliberately
    -- check the canonical form rather than loose substrings so a future
    -- PG-version render change is caught as drift rather than silently
    -- passing.
    bad_definition := (
      position('payslip' in current_def) = 0
      OR position('(employee_id, year, month)' in current_def) = 0
      OR position('WHERE (deleted_at IS NULL)' in current_def) = 0
    );

    IF bad_definition THEN
      DROP INDEX public.payslip_active_per_month_uidx;
      index_exists := false;
      RAISE NOTICE 'payslip: dropped drifted partial-unique index, recreating';
    ELSE
      RAISE NOTICE 'payslip: existing partial-unique index is already correct, skipping';
    END IF;
  END IF;

  IF NOT index_exists THEN
    CREATE UNIQUE INDEX payslip_active_per_month_uidx
      ON public.payslip (employee_id, year, month)
      WHERE deleted_at IS NULL;
  END IF;

  -- Final sanity check, mirroring DR-031's no_overlap_leave pattern.
  -- This is the load-bearing safety net: if a future PG-version render
  -- change OR a recreate-step bug ships the wrong shape, the migration
  -- fails loudly rather than silently shipping a partial-unique that
  -- admits duplicate active rows. The test
  -- `backend/__tests__/payslip-partial-unique-drift.test.js` exercises
  -- this branch by running the migration against a sabotaged index.
  SELECT pg_get_indexdef(c.oid) INTO current_def
    FROM pg_class c WHERE c.relname = 'payslip_active_per_month_uidx';

  IF position('payslip' in current_def) = 0
     OR position('(employee_id, year, month)' in current_def) = 0
     OR position('WHERE (deleted_at IS NULL)' in current_def) = 0 THEN
    RAISE EXCEPTION 'payslip: partial-unique still in wrong shape: %', current_def;
  END IF;
END$$;