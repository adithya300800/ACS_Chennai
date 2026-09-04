-- LPR-003 / Round-25: notification preferences + email audit + digest bookkeeping.
--
-- Context:
--   Round-25 added four Prisma models that already exist in production but
--   have no checked-in migration under prisma/migrations/. They were
--   created by the previous 'prisma db push' workflow before LPR-001
--   converted that path to 'prisma migrate deploy'. Without a checked-in
--   migration, `prisma migrate deploy` on the next deploy would attempt
--   to re-create these tables and fail (or succeed silently with `db push`
--   semantics, but the production contract now requires migrations).
--
--   This file is the canonical DDL for those four tables, written to
--   match the current schema.prisma model definitions EXACTLY:
--
--     model NotificationPreference { employeeId @id @map("employee_id") ... }
--     model EmailLog                { id @id @default(uuid()) ... }
--     model DigestItem              { id @id @default(uuid()) ... }
--     model DigestRun               { id @id @default(uuid()) ... }
--
--   The DDL was authored by hand from schema.prisma (not generated via
--   `prisma migrate diff`) because the models already exist in production
--   without migration history — `migrate diff` would emit empty/no-op SQL
--   or DROP/CREATE churn that would conflict with the live rows.
--
-- Apply instructions (see README in this folder for full context):
--   1. Confirm the four tables ALREADY exist in production by querying
--      the information_schema catalog. If they do NOT exist yet, this
--      migration will create them on first `prisma migrate deploy`.
--   2. If they ALREADY exist (the live case after round-25), do one of:
--        a. Run this migration file manually once, then record it as
--           applied WITHOUT re-executing:
--             npx prisma migrate resolve --applied 20260903010000_r25_notifications
--        b. Or run this file's DDL wrapped in `CREATE TABLE IF NOT EXISTS`
--           semantics (already guarded by IF NOT EXISTS clauses below).
--   3. After the resolve, future deploys that run `prisma migrate deploy`
--      will see this migration as already-applied and skip it.
--
-- Column types and nullability mirror schema.prisma exactly so the
-- Prisma client and the live database stay in lockstep. Default
-- expressions match the schema's `@default(...)` clauses (booleans,
-- now(), '{}'::jsonb, etc.).

-- ============================================================================
-- 1. notification_preference
-- ============================================================================
-- One row per employee. PK = employee_id; FK cascades on Employee delete.
-- type_mutes is JSONB with a `{}` default; digest_hour_local is an int
-- constrained at the API layer (not DB) to 0-23.
CREATE TABLE IF NOT EXISTS "notification_preference" (
  "employee_id"        TEXT        NOT NULL,
  "email_enabled"      BOOLEAN     NOT NULL DEFAULT TRUE,
  "digest_enabled"     BOOLEAN     NOT NULL DEFAULT TRUE,
  "type_mutes"         JSONB       NOT NULL DEFAULT '{}'::"jsonb",
  "digest_hour_local"  INTEGER     NOT NULL DEFAULT 8,
  "updated_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notification_preference_pkey" PRIMARY KEY ("employee_id"),
  CONSTRAINT "notification_preference_employee_id_fkey"
    FOREIGN KEY ("employee_id")
    REFERENCES "employee"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE
);

-- ============================================================================
-- 2. email_log
-- ============================================================================
-- Append-only audit trail for every email dispatch attempt (sent, failed,
-- opted-out, missing-address). notification_id is SetNull so a notification
-- row can be pruned without orphaning the audit.
-- digest_run_id is NOT a column here — the DigestRun → EmailLog FK lives
-- on the digest_run side as `email_log_id` (one EmailLog per DigestRun).
CREATE TABLE IF NOT EXISTS "email_log" (
  "id"                  TEXT         NOT NULL,
  "employee_id"         TEXT         NOT NULL,
  "notification_id"     TEXT,
  "recipient_email"     TEXT         NOT NULL,
  "subject"             TEXT         NOT NULL,
  "channel"             TEXT         NOT NULL,
  "status"              TEXT         NOT NULL,
  "provider_message_id" TEXT,
  "error_message"       TEXT,
  "sent_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "email_log_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "email_log_employee_id_fkey"
    FOREIGN KEY ("employee_id")
    REFERENCES "employee"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE,
  CONSTRAINT "email_log_notification_id_fkey"
    FOREIGN KEY ("notification_id")
    REFERENCES "notification"("id")
    ON DELETE SET NULL
    ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "email_log_employee_id_sent_at_idx"
  ON "email_log" ("employee_id", "sent_at");

CREATE INDEX IF NOT EXISTS "email_log_notification_id_idx"
  ON "email_log" ("notification_id");

CREATE INDEX IF NOT EXISTS "email_log_status_idx"
  ON "email_log" ("status");

-- ============================================================================
-- 3. digest_item
-- ============================================================================
-- One row per (digest_run, notification). The unique constraint on
-- (digest_run_id, notification_id) is the idempotency guarantee against
-- a re-enqueue race.
CREATE TABLE IF NOT EXISTS "digest_item" (
  "id"               TEXT         NOT NULL,
  "digest_run_id"    TEXT         NOT NULL,
  "employee_id"      TEXT         NOT NULL,
  "notification_id"  TEXT         NOT NULL,
  "included_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "digest_item_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "digest_item_digest_run_id_fkey"
    FOREIGN KEY ("digest_run_id")
    REFERENCES "digest_run"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE,
  CONSTRAINT "digest_item_notification_id_fkey"
    FOREIGN KEY ("notification_id")
    REFERENCES "notification"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "digest_item_digest_run_id_notification_id_key"
  ON "digest_item" ("digest_run_id", "notification_id");

CREATE INDEX IF NOT EXISTS "digest_item_employee_id_digest_run_id_idx"
  ON "digest_item" ("employee_id", "digest_run_id");

-- ============================================================================
-- 4. digest_run
-- ============================================================================
-- One row per (employee, scheduled_for). scheduled_for is a business-date
-- key stored at 00:00 IST. status: PENDING | SENT | EMPTY | FAILED.
-- email_log_id is nullable + UNIQUE so at most one DigestRun can point at
-- a given EmailLog (the digest-send success audit row).
CREATE TABLE IF NOT EXISTS "digest_run" (
  "id"             TEXT         NOT NULL,
  "employee_id"    TEXT         NOT NULL,
  "scheduled_for"  TIMESTAMP(3) NOT NULL,
  "status"         TEXT         NOT NULL DEFAULT 'PENDING',
  "email_log_id"   TEXT,
  "error_message"  TEXT,
  "completed_at"   TIMESTAMP(3),
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "digest_run_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "digest_run_employee_id_fkey"
    FOREIGN KEY ("employee_id")
    REFERENCES "employee"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE,
  CONSTRAINT "digest_run_email_log_id_fkey"
    FOREIGN KEY ("email_log_id")
    REFERENCES "email_log"("id")
    ON DELETE SET NULL
    ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "digest_run_employee_id_scheduled_for_key"
  ON "digest_run" ("employee_id", "scheduled_for");

CREATE UNIQUE INDEX IF NOT EXISTS "digest_run_email_log_id_key"
  ON "digest_run" ("email_log_id");

CREATE INDEX IF NOT EXISTS "digest_run_status_idx"
  ON "digest_run" ("status");
