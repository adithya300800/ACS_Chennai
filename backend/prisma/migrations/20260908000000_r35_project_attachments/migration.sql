-- ─────────────────────────────────────────────────────────────────────────────
-- R35: Project Reports — file attachments per project
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Field engineers (and admins) attach weekly / monthly / due-diligence /
-- quality / other documents to a project so there's an in-portal trail of
-- "what was filed against this project when". The My Projects accordion
-- (Round-33) renders this as a 6th sub-section alongside DPR / Inspection
-- / Drawing / BOQ.
--
-- Design notes:
--
--   * `ProjectReportType` is a 5-value enum (WEEKLY_REPORT,
--     MONTHLY_REPORT, DUE_DILIGENCE_REPORT, QUALITY_REPORT, OTHER).
--     Matches the convention of DPRStatus / TrainingProvider /
--     TrainingEnrollmentStatus / TrainingPriority. Adding a 6th value
--     later is a one-line enum change.
--
--   * `deletedAt` is the first soft-delete timestamp column in the
--     schema. The previous convention (status: ACTIVE|SUPERSEDED) is
--     revision-semantic for Drawing — not a fit for Report, where the
--     natural lifecycle is just exists/deleted and the audit needs the
--     deletion timestamp.
--
--   * Cascade on projectId: un-registering a project sweeps its
--     attachments (same as Drawing — register is metadata, not history).
--   * SetNull on uploadedById: deleting an admin must not orphan the
--     "who uploaded this" audit trail (same as Drawing.issuedById).
--
--   * Idempotency: CREATE TYPE guards against re-running on a DB that
--     has the type already (defence-in-depth for partial deploys).
--     CREATE TABLE IF NOT EXISTS + DO $$ blocks for FKs + indexes,
--     matching the N3 / N7 / N1 Project FK migration convention.
--
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. New enum
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ProjectReportType') THEN
    CREATE TYPE "ProjectReportType" AS ENUM (
      'WEEKLY_REPORT',
      'MONTHLY_REPORT',
      'DUE_DILIGENCE_REPORT',
      'QUALITY_REPORT',
      'OTHER'
    );
  END IF;
END $$;

-- 2. New table: project_attachment
CREATE TABLE IF NOT EXISTS "project_attachment" (
  "id"              TEXT PRIMARY KEY,
  "project_id"      TEXT NOT NULL,
  "type"            "ProjectReportType" NOT NULL,
  "title"           TEXT,
  "filename"        TEXT NOT NULL,
  "content_type"    TEXT NOT NULL,
  "size_bytes"      INTEGER NOT NULL,
  "blob_path"       TEXT NOT NULL,
  "uploaded_by_id"  TEXT,
  "uploaded_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted_at"      TIMESTAMP(3)
);

-- 3. FKs (idempotent)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_attachment_project_id_fkey') THEN
    ALTER TABLE "project_attachment"
      ADD CONSTRAINT "project_attachment_project_id_fkey"
      FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_attachment_uploaded_by_id_fkey') THEN
    ALTER TABLE "project_attachment"
      ADD CONSTRAINT "project_attachment_uploaded_by_id_fkey"
      FOREIGN KEY ("uploaded_by_id") REFERENCES "employees"("id") ON DELETE SET NULL;
  END IF;
END $$;

-- 4. Indexes (idempotent). Index order matches the WHERE shape of the
--    list endpoint: (projectId, type, deletedAt) covers both the
--    unfiltered list and the ?type filter.
CREATE INDEX IF NOT EXISTS "project_attachment_project_id_type_deleted_at_idx"
  ON "project_attachment" ("project_id", "type", "deleted_at");
CREATE INDEX IF NOT EXISTS "project_attachment_uploaded_by_id_idx"
  ON "project_attachment" ("uploaded_by_id");
