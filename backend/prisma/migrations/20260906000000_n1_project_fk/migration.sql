-- ─────────────────────────────────────────────────────────────────────────────
-- N1 (Phase-A) — Project FK swap on DPR / InspectionRecord / BoqItem
-- ─────────────────────────────────────────────────────────────────────────────
--
-- WHY THIS MIGRATION EXISTS
--
-- Until N1, every record that referenced a project did so by free-text:
-- DPR.projectName, InspectionRecord.projectName, BoqItem.projectName. That
-- was a deliberate half-step (Project master was an N1/XL — out of scope
-- until now). The free-text shape worked while there was one Project, but
-- it's the wrong contract now that the Project Master exists:
--
--   - Free-text can drift ("T-Nagar Phase II" vs "T-Nagar Phase 2" vs
--     "T-Nagar / Phase II" all group differently in a KPI roll-up).
--   - There's no linkable id, so a BOQ variance report and a DPR/Inspection
--     KPI endpoint cannot join on the same row.
--   - Renaming a Project is a full-table rewrite + every downstream
--     reports break.
--
-- N1 swaps the free-text column for a nullable `project_id` FK to the new
-- Project master. The free-text column STAYS (denormalized) so:
--
--   - Legacy rows that never had a curated Project match keep their
--     `projectName` value (NULL projectId is acceptable; the route layer
--     reconciles on next write — see dpr.js / inspection.js POST handlers).
--   - The KPI / variance reports that today GROUP BY projectName keep
--     working without a parallel migration. The KPI endpoint already groups
--     on the free-text column; it does not need the FK to compute counts.
--   - Auto-discovery on the projects list endpoint keeps working (it
--     scrapes DPR.projectName for distinct values not in the Project table).
--
-- WHY BOQITEM DROPS THE OLD UNIQUE
--
-- The old `@@unique([projectName, itemCode])` keyed uniqueness on the
-- free-text column. With the new FK, the unique must key on
-- (projectId, itemCode) — `itemCode` (e.g. "2.3.1") is the BOQ convention,
-- and uniqueness is per-project. Postgres treats NULLs as DISTINCT by
-- default (NULLS DISTINCT), so multiple legacy BoqItem rows with
-- projectId=NULL + same itemCode do NOT collide — preserving the legacy
-- data shape after the swap.
--
-- BACKFILL STRATEGY
--
-- `UPDATE … FROM "project" p WHERE LOWER(TRIM(p.name)) = LOWER(TRIM(d."project_name"))`
-- matches by case-insensitive trimmed equality. The user's explicit
-- decision: the next submit/PATCH that goes through the route layer will
-- reconcile any rows left with projectId=NULL against the live Project
-- table via projects.js resolveProject(). The migration only matches
-- existing curated rows — we do NOT auto-create Project rows from DPR /
-- Inspection / / Boq free-text here because that conflates curation
-- (admin-only) with backfill (mechanical) and risks importing typos.
--
-- ON DELETE SET NULL
--
-- The FKs use ON DELETE SET NULL (not CASCADE) on every child because the
-- soft-delete contract on Project is `isActive=false` (a Project row stays
-- in the table forever). ON DELETE SET NULL is for the rare hard-delete
-- case — it ensures the audit trail of historical DPR / Inspection / / BOQ
-- rows survives even if the Project row is hard-deleted by an operator.
--
-- ─────────────────────────────────────────────────────────────────────────────

-- Widen project (N1 metadata)
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "parties" JSONB;
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "contract_value" NUMERIC(15,2);
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "sites" JSONB;
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "description" TEXT;

-- DPR project_id
ALTER TABLE "dpr" ADD COLUMN IF NOT EXISTS "project_id" TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dpr_project_id_fkey') THEN
    ALTER TABLE "dpr" ADD CONSTRAINT "dpr_project_id_fkey"
      FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "dpr_project_id_idx" ON "dpr" ("project_id");

-- InspectionRecord project_id
ALTER TABLE "inspection_record" ADD COLUMN IF NOT EXISTS "project_id" TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inspection_record_project_id_fkey') THEN
    ALTER TABLE "inspection_record" ADD CONSTRAINT "inspection_record_project_id_fkey"
      FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "inspection_record_project_id_idx" ON "inspection_record" ("project_id");

-- BoqItem: drop old unique, add FK + new unique
ALTER TABLE "boq_item" DROP CONSTRAINT IF EXISTS "boq_item_project_name_item_code_key";
ALTER TABLE "boq_item" ADD COLUMN IF NOT EXISTS "project_id" TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'boq_item_project_id_fkey') THEN
    ALTER TABLE "boq_item" ADD CONSTRAINT "boq_item_project_id_fkey"
      FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE SET NULL;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "boq_item_project_id_item_code_key"
  ON "boq_item" ("project_id", "item_code");
CREATE INDEX IF NOT EXISTS "boq_item_project_id_idx" ON "boq_item" ("project_id");

-- Backfill project_id from project_name (case-insensitive trim)
UPDATE "dpr" d SET "project_id" = p.id
  FROM "project" p
  WHERE LOWER(TRIM(p.name)) = LOWER(TRIM(d."project_name"))
    AND d."project_id" IS NULL;

UPDATE "inspection_record" i SET "project_id" = p.id
  FROM "project" p
  WHERE LOWER(TRIM(p.name)) = LOWER(TRIM(i."project_name"))
    AND i."project_id" IS NULL;

UPDATE "boq_item" b SET "project_id" = p.id
  FROM "project" p
  WHERE LOWER(TRIM(p.name)) = LOWER(TRIM(b."project_name"))
    AND b."project_id" IS NULL;