-- ─────────────────────────────────────────────────────────────────────────────
-- DR-015 (audit, 2026-09-08) — BOQ execution ledger
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Audit verdict:
--   "BoQ variance vs execution. BoQ had Planned and Actual columns but no
--    execution ledger. There is no persisted record of when items were
--    issued, installed, or paid. Severity: High."
--
-- Repair / acceptance (from the audit doc):
--   "capture unit-bearing executed quantities with a defined acceptance/
--    status policy … a 100-unit contract with 30 accepted executed units
--    must consistently show 30 executed/70 remaining."
--
-- Why a new migration (not an edit to n7_boq_items)
-- -------------------------------------------------
-- Migration history is append-only. The Phase-4 P0 postmortem
-- (memory file phase-4-p0-s3-6-typo-and-baseline-hazard.md) caught
-- `prisma migrate resolve --applied` LIES that left the underlying
-- ALTER TABLE unrun. A new migration is the canonical pattern for
-- schema additions — append, never rewrite. n7_boq_items stays
-- frozen as the audit trail for the original BoQItem table.
--
-- Tables / enums
-- --------------
--   CREATE TYPE BoqExecutionStage
--     Three-value enum: ISSUED | INSTALLED | PAID. Drives both the
--     admin record form and future "in pipeline vs built" splits on
--     dashboards.
--
--   CREATE TABLE boq_execution
--     One row = one execution event for one BOQ item. Cascade-delete
--     on boqItemId (an item's ledger must die with the item — no
--     orphan rows). RESTRICT on recordedById (mirror of BoqItem.
--     createdById — deleting an employee who recorded an execution is
--     a business operation, not a silent cascade).
--
-- Idempotency
-- -----------
-- All DDL uses IF NOT EXISTS / DO $$ blocks (mirrors n7_boq_items +
-- r37_billing_certifications conventions, verified against Postgres
-- 15 on Supabase). A re-run against a partially-applied DB is a
-- no-op.
--
-- Backward compatibility
-- ----------------------
-- Existing BoqItem rows are untouched. The /variance route will be
-- updated to read from this new table (in the same commit) so a
-- freshly deployed app immediately starts showing real executed
-- quantities. No backfill — there's no legacy execution data to
-- preserve (the old DPR.quantity placeholder was always 0).
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── New enum ───────────────────────────────────────────────────────────────

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'BoqExecutionStage') THEN
    CREATE TYPE "BoqExecutionStage" AS ENUM (
      'ISSUED',
      'INSTALLED',
      'PAID'
    );
  END IF;
END $$;

-- ─── New table: boq_execution ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS boq_execution (
  id                TEXT PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  boq_item_id       TEXT NOT NULL,
  executed_quantity DOUBLE PRECISION NOT NULL,
  executed_at       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Default 'INSTALLED' — the audit's reference scenario is "30 units
  -- installed", not "30 units issued to site". Admins can override
  -- on the record form when back-dating a material receipt or an
  -- RA-bill certification.
  stage             "BoqExecutionStage" NOT NULL DEFAULT 'INSTALLED',
  -- Default TRUE so a one-click "Record execution" contributes to the
  -- variance sum without a second toggle. Admins flip to FALSE to
  -- retract a bad entry without losing the audit row.
  accepted          BOOLEAN NOT NULL DEFAULT TRUE,
  notes             TEXT,
  recorded_by_id    TEXT NOT NULL,
  created_at        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ─── FKs (idempotent) ───────────────────────────────────────────────────────
--   - boqItemId     CASCADE   — an item's ledger dies with the item
--                               (a soft-deleted BOQ has no executions
--                               to report; matches DPR/Inspection's
--                               onDelete: SetNull in spirit by not
--                               letting the row outlive its parent).
--   - recordedById  RESTRICT  — mirror of BoqItem.createdById. Deleting
--                               an employee who recorded an execution
--                               is a business operation, not a silent
--                               cascade.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'boq_execution_boq_item_id_fkey'
  ) THEN
    ALTER TABLE boq_execution
      ADD CONSTRAINT boq_execution_boq_item_id_fkey
      FOREIGN KEY (boq_item_id) REFERENCES boq_item(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'boq_execution_recorded_by_id_fkey'
  ) THEN
    ALTER TABLE boq_execution
      ADD CONSTRAINT boq_execution_recorded_by_id_fkey
      FOREIGN KEY (recorded_by_id) REFERENCES employees(id) ON DELETE RESTRICT;
  END IF;
END $$;

-- ─── Indexes (idempotent) ──────────────────────────────────────────────────
-- Hot reads:
--   - per-item timeline (the list endpoint): (boqItemId, executedAt DESC)
--   - admin overview by stage: (stage)

CREATE INDEX IF NOT EXISTS boq_execution_boq_item_id_executed_at_idx
  ON boq_execution (boq_item_id, executed_at);

CREATE INDEX IF NOT EXISTS boq_execution_stage_idx
  ON boq_execution (stage);
