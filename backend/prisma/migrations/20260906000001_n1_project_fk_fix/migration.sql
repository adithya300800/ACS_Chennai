-- ─────────────────────────────────────────────────────────────────────────────
-- N1 (Phase-A) — corrective migration: fix column-name case in backfill
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The original `20260906000000_n1_project_fk` migration failed at Render
-- deploy time with Prisma error P3018 / Postgres error 42703:
--
--   ERROR: column d.project_name does not exist
--   HINT: Perhaps you meant to reference the column "d.projectName".
--
-- ROOT CAUSE
--
-- Postgres folds unquoted identifiers to lowercase. The original migration
-- referenced `d."project_name"` (snake_case), but the actual DB columns
-- are camelCase quoted identifiers:
--
--   - "dpr"."projectName"               (init_baseline: no @map on field)
--   - "inspection_record"."projectName" (init_baseline: no @map on field)
--   - "boq_item"."project_name"          (N7 migration: @map("project_name"))
--
-- Postgres resolves an unquoted `project_name` to `projectname`, then
-- case-insensitively compares to `"projectName"` — fails. The quoted
-- `"project_name"` ALSO fails because the column is `"projectName"`.
-- The error's hint was right: the DPR / InspectionRecord column is
-- `"projectName"` (camelCase, quoted), and BoqItem's column is
-- `"project_name"` (snake_case, quoted).
--
-- The DDL parts of the original migration (ALTER TABLE … ADD COLUMN,
-- ALTER TABLE … ADD CONSTRAINT, CREATE INDEX) ran inside the same failed
-- transaction. Per Prisma's migrate deploy semantics, on failure the
-- entire migration's transaction is rolled back — so the DB is left at
-- the pre-migration state. The next `prisma migrate deploy` after this
-- corrective migration will see:
--
--   (a) status='failed' row in _prisma_migrations for the original
--       migration name — the workflow's lpr-029 handler must
--       DELETE-then-resolve that row before deploy proceeds
--   (b) project parties/contract_value/sites/description columns
--       NOT YET created
--   (c) dpr/inspection_record/boq_item project_id columns
--       NOT YET created
--   (d) all FK constraints NOT YET created
--   (e) the old boq_item unique INDEX may or may not exist —
--       depends on whether Postgres commits DDL incrementally
--       inside a failed Prisma transaction. With `IF NOT EXISTS` /
--       `IF EXISTS` guards below, both states are handled.
--
-- APPEND-ONLY RULE
--
-- We don't edit the original migration. _prisma_migrations carries a
-- SHA256 of each migration's SQL file; rewriting the file would diverge
-- the recorded checksum and break `prisma migrate diff`. This corrective
-- migration re-runs the original DDL + the fixed backfill as a new
-- migration row. (Per the Phase-4 P0 postmortem:
-- ../../.claude/projects/-Users-adithyamohanavel-Documents-Repo-ACS-Chennai/memory/phase-4-p0-s3-6-typo-and-baseline-hazard.md )
--
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Widen project (re-run idempotently)
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "parties" JSONB;
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "contract_value" NUMERIC(15,2);
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "sites" JSONB;
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "description" TEXT;

-- 2. Add project_id columns (idempotent re-run)
ALTER TABLE "dpr" ADD COLUMN IF NOT EXISTS "project_id" TEXT;
ALTER TABLE "inspection_record" ADD COLUMN IF NOT EXISTS "project_id" TEXT;
ALTER TABLE "boq_item" ADD COLUMN IF NOT EXISTS "project_id" TEXT;

-- 3. FK constraints (idempotent guards)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dpr_project_id_fkey') THEN
    ALTER TABLE "dpr" ADD CONSTRAINT "dpr_project_id_fkey"
      FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inspection_record_project_id_fkey') THEN
    ALTER TABLE "inspection_record" ADD CONSTRAINT "inspection_record_project_id_fkey"
      FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'boq_item_project_id_fkey') THEN
    ALTER TABLE "boq_item" ADD CONSTRAINT "boq_item_project_id_fkey"
      FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE SET NULL;
  END IF;
END $$;

-- 4. Indexes (idempotent)
CREATE INDEX IF NOT EXISTS "dpr_project_id_idx" ON "dpr" ("project_id");
CREATE INDEX IF NOT EXISTS "inspection_record_project_id_idx" ON "inspection_record" ("project_id");
CREATE INDEX IF NOT EXISTS "boq_item_project_id_idx" ON "boq_item" ("project_id");

-- 5. BoqItem unique INDEX rebuild.
-- The original migration attempted:
--   ALTER TABLE "boq_item" DROP CONSTRAINT IF EXISTS "boq_item_project_name_item_code_key"
-- but the constraint name in the N7 migration is an INDEX, not a CONSTRAINT
-- (see 20260905020000_n7_boq_items/migration.sql line 84: CREATE UNIQUE INDEX
-- "boq_item_project_name_item_code_key"). DROP CONSTRAINT was a silent no-op.
-- So we DROP INDEX IF EXISTS here (correct API) and rebuild on (project_id, item_code).
DROP INDEX IF EXISTS "boq_item_project_name_item_code_key";
CREATE UNIQUE INDEX IF NOT EXISTS "boq_item_project_id_item_code_key"
  ON "boq_item" ("project_id", "item_code");

-- 6. Backfill project_id from project_name — CORRECTED column names.
-- dpr / inspection_record use camelCase quoted "projectName"
-- (no @map on the schema field).
-- boq_item uses snake_case quoted "project_name" (@map("project_name")).
UPDATE "dpr" d
SET "project_id" = p.id
FROM "project" p
WHERE LOWER(TRIM(p.name)) = LOWER(TRIM(d."projectName"))
  AND d."project_id" IS NULL;

UPDATE "inspection_record" i
SET "project_id" = p.id
FROM "project" p
WHERE LOWER(TRIM(p.name)) = LOWER(TRIM(i."projectName"))
  AND i."project_id" IS NULL;

UPDATE "boq_item" b
SET "project_id" = p.id
FROM "project" p
WHERE LOWER(TRIM(p.name)) = LOWER(TRIM(b."project_name"))
  AND b."project_id" IS NULL;
