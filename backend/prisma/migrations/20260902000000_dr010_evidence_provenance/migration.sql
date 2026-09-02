-- Round-20 DR-010: training evidence provenance.
--
-- Background: the pre-round-20 schema had one `TrainingStatus` enum with a
-- single `COMPLETED` value that four distinct completion paths all wrote to:
--   1. Employee clicked "Mark complete" (no player data) → SELF_ATTESTED
--   2. YouTube/Vimeo IFrame fired `ended=true` → PLAYER_OBSERVED
--   3. (future) Coursera/Udemy provider webhook → PROVIDER_VERIFIED
--   4. Admin override on the employee's behalf → ADMIN_OVERRIDE
--
-- The admin dashboard presented these indistinguishably as safety/compliance
-- progress, but the backend could not separate "watched to end" from "one-
-- click attestation". Reports, overdue comparisons, and audit trails were
-- all lossy.
--
-- This migration:
--   - Replaces the 3-value `TrainingStatus` enum with an 8-value
--     `TrainingEnrollmentStatus` enum (four completed-states + bookkeeping).
--   - Adds `evidence_class`, `completed_by`, `evidence_metadata`,
--     `provider_session_id` columns to `training_enrollment` for the
--     provenance trail.
--   - Backfills the existing `COMPLETED` rows. Since round-14 only wrote
--     `COMPLETED` via the manual-mark-complete path (round-20 introduced
--     the player-observed and admin-override paths for the first time),
--     legacy `COMPLETED` rows are mapped to `SELF_ATTESTED_COMPLETED` /
--     `SELF_ATTESTED`. This is a deliberately pessimistic default — if a
--     future audit discovers legacy rows that came from the player path,
--     they can be re-classified without re-migrating.

-- 1. New enum ----------------------------------------------------------------
CREATE TYPE "TrainingEnrollmentStatus" AS ENUM (
  'ASSIGNED',
  'IN_PROGRESS',
  'SELF_ATTESTED_COMPLETED',
  'PLAYER_OBSERVED_COMPLETED',
  'PROVIDER_VERIFIED_COMPLETED',
  'ADMIN_OVERRIDE_COMPLETED',
  'OVERDUE',
  'CANCELLED'
);

-- 2. Convert the existing `status` column ------------------------------------
-- Postgres can't ALTER TYPE with a value translation in place, so do it in two
-- steps: add a temp text column, copy with case-mapping, drop old, then re-add
-- as the new enum.
ALTER TABLE "training_enrollment"
  ADD COLUMN "status_new" "TrainingEnrollmentStatus";

UPDATE "training_enrollment"
SET "status_new" = CASE "status"::text
  WHEN 'ASSIGNED'    THEN 'ASSIGNED'::"TrainingEnrollmentStatus"
  WHEN 'IN_PROGRESS' THEN 'IN_PROGRESS'::"TrainingEnrollmentStatus"
  WHEN 'COMPLETED'   THEN 'SELF_ATTESTED_COMPLETED'::"TrainingEnrollmentStatus"
  ELSE 'ASSIGNED'::"TrainingEnrollmentStatus"
END;

ALTER TABLE "training_enrollment"
  DROP COLUMN "status";

ALTER TABLE "training_enrollment"
  RENAME COLUMN "status_new" TO "status";

ALTER TABLE "training_enrollment"
  ALTER COLUMN "status" SET DEFAULT 'ASSIGNED'::"TrainingEnrollmentStatus";

-- 3. Drop the old enum (now unused) -------------------------------------------
DROP TYPE "TrainingStatus";

-- 4. Add the new provenance columns -------------------------------------------
ALTER TABLE "training_enrollment"
  ADD COLUMN "evidence_class"      VARCHAR(40),
  ADD COLUMN "completed_by"        TEXT,
  ADD COLUMN "evidence_metadata"   JSONB,
  ADD COLUMN "provider_session_id" VARCHAR(120);

-- 5. Backfill evidence_class + completed_by for legacy COMPLETED rows --------
--    (the WHERE clause keeps the migration idempotent if rerun on a DB that
--    already had this applied — the column values are guarded.)
UPDATE "training_enrollment"
SET
  "evidence_class" = 'SELF_ATTESTED',
  "completed_by"   = "employee_id"
WHERE "status" = 'SELF_ATTESTED_COMPLETED'
  AND "evidence_class" IS NULL;

-- 6. Indexes -----------------------------------------------------------------
-- Round-20: completion reports filter by evidenceClass; partial index keeps
-- the index narrow (only completed rows have an evidenceClass value).
CREATE INDEX "training_enrollment_evidence_class_idx"
  ON "training_enrollment" ("evidence_class")
  WHERE "evidence_class" IS NOT NULL;
