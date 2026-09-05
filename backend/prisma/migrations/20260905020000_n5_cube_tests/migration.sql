-- N5 (round-29): Cube-test integration — link concrete-pour DPRs to their
-- 7-day / 28-day compression-test results.
--
-- What this migration adds
-- ─────────────────────────
-- One new table: `cube_test`. Mirrors the Prisma `CubeTest` model declared
-- in prisma/schema.prisma. The Prisma model uses `@@map("cube_test")`
-- (singular) — same convention as `dpr`, `inspection_record`,
-- `training_enrollment`, `upload_intent` etc. Always quote the @@map
-- name; the previous S3-6 typo (model name `@@map("training_enrollment")
-- but SQL wrote `training_enrollments`) is the lesson behind the
-- append-only rule on every migration in this repo.
--
-- Columns:
--   id                       TEXT        PK
--   casting_record_id        TEXT        FK -> inspection_record(id) ON DELETE SET NULL
--   dpr_id                   TEXT        FK -> dpr(id)                ON DELETE SET NULL
--   pour_location            TEXT        NOT NULL
--   concrete_grade           TEXT        NOT NULL
--   cast_date                DATE        NOT NULL
--   seven_day_due_date       DATE        NOT NULL
--   twenty_eight_day_due_date DATE       NOT NULL
--   seven_day_result         DOUBLE PRECISION  NULL
--   seven_day_tested_at      TIMESTAMP(3) NULL
--   twenty_eight_day_result  DOUBLE PRECISION  NULL
--   twenty_eight_day_tested_at TIMESTAMP(3) NULL
--   expected_strength        DOUBLE PRECISION NOT NULL
--   status                   TEXT        NOT NULL DEFAULT 'PENDING'
--   submitted_by_id          TEXT        FK -> employees(id) (no cascade)
--   notes                    TEXT        NULL
--   created_at               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
--   updated_at               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
--
-- Indexes (mirror the @@index declarations on the model):
--   (cast_date)                       — calendar timeline read
--   (twenty_eight_day_due_date)       — 28-day due-soon endpoint
--   (status)                          — admin queue by status
--   (dpr_id, status)                  — pour-summary GROUP BY status
--
-- Idempotency
-- ───────────
-- CREATE TABLE / CREATE INDEX IF NOT EXISTS (Postgres 9.6+, Supabase 15+)
-- make this migration safe to re-run against a partially-migrated DB —
-- same pattern as 20260904020000_s3_11_admin_digest_run / r25 notifications
-- / S3-6 follow-up. DO $$ … ALTER TABLE … ADD CONSTRAINT blocks guard the
-- FKs so a re-run on a DB that already has them short-circuits.
--
-- Why no backfill
-- ───────────────
-- Empty table on roll-out — no historical cube-test rows existed before
-- N5. The first cube_casting inspections filed AFTER deploy will start
-- writing rows here when the create handler is wired in round-30.
--
-- Why append-only
-- ───────────────
-- This migration is `20260905020000` (after every existing migration in
-- the folder). Per repo policy (phase-4-p0-s3-6-typo-and-baseline-hazard
-- memory file): never `prisma migrate resolve --applied`, never edit an
-- existing migration. If this migration lands wrong, fix it with a new
-- migration, not by rewriting this one.

CREATE TABLE IF NOT EXISTS "cube_test" (
  "id"                          TEXT             NOT NULL,
  "casting_record_id"           TEXT,
  "dpr_id"                      TEXT,
  "pour_location"               TEXT             NOT NULL,
  "concrete_grade"              TEXT             NOT NULL,
  "cast_date"                   DATE             NOT NULL,
  "seven_day_due_date"          DATE             NOT NULL,
  "twenty_eight_day_due_date"   DATE             NOT NULL,
  "seven_day_result"            DOUBLE PRECISION,
  "seven_day_tested_at"         TIMESTAMP(3),
  "twenty_eight_day_result"     DOUBLE PRECISION,
  "twenty_eight_day_tested_at"  TIMESTAMP(3),
  "expected_strength"           DOUBLE PRECISION NOT NULL,
  "status"                      TEXT             NOT NULL DEFAULT 'PENDING',
  "submitted_by_id"             TEXT             NOT NULL,
  "notes"                       TEXT,
  "created_at"                  TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                  TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cube_test_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "cube_test_cast_date_idx"
  ON "cube_test" ("cast_date");

CREATE INDEX IF NOT EXISTS "cube_test_twenty_eight_day_due_date_idx"
  ON "cube_test" ("twenty_eight_day_due_date");

CREATE INDEX IF NOT EXISTS "cube_test_status_idx"
  ON "cube_test" ("status");

CREATE INDEX IF NOT EXISTS "cube_test_dpr_id_status_idx"
  ON "cube_test" ("dpr_id", "status");

-- FKs added in DO $$ blocks so a re-run on a DB where they already exist
-- is a no-op (information_schema.table_constraints lookup). Postgres
-- rejects ADD CONSTRAINT referencing missing columns, so the CREATE TABLE
-- above must run before these blocks.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'cube_test_casting_record_id_fkey'
      AND table_name = 'cube_test'
  ) THEN
    ALTER TABLE "cube_test"
      ADD CONSTRAINT "cube_test_casting_record_id_fkey"
      FOREIGN KEY ("casting_record_id") REFERENCES "inspection_record"("id")
      ON DELETE SET NULL
      ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'cube_test_dpr_id_fkey'
      AND table_name = 'cube_test'
  ) THEN
    ALTER TABLE "cube_test"
      ADD CONSTRAINT "cube_test_dpr_id_fkey"
      FOREIGN KEY ("dpr_id") REFERENCES "dpr"("id")
      ON DELETE SET NULL
      ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'cube_test_submitted_by_id_fkey'
      AND table_name = 'cube_test'
  ) THEN
    ALTER TABLE "cube_test"
      ADD CONSTRAINT "cube_test_submitted_by_id_fkey"
      FOREIGN KEY ("submitted_by_id") REFERENCES "employees"("id")
      ON DELETE RESTRICT
      ON UPDATE CASCADE;
  END IF;
END $$;
