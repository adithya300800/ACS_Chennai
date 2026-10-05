-- ─────────────────────────────────────────────────────────────────────────────
-- [Payslips Stage 1 / commit 2] Add purge-audit columns to payslip
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The v2 plan's §C.1 listed revoke + publish audit only. The user's task
-- prompt (2026-10-02) explicitly added `purgedById / purgedAt / purgedReason`
-- for the misdelivery purge script (commit 8), which keeps a tombstone row
-- (does NOT hard-delete). This migration adds the three columns + the FK
-- to employees(id) on the purge-by back-relation.
--
-- Strictly additive — ALTER TABLE … ADD COLUMN with NULL defaults.
-- The FK is added separately (idempotently) so re-running this migration
-- is safe.
--
-- Threat model: same as `20261002010000_payslip_create_table`. The purge
-- audit columns are non-PII (UUID + timestamp + free-text reason ≤ 500
-- chars). The reason field is validated in commit 3 to reject strings
-- containing PII patterns (PAN / UAN / account / net / gross / basic / hra).
--
-- Idempotency: each ALTER wrapped in `IF NOT EXISTS` check via
-- information_schema.columns so a re-run is a no-op.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'payslip' AND column_name = 'purged_by_id'
  ) THEN
    ALTER TABLE public.payslip ADD COLUMN purged_by_id text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'payslip' AND column_name = 'purged_at'
  ) THEN
    ALTER TABLE public.payslip ADD COLUMN purged_at TIMESTAMP(3);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'payslip' AND column_name = 'purged_reason'
  ) THEN
    ALTER TABLE public.payslip ADD COLUMN purged_reason VARCHAR(500);
  END IF;
END$$;

-- Foreign key on purged_by_id → employees(id), ON DELETE SET NULL so
-- removing the acting admin never cascades the audit trail away.
-- Constraint name uses the `_fkey` suffix that Prisma generates by
-- default for FK constraints (verified via `prisma migrate diff`).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name = 'payslip'
      AND constraint_name = 'payslip_purged_by_id_fkey'
  ) THEN
    ALTER TABLE public.payslip
      ADD CONSTRAINT payslip_purged_by_id_fkey
      FOREIGN KEY (purged_by_id) REFERENCES public.employees(id)
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END$$;
