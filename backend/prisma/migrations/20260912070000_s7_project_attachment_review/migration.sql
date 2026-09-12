-- ─────────────────────────────────────────────────────────────────────────────
-- S7/MyReports — admin review of project attachments
-- ─────────────────────────────────────────────────────────────────────────────
--
-- User feedback (2026-09-12): the Project Reports page exposes upload + list
-- + download + delete, but admins cannot Approve / Request Revision / Reject
-- a submitted report — the action bar exists in concept (R35 surfaced the
-- per-project file as a reviewable artefact) but never landed the review
-- state machine. Today every uploaded report sits in the same implicit
-- "unreviewed" state forever.
--
-- Trigger:
--   `src/pages/portal/MyProjectReports.jsx` is the new cross-project employee
--   surface for weekly / monthly / due-diligence / quality uploads. Admins
--   reviewing that page need a one-click state change with an optional reason
--   (mirrors InspectionDetail's admin action bar pattern, R36).
--
-- Effect (4 columns + 1 enum + 1 nullable index, additive — no destructive
-- change to existing rows):
--
--   1. New enum `ProjectAttachmentStatus` with four states:
--        PENDING_REVIEW     — initial state on upload (default for new rows)
--        APPROVED           — admin accepted; closes the review
--        REVISION_REQUESTED — admin wants changes; carries reviewNotes
--        REJECTED           — admin rejected; carries reviewNotes
--
--   2. New columns on `project_attachment`:
--        status         ProjectAttachmentStatus NOT NULL DEFAULT PENDING_REVIEW
--        reviewed_by_id TEXT (FK → employee.id, SetNull)
--        reviewed_at    TIMESTAMP(3)
--        review_notes   TEXT  (optional reason for REVISION_REQUESTED + REJECTED)
--
--   3. Backfill: existing rows are stamped PENDING_REVIEW so the new NOT
--      NULL column has a value on every row. The DEFAULT clause also covers
--      this — the backfill UPDATE is belt-and-braces for clarity in the
--      audit log.
--
--   4. New relation `ProjectAttachmentReviewer` on Employee side. Back-
--      relation declared at schema.prisma:70-71. SetNull on the FK so
--      deleting an admin does not orphan the "who reviewed this" audit —
--      same contract as `uploadedBy`.
--
-- Rollout: forward-only. New uploads auto-default to PENDING_REVIEW (the
-- server's POST handler doesn't need to set it explicitly). The PATCH
-- endpoint validates the state machine and stamps reviewed_by_id +
-- reviewed_at + review_notes in the same transaction. No backfill of
-- reviewer notes (legacy rows have no notes; that's accurate).
--
-- Idempotency: every step guards with pg_type / pg_constraint / IF NOT
-- EXISTS so a re-run on a DB that already has the schema is a no-op
-- (matches the R35 / R37 / DR-021 migration convention).
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. New enum
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ProjectAttachmentStatus') THEN
    CREATE TYPE "ProjectAttachmentStatus" AS ENUM (
      'PENDING_REVIEW',
      'APPROVED',
      'REVISION_REQUESTED',
      'REJECTED'
    );
  END IF;
END $$;

-- 2. New columns (additive). DEFAULT PENDING_REVIEW so existing rows get
-- a valid value the moment the column is added — Prisma applies the
-- default at INSERT time, but the ALTER TABLE default covers rows that
-- already exist at deploy time.
ALTER TABLE "project_attachment"
  ADD COLUMN IF NOT EXISTS "status"           "ProjectAttachmentStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
  ADD COLUMN IF NOT EXISTS "reviewed_by_id"   TEXT,
  ADD COLUMN IF NOT EXISTS "reviewed_at"      TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "review_notes"     TEXT;

-- Belt-and-braces backfill — the DEFAULT in ALTER TABLE covers existing
-- rows on most PG versions but the explicit UPDATE makes the intent
-- visible in the migration log and survives any future tooling that
-- strips column defaults.
UPDATE "project_attachment"
   SET "status" = 'PENDING_REVIEW'
 WHERE "status" IS NULL;

-- 3. New FK to employees (SetNull matches the existing uploadedById
-- contract — deleting an admin does not orphan the review audit).
-- NB: the live table is `"employees"` (plural snake_case), NOT `"employee"`
-- or `"Employee"` — see `20260905030000_fix_n17_employee_fk` for the same
-- shape of fix. The original S7 migration shipped with the singular form
-- and failed at deploy time with `42P01: relation "employee" does not exist`.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'project_attachment_reviewed_by_id_fkey'
  ) THEN
    ALTER TABLE "project_attachment"
      ADD CONSTRAINT "project_attachment_reviewed_by_id_fkey"
      FOREIGN KEY ("reviewed_by_id") REFERENCES "employees"("id") ON DELETE SET NULL;
  END IF;
END $$;

-- 4. New index. The per-status filter on the admin review queue
-- (admin "pending review" view) scans by status; an index keeps that
-- read bounded. Composite (status, projectId) matches the most common
-- read shape: "all PENDING_REVIEW rows for project X".
CREATE INDEX IF NOT EXISTS "project_attachment_status_project_id_idx"
  ON "project_attachment" ("status", "project_id");

-- 5. FK index for the reviewer join (mirrors uploaded_by_id pattern).
CREATE INDEX IF NOT EXISTS "project_attachment_reviewed_by_id_idx"
  ON "project_attachment" ("reviewed_by_id");
