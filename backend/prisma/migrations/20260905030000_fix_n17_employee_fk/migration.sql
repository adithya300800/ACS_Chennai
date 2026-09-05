-- Fix for the failed `20260905020000_n17_projects` migration.
--
-- The original N17 migration referenced `REFERENCES "employee"("id")` (singular),
-- but the Employee model is `@map("employees")` (plural). Postgres rejected the
-- CREATE TABLE because the referenced table didn't exist, so Prisma recorded
-- the migration as FAILED in `_prisma_migrations` and is now blocking every
-- subsequent deploy with P3009 "migrate found failed migrations".
--
-- This is the EXACT hazard the project documented in
--   memory/phase-4-p0-s3-6-typo-and-baseline-hazard.md
-- under "Fix: append a new migration, never rewrite the old." We:
--   1. Append a fresh migration (this file).
--   2. Will run `prisma migrate resolve --rolled-back 20260905020000_n17_projects`
--      after deploy so Prisma stops gating on the failed row.
--
-- CREATE TABLE IF NOT EXISTS is safe in either branch:
--   • Original migration's transaction rolled back (no `project` table) →
--     this creates it fresh with the correct `employees` FK.
--   • Original migration's CREATE TABLE succeeded before the FK error
--     (it shouldn't have — Postgres validates FKs at table creation —
--     but IF NOT EXISTS is still defensive in case the operator partially
--     ran the SQL by hand) → this is a no-op.
--
-- Same FK hygiene as the original: created_by_id → employees.id, ON DELETE
-- SET NULL so deleting the creator admin doesn't destroy the audit trail
-- (created_at + name survive).
--
-- N17's larger dependency chain (BOQ.dpr / inspection_record FKs, project
-- back-relations on DPR / InspectionRecord / CubeTest) was all handled in
-- `20260905020000_n7_boq_items` and `20260905020000_n5_cube_tests`, both of
-- which use the corrected `employees` reference. The N17 migration is the
-- only one that needed this fix.

CREATE TABLE IF NOT EXISTS "project" (
  "id"                TEXT         NOT NULL,
  "name"              TEXT         NOT NULL,
  "code"              TEXT,
  "client"            TEXT,
  "location"          TEXT,
  "is_active"         BOOLEAN      NOT NULL DEFAULT TRUE,
  "start_date"        DATE,
  "expected_end_date" DATE,
  "created_by_id"     TEXT,
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_name_key" UNIQUE ("name"),
  CONSTRAINT "project_code_key" UNIQUE ("code"),
  CONSTRAINT "project_created_by_id_fkey"
    FOREIGN KEY ("created_by_id")
    REFERENCES "employees"("id")     -- ← FIXED: was "employee" (singular) in the failed migration
    ON DELETE SET NULL
    ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "project_is_active_idx"
  ON "project" ("is_active");
