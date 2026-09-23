-- ─────────────────────────────────────────────────────────────────────────────
-- DocumentCategory — subject-matter classifier for ProjectAttachment uploads.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Trigger:
--   ProjectAttachment's existing classifier (`type`, ProjectReportType:
--   WEEKLY_REPORT / MONTHLY_REPORT / DUE_DILIGENCE_REPORT / QUALITY_REPORT /
--   OTHER) describes REPORT CADENCE — not document subject. Engineers
--   need to file one-off construction artefacts (client approvals,
--   procurement docs, contracts, handover packages, etc.) that have nothing
--   to do with weekly / monthly cadence, and the admin review queue was
--   either blocking them on a "pick a report type" prompt or letting them
--   tag a contract as OTHER (indistinguishable from an unstructured
--   "Other report"). This round adds a parallel, ORTHOGONAL classifier.
--
-- Effect (1 enum + 1 nullable column + 1 composite index, additive —
-- zero destructive change to existing rows or schema):
--
--   1. New enum `DocumentCategory` with 8 values:
--        CLIENT_APPROVALS_DELIVERABLES    – client sign-offs, deliverables
--        DESIGN_DRAWINGS                  – design-stage drawings (issued
--                                           for construction, shop dwgs)
--        COST_BOQ                         – cost estimates, BOQ revisions
--        PROCUREMENT_VENDOR               – vendor POs, delivery challans
--        SITE_PROGRESS_INSPECTIONS        – site progress reports,
--                                           inspection records (non-DPR)
--        QUALITY_SAFETY                   – QA/QC docs, safety reports
--        CONTRACTS_CHANGE_ORDERS          – contract amendments, VO/SC
--        HANDOVER_CLOSEOUT                – snag lists, as-built, manuals
--
--   2. New column on `project_attachment`:
--        category  "DocumentCategory"  — NULL on legacy rows. The new
--                                        upload path sets it explicitly;
--                                        the existing Weekly / Monthly /
--                                        Due Diligence / Quality / Other
--                                        report flow leaves it NULL.
--                                        `type` stays REQUIRED and
--                                        unchanged — category is a
--                                        parallel field, not a replacement.
--
--   3. New composite index (projectId, category, deletedAt) — matches
--      the per-project ?category= filter shape. Postgres uses the left
--      prefix for the unfiltered list too (existing
--      project_attachment_project_id_type_deleted_at_idx mirrors this
--      for the type column).
--
-- Orthogonality guarantees (the explicit non-destructive contract):
--   - `type`           — UNCHANGED column, UNCHANGED enum, NOT NULL.
--   - `status`         — UNCHANGED column, UNCHANGED enum, NOT NULL.
--   - `ProjectReportType`        — NOT touched.
--   - `ProjectAttachmentStatus`  — NOT touched.
--   - Existing weekly / monthly / due-diligence / quality uploads keep
--     `category = NULL` and the entire admin review state machine
--     keeps working without code changes to the review PATCH handler.
--   - New-category uploads go through the SAS pipeline exactly as
--     before (no RLS change, no blob-storage change); only the POST
--     payload gains an optional `category` field.
--
-- Reversibility: dropping the new column + new enum + new index is a
-- 3-statement DROP (DROP INDEX, DROP COLUMN, DROP TYPE) — leaves the
-- existing ProjectAttachment table byte-for-byte as it is today.
--
-- Idempotency: every step guards with pg_type / pg_attribute /
-- pg_indexes so a re-run on a DB that already has the schema is a
-- no-op (matches the S7 / R35 / R37 / DR-021 migration convention).
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. New enum (8 values).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DocumentCategory') THEN
    CREATE TYPE "DocumentCategory" AS ENUM (
      'CLIENT_APPROVALS_DELIVERABLES',
      'DESIGN_DRAWINGS',
      'COST_BOQ',
      'PROCUREMENT_VENDOR',
      'SITE_PROGRESS_INSPECTIONS',
      'QUALITY_SAFETY',
      'CONTRACTS_CHANGE_ORDERS',
      'HANDOVER_CLOSEOUT'
    );
  END IF;
END $$;

-- 2. New nullable column. NULL on every existing row — the legacy
-- Weekly / Monthly / Due Diligence / Quality uploads stay exactly as
-- they are, and the new category chip path sets it explicitly on insert.
ALTER TABLE "project_attachment"
  ADD COLUMN IF NOT EXISTS "category" "DocumentCategory";

-- 3. New composite index. Matches the WHERE shape
-- (project_id, category, deleted_at IS NULL) used by the per-project
-- GET ?category= filter; Postgres uses the (project_id) prefix for
-- the unfiltered list, so this index doesn't duplicate the existing
-- project_id_type_deleted_at_idx — the two cover disjoint filter
-- shapes.
CREATE INDEX IF NOT EXISTS "project_attachment_project_id_category_deleted_at_idx"
  ON "project_attachment" ("project_id", "category", "deleted_at");