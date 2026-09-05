-- [N7 / round-28] BOQ link on DPR / Inspection.
--
-- Half-step to N1 (Project Master). Adds a Bill-of-Quantities line-item
-- table and an optional FK on both DPR and InspectionRecord so a DPR /
-- inspection line can be traced back to its BOQ item — without waiting
-- for the full Project Master that N1 introduces.
--
-- Tables / columns
-- ---------------
--   CREATE TABLE boq_item
--     New BOQ line-item registry. @@map in schema.prisma is "boq_item"
--     (singular, matching DPR / inspection_record convention). PK = uuid.
--     @@unique([projectName, itemCode]) maps to a unique INDEX below.
--     @@index([projectName]) + @@index([isActive]) become two more
--     indexes — drives the list / filter hot path.
--
--   ALTER TABLE dpr ADD COLUMN boq_item_id
--     Nullable + onDelete SET NULL on the FK (mirror of dpr_id on
--     InspectionRecord). Archiving a BOQ item must not cascade-delete
--     historic DPR rows — audit trail survives.
--
--   ALTER TABLE inspection_record ADD COLUMN boq_item_id
--     Same contract as the DPR column.
--
-- Why a new migration (not an edit to an existing one)
-- ----------------------------------------------------
-- Migration history is append-only. The Phase-4 P0 postmortem
-- (memory file phase-4-p0-s3-6-typo-and-baseline-hazard.md) caught
-- `prisma migrate resolve --applied` LIES that left the underlying
-- ALTER TABLE unrun. A new migration is the canonical pattern for
-- schema additions — append, never rewrite.
--
-- @map table names used below (cross-checked against schema.prisma)
-- -----------------------------------------------------------------
--   DPR model              -> @@map("dpr")                  (line 237)
--   InspectionRecord model -> @@map("inspection_record")     (line 332)
--   BoqItem model          -> @@map("boq_item")             (this file)
--
-- The S3-6 postmortem was caused by using `training_enrollments`
-- (plural) instead of `training_enrollment` (the actual @@map). These
-- three names are double-checked here against schema.prisma @@map
-- declarations.
--
-- Idempotency
-- -----------
-- All DDL uses IF NOT EXISTS so a re-run against a partially-applied
-- database is a no-op (matches the S3-6 follow-up migration's
-- idempotency pattern, verified against Postgres 15 on Supabase).
--
-- Forward path
-- ------------
-- 1. Commit this migration.
-- 2. Render auto-deploys -> startCommand chain
--    `npx prisma migrate deploy ; node src/index.js`
--    picks up the new migration, creates boq_item, adds the two FK
--    columns.
-- 3. `npx prisma generate` (run by the build command) emits the
--    updated Prisma client with the new BoqItem model + the
--    boqItem / boqItemId relations on DPR / InspectionRecord.

-- ─── BoQ item registry ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS boq_item (
  id           TEXT        PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  project_name TEXT        NOT NULL,
  item_code    VARCHAR(60) NOT NULL,
  description  TEXT        NOT NULL,
  unit         VARCHAR(20) NOT NULL,
  quantity     DOUBLE PRECISION NOT NULL,
  rate         DOUBLE PRECISION NOT NULL,
  amount       DOUBLE PRECISION NOT NULL,
  category     VARCHAR(60),
  is_active    BOOLEAN     NOT NULL DEFAULT TRUE,
  created_by_id TEXT       NOT NULL,
  created_at   TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- FK to employees(id). ON DELETE RESTRICT matches schema.prisma so
  -- deleting an employee never silently orphans a BOQ row.
  CONSTRAINT boq_item_created_by_id_fkey
    FOREIGN KEY (created_by_id) REFERENCES employees(id) ON DELETE RESTRICT
);

-- @@unique([projectName, itemCode])
CREATE UNIQUE INDEX IF NOT EXISTS boq_item_project_name_item_code_key
  ON boq_item (project_name, item_code);

-- @@index([projectName])
CREATE INDEX IF NOT EXISTS boq_item_project_name_idx
  ON boq_item (project_name);

-- @@index([isActive])
CREATE INDEX IF NOT EXISTS boq_item_is_active_idx
  ON boq_item (is_active);

-- ─── DPR FK ─────────────────────────────────────────────────────────────────

ALTER TABLE dpr
  ADD COLUMN IF NOT EXISTS boq_item_id TEXT;

-- FK is conditional: a database that already has the column (re-run
-- scenario) must not throw a duplicate-FK error. The IF NOT EXISTS on
-- the column above is paired with the DO block below — Postgres has no
-- native "ADD CONSTRAINT IF NOT EXISTS", so we guard via a DO $$ ...
-- EXCEPTION handler that checks pg_constraint first.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'dpr_boq_item_id_fkey'
  ) THEN
    ALTER TABLE dpr
      ADD CONSTRAINT dpr_boq_item_id_fkey
      FOREIGN KEY (boq_item_id) REFERENCES boq_item(id) ON DELETE SET NULL;
  END IF;
END$$;

-- @@index([boqItemId])
CREATE INDEX IF NOT EXISTS dpr_boq_item_id_idx
  ON dpr (boq_item_id);

-- ─── Inspection record FK ───────────────────────────────────────────────────

ALTER TABLE inspection_record
  ADD COLUMN IF NOT EXISTS boq_item_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inspection_record_boq_item_id_fkey'
  ) THEN
    ALTER TABLE inspection_record
      ADD CONSTRAINT inspection_record_boq_item_id_fkey
      FOREIGN KEY (boq_item_id) REFERENCES boq_item(id) ON DELETE SET NULL;
  END IF;
END$$;

-- @@index([boqItemId])
CREATE INDEX IF NOT EXISTS inspection_record_boq_item_id_idx
  ON inspection_record (boq_item_id);