-- [REPORT-S3-11] Admin-targeted daily attendance digest bookkeeping.
--
-- ── The double-fire class this closes ─────────────────────────────────────
--
-- The admin attendance digest cron (POST /api/internal/attendance/digest/run)
-- is exposed to manual re-fire via GitHub Actions `workflow_dispatch` on
-- `cron-admin-emails.yml`. Before this migration the route handler at
-- backend/src/routes/internal-admin-attendance.js acknowledged (in its
-- own header) that it had no application-layer idempotency — the digests
-- were treated as read-only and idempotent by construction, "so a
-- double-fire on the same date is harmless".
--
-- That reasoning is wrong on two counts:
--   1. The digests are NOT read-only — every per-admin send writes an
--      EmailLog row + (now) triggers a Resend API call. A double-fire
--      re-emails every admin who has not opted out / muted the type.
--   2. A cron job that fires twice within seconds (workflow_dispatch
--      re-firing while the scheduled run is still mid-loop) was
--      genuinely undetectable from logs — every send looked like a
--      legitimate first fire.
--
-- The SOL production-readiness review flagged this gap as S3-11 (the
-- "Related" note under S3-10 in
-- `Code review by SOL/ACS-Portal-Go-Private-Readiness-Review.md`).
--
-- ── What this migration adds ──────────────────────────────────────────────
--
-- One new table: `admin_digest_run`. One row per (admin, scheduledFor)
-- for the lifetime of the digest cycle. The @@unique constraint is the
-- idempotency key — the route handler does an atomic create + P2002
-- catch per admin (mirror of the DigestRun race-safety pattern at
-- backend/src/routes/internal-digest.js:417-454), so a second fire on
-- the same (admin, date) is a no-op.
--
-- Lifecycle columns (status):
--   PENDING            — claimed by an in-flight fire
--   SENT               — email dispatch succeeded
--   SKIPPED_OPT_OUT    — admin has emailEnabled=false
--   SKIPPED_TYPE_MUTED — admin muted ADMIN_ATTENDANCE_DAILY
--   SKIPPED_NO_ADDRESS — admin row has no email address
--   FAILED             — sendEmail returned ok:false
--
-- email_log_id mirrors DigestRun's nullable + UNIQUE contract: at most
-- one AdminDigestRun can point at a given EmailLog row. SetNull on
-- delete keeps audit pruning independent of bookkeeping pruning.
--
-- ── Idempotency of THIS migration ────────────────────────────────────────
--
-- `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`,
-- `CREATE UNIQUE INDEX IF NOT EXISTS`, and `ALTER TABLE ... ADD CONSTRAINT
-- IF NOT EXISTS` (PG ≥ 9.6 — Supabase is 15.x) make this file safe to
-- re-run against a partially-migrated DB. Pattern mirrors the r25
-- notifications / S3-6 / S3-7 migrations.
--
-- Backfill: none. The table starts empty; no historical digests were
-- tracked, and the cron only fires going forward.
--
-- Cleanup: out of scope for this PR. A future round adds a 90-day
-- prune sweep (volume is bounded — O(admins × days)).

CREATE TABLE IF NOT EXISTS "admin_digest_run" (
  "id"             TEXT         NOT NULL,
  "admin_id"       TEXT         NOT NULL,
  "scheduled_for"  TIMESTAMP(3) NOT NULL,
  "status"         TEXT         NOT NULL DEFAULT 'PENDING',
  "email_log_id"   TEXT,
  "error_message"  TEXT,
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "admin_digest_run_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "admin_digest_run_admin_id_scheduled_for_key"
  ON "admin_digest_run" ("admin_id", "scheduled_for");

CREATE UNIQUE INDEX IF NOT EXISTS "admin_digest_run_email_log_id_key"
  ON "admin_digest_run" ("email_log_id");

CREATE INDEX IF NOT EXISTS "admin_digest_run_scheduled_for_idx"
  ON "admin_digest_run" ("scheduled_for");

-- FKs after the CREATE TABLE so the columns are guaranteed to exist
-- (Postgres rejects ADD CONSTRAINT referencing missing columns).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'admin_digest_run_admin_id_fkey'
      AND table_name = 'admin_digest_run'
  ) THEN
    ALTER TABLE "admin_digest_run"
      ADD CONSTRAINT "admin_digest_run_admin_id_fkey"
      FOREIGN KEY ("admin_id") REFERENCES "employees"("id")
      ON DELETE CASCADE
      ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'admin_digest_run_email_log_id_fkey'
      AND table_name = 'admin_digest_run'
  ) THEN
    ALTER TABLE "admin_digest_run"
      ADD CONSTRAINT "admin_digest_run_email_log_id_fkey"
      FOREIGN KEY ("email_log_id") REFERENCES "email_log"("id")
      ON DELETE SET NULL
      ON UPDATE CASCADE;
  END IF;
END $$;
