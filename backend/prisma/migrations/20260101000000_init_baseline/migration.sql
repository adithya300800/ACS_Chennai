-- ============================================================================
-- DR-009 — Reproducible baseline for the ACS Chennai portal schema.
-- ============================================================================
--
-- Audit row:
--   "Code review by SOL/ACS-Portal-Live-Readiness-Review-2026-09-05.md"
--     line 62  — DR-009 | P1 | "Migration history cannot rebuild a clean
--                database and disagrees with mapped schema"
--     line 212 — "DR-009 — Schema and migration history are not a
--                reproducible whole"
--
-- WHY THIS FILE EXISTS
-- --------------------
-- The production schema was bootstrapped with `prisma db push`, and the
-- migrations that were added later were force-adopted with
-- `prisma migrate resolve --applied`. `resolve --applied` writes a row into
-- `_prisma_migrations` WITHOUT executing any SQL, so the checked-in history
-- never contained a statement that creates the BASE tables (`employees`,
-- `dpr`, `attendance`, `notification`, ...). Replaying
-- `backend/prisma/migrations/` against an empty database therefore fails at
-- the first `ALTER TABLE` / FK reference: there is nothing to alter.
--
-- This migration is the missing head of the chain. It is timestamped
-- 20260101000000 — earlier than every other directory in this folder — so
-- `prisma migrate deploy` runs it FIRST on a clean database and the
-- subsequent migrations then have real tables to modify.
--
-- IF NOT EXISTS STRATEGY (why this is safe on the live database)
-- -------------------------------------------------------------
-- Production already has every object below. Re-running this file there must
-- be a strict no-op, so EVERY statement is existence-guarded:
--
--   * tables   -> CREATE TABLE IF NOT EXISTS
--   * indexes  -> CREATE [UNIQUE] INDEX IF NOT EXISTS
--   * enums    -> DO $$ ... EXCEPTION WHEN duplicate_object THEN NULL ... $$
--                 (Postgres has no `CREATE TYPE IF NOT EXISTS`, so the
--                  trapped-exception form is the only correct spelling)
--   * FKs      -> ALTER TABLE ... ADD CONSTRAINT inside a DO block that first
--                 probes information_schema.table_constraints. This mirrors
--                 the pattern already used by
--                 20260904020000_s3_11_admin_digest_run/migration.sql.
--
-- NO DATA MOVEMENT IS NEEDED
-- --------------------------
-- On a fresh replay every table this file creates is brand new and empty, so
-- there is nothing to backfill. On production every `IF NOT EXISTS` guard
-- short-circuits before touching a row, so no existing data is read, copied,
-- rewritten, or dropped. There is deliberately not a single INSERT / UPDATE /
-- DELETE / DROP in this file.
--
-- SOURCE OF TRUTH
-- ---------------
-- Column names, types, nullability, defaults, FKs, and indexes were
-- transcribed by hand from backend/prisma/schema.prisma (NOT generated with
-- `prisma migrate diff`, which would emit DROP/CREATE churn against the live
-- rows). Transcription rules applied:
--
--   * A field WITHOUT `@map` keeps its camelCase Prisma name as the SQL
--     column name (e.g. DPR.projectName -> "projectName", DPR.workEntries ->
--     "workEntries"). Only `@map("snake_case")` fields are snake_case.
--   * `String @id @default(uuid())` -> TEXT with a
--     `DEFAULT (gen_random_uuid())::text` so the column accepts the string
--     UUID the Prisma client sends while still self-defaulting for raw SQL.
--     TEXT (never UUID) is used for every id and every `employee_id`, which
--     matches what Prisma's `String` maps to and what
--     20260902010000_dr005_revocation and 20260903010000_r25_notifications
--     already wrote. (20260903000000_lpr012_upload_intents declared
--     `upload_intent.id/employee_id` as UUID — a drift from the mapped
--     schema, and part of what DR-009 flags. This baseline states the
--     schema-correct TEXT form; on production the guard makes it a no-op, so
--     the drift is documented here rather than silently "fixed" under live
--     rows.)
--   * `@db.Date` -> DATE, `@db.Decimal(10,7)` -> DECIMAL(10,7),
--     `@db.VarChar(N)` -> VARCHAR(N), `Json` -> JSONB, `Int` -> INTEGER,
--     `DateTime` -> TIMESTAMP(3).
--   * `@default(now())` and `@updatedAt` -> TIMESTAMP(3) NOT NULL DEFAULT
--     CURRENT_TIMESTAMP (Prisma refreshes `@updatedAt` on every write; the
--     default only covers the INSERT).
--   * Referential actions follow Prisma's defaults where the schema is
--     silent: required relation -> ON DELETE RESTRICT ON UPDATE CASCADE,
--     optional relation -> ON DELETE SET NULL ON UPDATE CASCADE. Explicit
--     `onDelete: Cascade` / `onDelete: SetNull` in schema.prisma override
--     that and are reproduced verbatim.
--   * Employee FKs target "employees" (PLURAL — the model's `@@map`).
--     20260903010000_r25_notifications contains a typo pointing at a
--     singular "employee" table that has never existed. That file is left
--     untouched on purpose (rewriting an adopted migration is what created
--     DR-009 in the first place); because this baseline creates
--     notification_preference / email_log / digest_item / digest_run first,
--     that file's `CREATE TABLE IF NOT EXISTS` bodies never execute and the
--     bad FK is never evaluated.
--
-- DELIBERATE OMISSIONS (owned by later migrations, not repeated here)
-- ------------------------------------------------------------------
--   * "attendance_sessions_one_open_idx" — the partial unique index from
--     20260902230000_dr025_one_open_attendance_session. It is raw SQL with
--     no schema.prisma representation, and that file's CREATE is unguarded.
--   * "no_overlap_leave" — the btree_gist EXCLUDE constraint from
--     20260902220220_dr009_leave_overlap_constraint, same reasoning. That
--     file additionally names columns "start_date"/"end_date" which do not
--     exist (schema.prisma leaves `startDate`/`endDate` un-@map-ed, so the
--     real columns are camelCase) — see the note on table 2.11.
--
-- KNOWN RESIDUAL (tracked, NOT fixable from inside this file)
-- ----------------------------------------------------------
-- Four already-adopted migrations still use unguarded DDL and will error if
-- a clean replay reaches them after this baseline has created the objects
-- they assume are absent:
--   20260902000000_dr010_evidence_provenance   (CREATE TYPE / ADD COLUMN /
--                                               DROP TYPE "TrainingStatus")
--   20260902010000_dr005_revocation            (CREATE TABLE revoked_token,
--                                               refresh_token + indexes)
--   20260903000000_lpr012_upload_intents       (CREATE TABLE upload_intent
--                                               + indexes)
--   20260904000000_s3_6_overdue_notification_audit
--                                              (ALTER TABLE on the
--                                               non-existent plural
--                                               "training_enrollments")
-- Closing DR-009 end-to-end needs those four made idempotent as a follow-up.
-- ============================================================================


-- ============================================================================
-- SECTION 1 — ENUMS
-- ============================================================================

DO $$ BEGIN
  CREATE TYPE "DPRStatus" AS ENUM (
    'DRAFT',
    'SUBMITTED',
    'UNDER_REVIEW',
    'APPROVED',
    'REJECTED'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "TrainingProvider" AS ENUM (
    'YOUTUBE',
    'VIMEO',
    'LINKEDIN_LEARNING',
    'COURSERA',
    'UDEMY',
    'OTHER'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
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
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "TrainingPriority" AS ENUM (
    'LOW',
    'NORMAL',
    'HIGH'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ============================================================================
-- SECTION 2 — TABLES
-- ============================================================================
-- Tables are declared parent-first for readability, but NO foreign key is
-- inlined: every FK is added in SECTION 3 through a guarded ALTER TABLE. That
-- removes any ordering hazard from the cycles in this schema
-- (notification -> leave_request / training_enrollment, email_log ->
-- notification, digest_run -> email_log, digest_item -> digest_run).

-- ---------------------------------------------------------------------------
-- 2.1 employees  (model Employee)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "employees" (
  "id"                  TEXT         NOT NULL DEFAULT (gen_random_uuid())::text,
  "email"               TEXT         NOT NULL,
  "password"            TEXT,
  "name"                TEXT         NOT NULL,
  "designation"         TEXT,
  "department"          TEXT,
  "is_admin"            BOOLEAN      NOT NULL DEFAULT FALSE,
  -- LPR-011: plaintext today; encrypting these is a separate, tracked change.
  "zoho_access_token"   TEXT,
  "zoho_refresh_token"  TEXT,
  "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "employees_email_key"
  ON "employees" ("email");

-- ---------------------------------------------------------------------------
-- 2.2 revoked_token  (model RevokedToken)
-- ---------------------------------------------------------------------------
-- Intentionally NOT related to employees: a revocation must outlive the
-- employee row it refers to, so `employee_id` is a plain audit column.
CREATE TABLE IF NOT EXISTS "revoked_token" (
  "jti"          TEXT         NOT NULL,
  "employee_id"  TEXT         NOT NULL,
  "revoked_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "revoked_token_pkey" PRIMARY KEY ("jti")
);

CREATE INDEX IF NOT EXISTS "revoked_token_expires_at_idx"
  ON "revoked_token" ("expires_at");

-- ---------------------------------------------------------------------------
-- 2.3 refresh_token  (model RefreshToken)
-- ---------------------------------------------------------------------------
-- Same "no FK on purpose" reasoning as revoked_token. token_hash is a
-- sha256 digest — the token itself is never stored.
CREATE TABLE IF NOT EXISTS "refresh_token" (
  "id"               TEXT         NOT NULL DEFAULT (gen_random_uuid())::text,
  "employee_id"      TEXT         NOT NULL,
  "token_hash"       TEXT         NOT NULL,
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "rotated_from_id"  TEXT,
  "expires_at"       TIMESTAMP(3) NOT NULL,
  "revoked_at"       TIMESTAMP(3),
  "last_used_at"     TIMESTAMP(3),
  CONSTRAINT "refresh_token_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "refresh_token_token_hash_key"
  ON "refresh_token" ("token_hash");

CREATE INDEX IF NOT EXISTS "refresh_token_employee_id_idx"
  ON "refresh_token" ("employee_id");

CREATE INDEX IF NOT EXISTS "refresh_token_expires_at_idx"
  ON "refresh_token" ("expires_at");

-- ---------------------------------------------------------------------------
-- 2.4 attendance  (model Attendance)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "attendance" (
  "id"           TEXT         NOT NULL DEFAULT (gen_random_uuid())::text,
  "employee_id"  TEXT         NOT NULL,
  "date"         DATE         NOT NULL,
  "status"       TEXT         NOT NULL DEFAULT 'Present',
  "notes"        TEXT,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "attendance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "attendance_employee_id_date_key"
  ON "attendance" ("employee_id", "date");

CREATE INDEX IF NOT EXISTS "attendance_date_idx"
  ON "attendance" ("date");

-- ---------------------------------------------------------------------------
-- 2.5 attendance_sessions  (model AttendanceSession)
-- ---------------------------------------------------------------------------
-- The one-open-session partial unique index is owned by
-- 20260902230000_dr025_one_open_attendance_session and is NOT repeated here.
CREATE TABLE IF NOT EXISTS "attendance_sessions" (
  "id"              TEXT           NOT NULL DEFAULT (gen_random_uuid())::text,
  "attendance_id"   TEXT           NOT NULL,
  "check_in"        TIMESTAMP(3)   NOT NULL,
  "check_in_lat"    DECIMAL(10,7),
  "check_in_lng"    DECIMAL(10,7),
  "check_in_addr"   TEXT,
  "check_out"       TIMESTAMP(3),
  "check_out_lat"   DECIMAL(10,7),
  "check_out_lng"   DECIMAL(10,7),
  "check_out_addr"  TEXT,
  "created_at"      TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "attendance_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "attendance_sessions_attendance_id_idx"
  ON "attendance_sessions" ("attendance_id");

-- ---------------------------------------------------------------------------
-- 2.6 dpr  (model DPR)
-- ---------------------------------------------------------------------------
-- NOTE the mixed casing: projectName / location / reportDate / weather /
-- temperature / contractor / workType / notes / workEntries have NO `@map`
-- in schema.prisma, so their SQL column names are the camelCase Prisma
-- names. Only the round-12 narrative fields and the workflow ids are mapped
-- to snake_case.
CREATE TABLE IF NOT EXISTS "dpr" (
  "id"                          TEXT         NOT NULL DEFAULT (gen_random_uuid())::text,
  "projectName"                 TEXT         NOT NULL,
  "location"                    TEXT         NOT NULL,
  "reportDate"                  DATE         NOT NULL,
  "weather"                     TEXT,
  "temperature"                 TEXT,
  "contractor"                  TEXT,
  "workType"                    TEXT         NOT NULL DEFAULT 'MATERIAL_RECEIPT',
  "notes"                       TEXT,
  "work_executed_today"         TEXT,
  "work_location"               TEXT,
  "manpower_summary"            TEXT,
  "risks_hindrances"            TEXT,
  "materials_received_summary"  TEXT,
  "custom_sections"             JSONB,
  "workEntries"                 JSONB,
  "status"                      "DPRStatus"  NOT NULL DEFAULT 'DRAFT',
  "version"                     INTEGER      NOT NULL DEFAULT 1,
  "submitted_by_id"             TEXT         NOT NULL,
  "reviewed_by_id"              TEXT,
  "approved_by_id"              TEXT,
  "submitted_at"                TIMESTAMP(3),
  "reviewed_at"                 TIMESTAMP(3),
  "approved_at"                 TIMESTAMP(3),
  "created_at"                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "dpr_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "dpr_submitted_by_id_reportDate_key"
  ON "dpr" ("submitted_by_id", "reportDate");

CREATE INDEX IF NOT EXISTS "dpr_reportDate_id_idx"
  ON "dpr" ("reportDate", "id");

-- ---------------------------------------------------------------------------
-- 2.7 dpr_photo  (model DPRPhoto)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "dpr_photo" (
  "id"            TEXT         NOT NULL DEFAULT (gen_random_uuid())::text,
  "dpr_id"        TEXT         NOT NULL,
  "ulid"          TEXT         NOT NULL,
  "container"     TEXT         NOT NULL,
  "filename"      TEXT         NOT NULL,
  "content_type"  TEXT         NOT NULL,
  "size_bytes"    INTEGER      NOT NULL,
  "caption"       TEXT,
  "location"      TEXT,
  "taken_at"      TIMESTAMP(3),
  "uploaded_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "dpr_photo_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "dpr_photo_dpr_id_idx"
  ON "dpr_photo" ("dpr_id");

CREATE INDEX IF NOT EXISTS "dpr_photo_ulid_idx"
  ON "dpr_photo" ("ulid");

-- ---------------------------------------------------------------------------
-- 2.8 dpr_revision  (model DPRRevision)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "dpr_revision" (
  "id"              TEXT         NOT NULL DEFAULT (gen_random_uuid())::text,
  "dpr_id"          TEXT         NOT NULL,
  "version"         INTEGER      NOT NULL,
  "snapshot"        JSONB        NOT NULL,
  "changed_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "changed_by_id"   TEXT         NOT NULL,
  CONSTRAINT "dpr_revision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "dpr_revision_dpr_id_version_key"
  ON "dpr_revision" ("dpr_id", "version");

CREATE INDEX IF NOT EXISTS "dpr_revision_dpr_id_changed_at_idx"
  ON "dpr_revision" ("dpr_id", "changed_at");

-- ---------------------------------------------------------------------------
-- 2.9 inspection_record  (model InspectionRecord)
-- ---------------------------------------------------------------------------
-- projectName / location / reportDate / weather / contractor / severity have
-- no `@map` -> camelCase preserved for projectName and reportDate.
CREATE TABLE IF NOT EXISTS "inspection_record" (
  "id"                TEXT         NOT NULL DEFAULT (gen_random_uuid())::text,
  "projectName"       TEXT         NOT NULL,
  "location"          TEXT         NOT NULL,
  "reportDate"        DATE         NOT NULL,
  "weather"           TEXT,
  "contractor"        TEXT,
  "dpr_id"            TEXT,
  "inspection_type"   TEXT         NOT NULL,
  "data"              JSONB        NOT NULL,
  "status"            TEXT         NOT NULL DEFAULT 'OPEN',
  "severity"          TEXT,
  "submitted_by_id"   TEXT         NOT NULL,
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "inspection_record_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "inspection_record_submitted_by_id_reportDate_idx"
  ON "inspection_record" ("submitted_by_id", "reportDate");

CREATE INDEX IF NOT EXISTS "inspection_record_dpr_id_idx"
  ON "inspection_record" ("dpr_id");

CREATE INDEX IF NOT EXISTS "inspection_record_reportDate_id_idx"
  ON "inspection_record" ("reportDate", "id");

CREATE INDEX IF NOT EXISTS "inspection_record_inspection_type_idx"
  ON "inspection_record" ("inspection_type");

-- ---------------------------------------------------------------------------
-- 2.10 inspection_photo  (model InspectionPhoto)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "inspection_photo" (
  "id"              TEXT         NOT NULL DEFAULT (gen_random_uuid())::text,
  "inspection_id"   TEXT         NOT NULL,
  "ulid"            TEXT         NOT NULL,
  "container"       TEXT         NOT NULL,
  "filename"        TEXT         NOT NULL,
  "content_type"    TEXT         NOT NULL,
  "size_bytes"      INTEGER      NOT NULL,
  "caption"         TEXT,
  "location"        TEXT,
  "taken_at"        TIMESTAMP(3),
  "uploaded_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "inspection_photo_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "inspection_photo_inspection_id_idx"
  ON "inspection_photo" ("inspection_id");

CREATE INDEX IF NOT EXISTS "inspection_photo_ulid_idx"
  ON "inspection_photo" ("ulid");

-- ---------------------------------------------------------------------------
-- 2.11 leave_request  (model LeaveRequest)
-- ---------------------------------------------------------------------------
-- Declared before `notification` because notification.leave_request_id points
-- at it.
--
-- CAUTION — "startDate" / "endDate" are camelCase on purpose. schema.prisma
-- declares them as `startDate DateTime @db.Date` with NO `@map`, so the SQL
-- column names are the Prisma names. Every other date-ish column on this
-- table IS mapped (review_notes, cancelled_at, ...), which makes the mixed
-- casing look like a mistake — it is not.
--
-- The `no_overlap_leave` EXCLUDE constraint is owned by
-- 20260902220220_dr009_leave_overlap_constraint and is NOT repeated here.
-- NOTE that file spells these two columns "start_date" / "end_date", which
-- do not exist; it therefore cannot have been executed (it was force-adopted
-- with `prisma migrate resolve --applied`), and the exclusion constraint it
-- claims to install is almost certainly absent from production. Flagged, not
-- fixed here — rewriting an adopted migration is what produced DR-009.
CREATE TABLE IF NOT EXISTS "leave_request" (
  "id"                TEXT         NOT NULL DEFAULT (gen_random_uuid())::text,
  "employee_id"       TEXT         NOT NULL,
  "startDate"         DATE         NOT NULL,
  "endDate"           DATE         NOT NULL,
  "leave_type"        TEXT         NOT NULL DEFAULT 'CASUAL',
  "reason"            TEXT         NOT NULL,
  "status"            TEXT         NOT NULL DEFAULT 'PENDING',
  "reviewed_by_id"    TEXT,
  "reviewed_at"       TIMESTAMP(3),
  "review_notes"      TEXT,
  "cancelled_at"      TIMESTAMP(3),
  "metadata"          JSONB,
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "leave_request_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "leave_request_employee_id_startDate_idx"
  ON "leave_request" ("employee_id", "startDate");

CREATE INDEX IF NOT EXISTS "leave_request_status_startDate_idx"
  ON "leave_request" ("status", "startDate");

CREATE INDEX IF NOT EXISTS "leave_request_startDate_endDate_idx"
  ON "leave_request" ("startDate", "endDate");

-- ---------------------------------------------------------------------------
-- 2.12 training_course  (model TrainingCourse)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "training_course" (
  "id"             TEXT               NOT NULL DEFAULT (gen_random_uuid())::text,
  "title"          VARCHAR(160)       NOT NULL,
  "description"    TEXT,
  "external_url"   VARCHAR(2048)      NOT NULL,
  "provider"       "TrainingProvider" NOT NULL,
  "category"       VARCHAR(60),
  "duration_hint"  INTEGER,
  "is_archived"    BOOLEAN            NOT NULL DEFAULT FALSE,
  "created_by_id"  TEXT               NOT NULL,
  "created_at"     TIMESTAMP(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"     TIMESTAMP(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "training_course_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "training_course_is_archived_created_at_idx"
  ON "training_course" ("is_archived", "created_at");

CREATE INDEX IF NOT EXISTS "training_course_provider_idx"
  ON "training_course" ("provider");

-- ---------------------------------------------------------------------------
-- 2.13 training_enrollment  (model TrainingEnrollment)
-- ---------------------------------------------------------------------------
-- This is the post-DR-010 shape: the 8-value TrainingEnrollmentStatus enum,
-- the four provenance columns (evidence_class / completed_by /
-- evidence_metadata / provider_session_id), and the S3-6 overdue_notified_at
-- column — all folded into the baseline so a clean database lands directly on
-- today's schema instead of replaying the round-14 -> round-20 -> S3-6
-- history. `overdue_notified_at` is SINGULAR-table only: the plural
-- "training_enrollments" referenced by
-- 20260904000000_s3_6_overdue_notification_audit is a typo that never
-- corresponded to a real table (see the Phase-4 P0 note).
CREATE TABLE IF NOT EXISTS "training_enrollment" (
  "id"                    TEXT                       NOT NULL DEFAULT (gen_random_uuid())::text,
  "course_id"             TEXT                       NOT NULL,
  "employee_id"           TEXT                       NOT NULL,
  "assigned_by_id"        TEXT                       NOT NULL,
  "assigned_at"           TIMESTAMP(3)               NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "due_date"              DATE,
  "priority"              "TrainingPriority"         NOT NULL DEFAULT 'NORMAL',
  "status"                "TrainingEnrollmentStatus" NOT NULL DEFAULT 'ASSIGNED',
  "progress_pct"          INTEGER                    NOT NULL DEFAULT 0,
  "last_watched_sec"      INTEGER                    NOT NULL DEFAULT 0,
  "started_at"            TIMESTAMP(3),
  "completed_at"          TIMESTAMP(3),
  "evidence_class"        VARCHAR(40),
  "completed_by"          TEXT,
  "evidence_metadata"     JSONB,
  "provider_session_id"   VARCHAR(120),
  "employee_note"         VARCHAR(500),
  "overdue_notified_at"   TIMESTAMP(3),
  "created_at"            TIMESTAMP(3)               NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMP(3)               NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "training_enrollment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "training_enrollment_course_id_employee_id_key"
  ON "training_enrollment" ("course_id", "employee_id");

CREATE INDEX IF NOT EXISTS "training_enrollment_employee_id_status_idx"
  ON "training_enrollment" ("employee_id", "status");

CREATE INDEX IF NOT EXISTS "training_enrollment_status_due_date_idx"
  ON "training_enrollment" ("status", "due_date");

CREATE INDEX IF NOT EXISTS "training_enrollment_assigned_at_idx"
  ON "training_enrollment" ("assigned_at");

-- schema.prisma declares a plain `@@index([evidenceClass])`; the partial
-- variant in 20260902000000_dr010_evidence_provenance is a narrower
-- hand-written form of the same index under the same name.
CREATE INDEX IF NOT EXISTS "training_enrollment_evidence_class_idx"
  ON "training_enrollment" ("evidence_class");

-- ---------------------------------------------------------------------------
-- 2.14 notification  (model Notification)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "notification" (
  "id"                       TEXT         NOT NULL DEFAULT (gen_random_uuid())::text,
  "employee_id"              TEXT         NOT NULL,
  "type"                     TEXT         NOT NULL,
  "dpr_id"                   TEXT,
  "leave_request_id"         TEXT,
  "training_enrollment_id"   TEXT,
  "message"                  TEXT         NOT NULL,
  "is_read"                  BOOLEAN      NOT NULL DEFAULT FALSE,
  "created_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "notification_employee_id_created_at_idx"
  ON "notification" ("employee_id", "created_at");

CREATE INDEX IF NOT EXISTS "notification_dpr_id_idx"
  ON "notification" ("dpr_id");

CREATE INDEX IF NOT EXISTS "notification_leave_request_id_idx"
  ON "notification" ("leave_request_id");

CREATE INDEX IF NOT EXISTS "notification_training_enrollment_id_idx"
  ON "notification" ("training_enrollment_id");

-- ---------------------------------------------------------------------------
-- 2.15 notification_preference  (model NotificationPreference)
-- ---------------------------------------------------------------------------
-- 1:1 with employees — the PK IS the employee id.
CREATE TABLE IF NOT EXISTS "notification_preference" (
  "employee_id"        TEXT         NOT NULL,
  "email_enabled"      BOOLEAN      NOT NULL DEFAULT TRUE,
  "digest_enabled"     BOOLEAN      NOT NULL DEFAULT TRUE,
  "type_mutes"         JSONB        NOT NULL DEFAULT '{}'::jsonb,
  "digest_hour_local"  INTEGER      NOT NULL DEFAULT 8,
  "updated_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notification_preference_pkey" PRIMARY KEY ("employee_id")
);

-- ---------------------------------------------------------------------------
-- 2.16 email_log  (model EmailLog)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "email_log" (
  "id"                   TEXT         NOT NULL DEFAULT (gen_random_uuid())::text,
  "employee_id"          TEXT         NOT NULL,
  "notification_id"      TEXT,
  "recipient_email"      TEXT         NOT NULL,
  "subject"              TEXT         NOT NULL,
  "channel"              TEXT         NOT NULL,
  "status"               TEXT         NOT NULL,
  "provider_message_id"  TEXT,
  "error_message"        TEXT,
  "sent_at"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "email_log_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "email_log_employee_id_sent_at_idx"
  ON "email_log" ("employee_id", "sent_at");

CREATE INDEX IF NOT EXISTS "email_log_notification_id_idx"
  ON "email_log" ("notification_id");

CREATE INDEX IF NOT EXISTS "email_log_status_idx"
  ON "email_log" ("status");

-- ---------------------------------------------------------------------------
-- 2.17 digest_run  (model DigestRun)
-- ---------------------------------------------------------------------------
-- Declared before digest_item because digest_item.digest_run_id points here.
CREATE TABLE IF NOT EXISTS "digest_run" (
  "id"              TEXT         NOT NULL DEFAULT (gen_random_uuid())::text,
  "employee_id"     TEXT         NOT NULL,
  "scheduled_for"   TIMESTAMP(3) NOT NULL,
  "status"          TEXT         NOT NULL DEFAULT 'PENDING',
  "email_log_id"    TEXT,
  "error_message"   TEXT,
  "completed_at"    TIMESTAMP(3),
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "digest_run_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "digest_run_employee_id_scheduled_for_key"
  ON "digest_run" ("employee_id", "scheduled_for");

CREATE UNIQUE INDEX IF NOT EXISTS "digest_run_email_log_id_key"
  ON "digest_run" ("email_log_id");

CREATE INDEX IF NOT EXISTS "digest_run_status_idx"
  ON "digest_run" ("status");

-- ---------------------------------------------------------------------------
-- 2.18 digest_item  (model DigestItem)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "digest_item" (
  "id"                TEXT         NOT NULL DEFAULT (gen_random_uuid())::text,
  "digest_run_id"     TEXT         NOT NULL,
  "employee_id"       TEXT         NOT NULL,
  "notification_id"   TEXT         NOT NULL,
  "included_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "digest_item_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "digest_item_digest_run_id_notification_id_key"
  ON "digest_item" ("digest_run_id", "notification_id");

CREATE INDEX IF NOT EXISTS "digest_item_employee_id_digest_run_id_idx"
  ON "digest_item" ("employee_id", "digest_run_id");

-- ---------------------------------------------------------------------------
-- 2.19 admin_digest_run  (model AdminDigestRun)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "admin_digest_run" (
  "id"              TEXT         NOT NULL DEFAULT (gen_random_uuid())::text,
  "admin_id"        TEXT         NOT NULL,
  "scheduled_for"   TIMESTAMP(3) NOT NULL,
  "status"          TEXT         NOT NULL DEFAULT 'PENDING',
  "email_log_id"    TEXT,
  "error_message"   TEXT,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "admin_digest_run_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "admin_digest_run_admin_id_scheduled_for_key"
  ON "admin_digest_run" ("admin_id", "scheduled_for");

CREATE UNIQUE INDEX IF NOT EXISTS "admin_digest_run_email_log_id_key"
  ON "admin_digest_run" ("email_log_id");

CREATE INDEX IF NOT EXISTS "admin_digest_run_scheduled_for_idx"
  ON "admin_digest_run" ("scheduled_for");

-- ---------------------------------------------------------------------------
-- 2.20 upload_intent  (model UploadIntent)
-- ---------------------------------------------------------------------------
-- TEXT (not UUID) for id / employee_id — see the transcription note in the
-- header about the lpr012 drift.
CREATE TABLE IF NOT EXISTS "upload_intent" (
  "id"             TEXT         NOT NULL DEFAULT (gen_random_uuid())::text,
  "employee_id"    TEXT         NOT NULL,
  "ulid"           TEXT         NOT NULL,
  "container"      TEXT         NOT NULL,
  "blob_path"      TEXT         NOT NULL,
  "content_type"   TEXT         NOT NULL,
  "status"         TEXT         NOT NULL DEFAULT 'PENDING',
  "expires_at"     TIMESTAMP(3) NOT NULL,
  "confirmed_at"   TIMESTAMP(3),
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "bound_type"     TEXT,
  "bound_at"       TIMESTAMP(3),
  CONSTRAINT "upload_intent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "upload_intent_employee_id_ulid_key"
  ON "upload_intent" ("employee_id", "ulid");

CREATE INDEX IF NOT EXISTS "upload_intent_status_expires_at_idx"
  ON "upload_intent" ("status", "expires_at");

CREATE INDEX IF NOT EXISTS "upload_intent_employee_id_status_idx"
  ON "upload_intent" ("employee_id", "status");

CREATE INDEX IF NOT EXISTS "upload_intent_status_bound_at_idx"
  ON "upload_intent" ("status", "bound_at");


-- ============================================================================
-- SECTION 3 — FOREIGN KEYS
-- ============================================================================
-- Every FK is added through the same guarded shape:
--
--   DO $$ BEGIN
--     IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
--                    WHERE constraint_name = '<name>' AND table_name = '<t>')
--     THEN ALTER TABLE ... ADD CONSTRAINT ... ; END IF;
--   END $$;
--
-- Adding FKs after every table exists means the declaration order above has
-- no bearing on correctness, and re-running on production adds nothing.
-- Constraint names follow Prisma's `<table>_<column>_fkey` convention.
-- Employee references always target "employees" (plural).

-- attendance.employee_id -> employees.id  (required relation)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_name = 'attendance_employee_id_fkey'
                   AND table_name = 'attendance') THEN
    ALTER TABLE "attendance"
      ADD CONSTRAINT "attendance_employee_id_fkey"
      FOREIGN KEY ("employee_id") REFERENCES "employees"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- attendance_sessions.attendance_id -> attendance.id  (required relation)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_name = 'attendance_sessions_attendance_id_fkey'
                   AND table_name = 'attendance_sessions') THEN
    ALTER TABLE "attendance_sessions"
      ADD CONSTRAINT "attendance_sessions_attendance_id_fkey"
      FOREIGN KEY ("attendance_id") REFERENCES "attendance"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- dpr.submitted_by_id -> employees.id  (required; relation "DPRSubmitter")
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_name = 'dpr_submitted_by_id_fkey'
                   AND table_name = 'dpr') THEN
    ALTER TABLE "dpr"
      ADD CONSTRAINT "dpr_submitted_by_id_fkey"
      FOREIGN KEY ("submitted_by_id") REFERENCES "employees"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- dpr.reviewed_by_id -> employees.id  (optional; relation "DPRReviewer")
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_name = 'dpr_reviewed_by_id_fkey'
                   AND table_name = 'dpr') THEN
    ALTER TABLE "dpr"
      ADD CONSTRAINT "dpr_reviewed_by_id_fkey"
      FOREIGN KEY ("reviewed_by_id") REFERENCES "employees"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- dpr.approved_by_id -> employees.id  (optional; relation "DPRApprover")
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_name = 'dpr_approved_by_id_fkey'
                   AND table_name = 'dpr') THEN
    ALTER TABLE "dpr"
      ADD CONSTRAINT "dpr_approved_by_id_fkey"
      FOREIGN KEY ("approved_by_id") REFERENCES "employees"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- dpr_photo.dpr_id -> dpr.id  (explicit onDelete: Cascade)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_name = 'dpr_photo_dpr_id_fkey'
                   AND table_name = 'dpr_photo') THEN
    ALTER TABLE "dpr_photo"
      ADD CONSTRAINT "dpr_photo_dpr_id_fkey"
      FOREIGN KEY ("dpr_id") REFERENCES "dpr"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- dpr_revision.dpr_id -> dpr.id  (explicit onDelete: Cascade)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_name = 'dpr_revision_dpr_id_fkey'
                   AND table_name = 'dpr_revision') THEN
    ALTER TABLE "dpr_revision"
      ADD CONSTRAINT "dpr_revision_dpr_id_fkey"
      FOREIGN KEY ("dpr_id") REFERENCES "dpr"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- inspection_record.dpr_id -> dpr.id  (optional relation)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_name = 'inspection_record_dpr_id_fkey'
                   AND table_name = 'inspection_record') THEN
    ALTER TABLE "inspection_record"
      ADD CONSTRAINT "inspection_record_dpr_id_fkey"
      FOREIGN KEY ("dpr_id") REFERENCES "dpr"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- inspection_record.submitted_by_id -> employees.id  (required)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_name = 'inspection_record_submitted_by_id_fkey'
                   AND table_name = 'inspection_record') THEN
    ALTER TABLE "inspection_record"
      ADD CONSTRAINT "inspection_record_submitted_by_id_fkey"
      FOREIGN KEY ("submitted_by_id") REFERENCES "employees"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- inspection_photo.inspection_id -> inspection_record.id  (onDelete: Cascade)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_name = 'inspection_photo_inspection_id_fkey'
                   AND table_name = 'inspection_photo') THEN
    ALTER TABLE "inspection_photo"
      ADD CONSTRAINT "inspection_photo_inspection_id_fkey"
      FOREIGN KEY ("inspection_id") REFERENCES "inspection_record"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- leave_request.employee_id -> employees.id  (required; "LeaveSubmitter")
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_name = 'leave_request_employee_id_fkey'
                   AND table_name = 'leave_request') THEN
    ALTER TABLE "leave_request"
      ADD CONSTRAINT "leave_request_employee_id_fkey"
      FOREIGN KEY ("employee_id") REFERENCES "employees"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- leave_request.reviewed_by_id -> employees.id  (optional; "LeaveReviewer")
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_name = 'leave_request_reviewed_by_id_fkey'
                   AND table_name = 'leave_request') THEN
    ALTER TABLE "leave_request"
      ADD CONSTRAINT "leave_request_reviewed_by_id_fkey"
      FOREIGN KEY ("reviewed_by_id") REFERENCES "employees"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- training_course.created_by_id -> employees.id  (required; "CourseCreatedBy")
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_name = 'training_course_created_by_id_fkey'
                   AND table_name = 'training_course') THEN
    ALTER TABLE "training_course"
      ADD CONSTRAINT "training_course_created_by_id_fkey"
      FOREIGN KEY ("created_by_id") REFERENCES "employees"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- training_enrollment.course_id -> training_course.id  (onDelete: Cascade)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_name = 'training_enrollment_course_id_fkey'
                   AND table_name = 'training_enrollment') THEN
    ALTER TABLE "training_enrollment"
      ADD CONSTRAINT "training_enrollment_course_id_fkey"
      FOREIGN KEY ("course_id") REFERENCES "training_course"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- training_enrollment.employee_id -> employees.id  (required; "EnrollEmployee")
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_name = 'training_enrollment_employee_id_fkey'
                   AND table_name = 'training_enrollment') THEN
    ALTER TABLE "training_enrollment"
      ADD CONSTRAINT "training_enrollment_employee_id_fkey"
      FOREIGN KEY ("employee_id") REFERENCES "employees"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- training_enrollment.assigned_by_id -> employees.id  (required; "EnrollAssignedBy")
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_name = 'training_enrollment_assigned_by_id_fkey'
                   AND table_name = 'training_enrollment') THEN
    ALTER TABLE "training_enrollment"
      ADD CONSTRAINT "training_enrollment_assigned_by_id_fkey"
      FOREIGN KEY ("assigned_by_id") REFERENCES "employees"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- notification.employee_id -> employees.id  (required)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_name = 'notification_employee_id_fkey'
                   AND table_name = 'notification') THEN
    ALTER TABLE "notification"
      ADD CONSTRAINT "notification_employee_id_fkey"
      FOREIGN KEY ("employee_id") REFERENCES "employees"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- notification.dpr_id -> dpr.id  (optional)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_name = 'notification_dpr_id_fkey'
                   AND table_name = 'notification') THEN
    ALTER TABLE "notification"
      ADD CONSTRAINT "notification_dpr_id_fkey"
      FOREIGN KEY ("dpr_id") REFERENCES "dpr"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- notification.leave_request_id -> leave_request.id  (explicit onDelete: SetNull)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_name = 'notification_leave_request_id_fkey'
                   AND table_name = 'notification') THEN
    ALTER TABLE "notification"
      ADD CONSTRAINT "notification_leave_request_id_fkey"
      FOREIGN KEY ("leave_request_id") REFERENCES "leave_request"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- notification.training_enrollment_id -> training_enrollment.id  (SetNull)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_name = 'notification_training_enrollment_id_fkey'
                   AND table_name = 'notification') THEN
    ALTER TABLE "notification"
      ADD CONSTRAINT "notification_training_enrollment_id_fkey"
      FOREIGN KEY ("training_enrollment_id") REFERENCES "training_enrollment"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- notification_preference.employee_id -> employees.id  (onDelete: Cascade)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_name = 'notification_preference_employee_id_fkey'
                   AND table_name = 'notification_preference') THEN
    ALTER TABLE "notification_preference"
      ADD CONSTRAINT "notification_preference_employee_id_fkey"
      FOREIGN KEY ("employee_id") REFERENCES "employees"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- email_log.employee_id -> employees.id  (onDelete: Cascade)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_name = 'email_log_employee_id_fkey'
                   AND table_name = 'email_log') THEN
    ALTER TABLE "email_log"
      ADD CONSTRAINT "email_log_employee_id_fkey"
      FOREIGN KEY ("employee_id") REFERENCES "employees"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- email_log.notification_id -> notification.id  (onDelete: SetNull)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_name = 'email_log_notification_id_fkey'
                   AND table_name = 'email_log') THEN
    ALTER TABLE "email_log"
      ADD CONSTRAINT "email_log_notification_id_fkey"
      FOREIGN KEY ("notification_id") REFERENCES "notification"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- digest_run.employee_id -> employees.id  (onDelete: Cascade)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_name = 'digest_run_employee_id_fkey'
                   AND table_name = 'digest_run') THEN
    ALTER TABLE "digest_run"
      ADD CONSTRAINT "digest_run_employee_id_fkey"
      FOREIGN KEY ("employee_id") REFERENCES "employees"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- digest_run.email_log_id -> email_log.id  (onDelete: SetNull)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_name = 'digest_run_email_log_id_fkey'
                   AND table_name = 'digest_run') THEN
    ALTER TABLE "digest_run"
      ADD CONSTRAINT "digest_run_email_log_id_fkey"
      FOREIGN KEY ("email_log_id") REFERENCES "email_log"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- digest_item.digest_run_id -> digest_run.id  (onDelete: Cascade)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_name = 'digest_item_digest_run_id_fkey'
                   AND table_name = 'digest_item') THEN
    ALTER TABLE "digest_item"
      ADD CONSTRAINT "digest_item_digest_run_id_fkey"
      FOREIGN KEY ("digest_run_id") REFERENCES "digest_run"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- digest_item.notification_id is deliberately NOT a foreign key.
-- schema.prisma's DigestItem model declares exactly one relation field
-- (`digestRun`); `notificationId` is a plain String column with no
-- `@relation`, so Prisma neither creates nor expects an FK there. The
-- adopted 20260903010000_r25_notifications file does add one (against a
-- singular "notification"... table that happens to exist), but production
-- was built by `prisma db push` from schema.prisma and therefore does NOT
-- carry that constraint. Emitting it here would make a freshly replayed
-- database diverge from both production and the mapped schema — exactly
-- the class of disagreement DR-009 is about.

-- admin_digest_run.admin_id -> employees.id  (onDelete: Cascade)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_name = 'admin_digest_run_admin_id_fkey'
                   AND table_name = 'admin_digest_run') THEN
    ALTER TABLE "admin_digest_run"
      ADD CONSTRAINT "admin_digest_run_admin_id_fkey"
      FOREIGN KEY ("admin_id") REFERENCES "employees"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- admin_digest_run.email_log_id -> email_log.id  (onDelete: SetNull)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_name = 'admin_digest_run_email_log_id_fkey'
                   AND table_name = 'admin_digest_run') THEN
    ALTER TABLE "admin_digest_run"
      ADD CONSTRAINT "admin_digest_run_email_log_id_fkey"
      FOREIGN KEY ("email_log_id") REFERENCES "email_log"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- upload_intent.employee_id -> employees.id  (onDelete: Cascade)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_name = 'upload_intent_employee_id_fkey'
                   AND table_name = 'upload_intent') THEN
    ALTER TABLE "upload_intent"
      ADD CONSTRAINT "upload_intent_employee_id_fkey"
      FOREIGN KEY ("employee_id") REFERENCES "employees"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ============================================================================
-- END OF BASELINE — 20 tables, 4 enums, 4 sections, zero data mutations.
-- ============================================================================
