-- ─────────────────────────────────────────────────────────────────────────────
-- R37: COP / Billing Certification Register
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Internal-only ledger that records the certification result of contractor
-- RA-bill (COP) submissions per project. The portal does NOT compute the bill —
-- engineers compute that offline (Excel-based) and enter the result here so
-- we have a single in-portal history of "what was certified for whom, on
-- what date, against which PO".
--
-- Field choices were validated against the actual ACS RA-bill email archive
-- (LEVIM / PONNI CONSTRUCTIONS COPs). Contractor is free-text because no
-- Contractor/Vendor master exists today; billNumber is the audit key.
--
-- One new enum + one new table. No FK back-references to alter (back-
-- relations are declared on the Employee + Project sides only, and the
-- existing migrations already include the columns referenced by the
-- FK constraints below).
--
-- Idempotency: every step guards with pg_type / pg_constraint / IF NOT
-- EXISTS so a re-run on a DB that already has the schema is a no-op
-- (matches the R35 / N3 / N7 migration convention).
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. New enum
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'BillingCertificationStatus') THEN
    CREATE TYPE "BillingCertificationStatus" AS ENUM (
      'DRAFT',
      'CERTIFIED',
      'DISPUTED'
    );
  END IF;
END $$;

-- 2. New table: billing_certification
CREATE TABLE IF NOT EXISTS "billing_certification" (
  "id"               TEXT PRIMARY KEY,
  "project_id"       TEXT NOT NULL,
  "contractor_name"  VARCHAR(160) NOT NULL,
  "bill_number"      VARCHAR(60) NOT NULL,
  "bill_date"        DATE NOT NULL,
  "invoice_no"       VARCHAR(60),
  "po_contract_ref"  VARCHAR(120),
  "claimed_amount"   DECIMAL(15, 2) NOT NULL,
  "deducted_amount"  DECIMAL(15, 2) NOT NULL DEFAULT 0,
  "certified_amount" DECIMAL(15, 2) NOT NULL,
  "gst_amount"       DECIMAL(15, 2),
  "po_value"         DECIMAL(15, 2),
  "balance_value"    DECIMAL(15, 2),
  "remarks"          TEXT,
  "status"           "BillingCertificationStatus" NOT NULL DEFAULT 'DRAFT',
  "recorded_by_id"   TEXT NOT NULL,
  "certified_by_id"  TEXT,
  "certified_at"     TIMESTAMP(3),
  "disputed_at"      TIMESTAMP(3),
  "dispute_reason"   TEXT,
  "filename"         VARCHAR(512),
  "content_type"     VARCHAR(120),
  "size_bytes"       INTEGER,
  "blob_path"        VARCHAR(1024),
  "uploaded_at"      TIMESTAMP(3),
  "deleted_at"       TIMESTAMP(3),
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 3. FKs (idempotent).
--   - projectId     CASCADE   (a COP IS the project record; same contract as
--                              VariationOrder — un-registering a project
--                              sweeps its COPs).
--   - recordedById  RESTRICT  (mirrors BoqItem.createdById — deleting an
--                              employee who recorded a COP is a business
--                              operation, not a silent cascade).
--   - certifiedById SET NULL  (audit trail, must not cascade; mirrors
--                              VariationOrder.approvedById).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_certification_project_id_fkey') THEN
    ALTER TABLE "billing_certification"
      ADD CONSTRAINT "billing_certification_project_id_fkey"
      FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_certification_recorded_by_id_fkey') THEN
    ALTER TABLE "billing_certification"
      ADD CONSTRAINT "billing_certification_recorded_by_id_fkey"
      FOREIGN KEY ("recorded_by_id") REFERENCES "employees"("id") ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_certification_certified_by_id_fkey') THEN
    ALTER TABLE "billing_certification"
      ADD CONSTRAINT "billing_certification_certified_by_id_fkey"
      FOREIGN KEY ("certified_by_id") REFERENCES "employees"("id") ON DELETE SET NULL;
  END IF;
END $$;

-- 4. Indexes (idempotent). Hot reads:
--   - per-project admin registry: (projectId, status, deletedAt)
--   - per-project timeline newest-first: (projectId, billDate)
--   - contractor scope ("show me all COPs from Levim"): (contractorName)
--   - admin queue by status: (status, deletedAt)
CREATE INDEX IF NOT EXISTS "billing_certification_project_id_status_deleted_at_idx"
  ON "billing_certification" ("project_id", "status", "deleted_at");
CREATE INDEX IF NOT EXISTS "billing_certification_project_id_bill_date_idx"
  ON "billing_certification" ("project_id", "bill_date");
CREATE INDEX IF NOT EXISTS "billing_certification_contractor_name_idx"
  ON "billing_certification" ("contractor_name");
CREATE INDEX IF NOT EXISTS "billing_certification_status_deleted_at_idx"
  ON "billing_certification" ("status", "deleted_at");
