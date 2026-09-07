-- [Project Assignments] Many-to-many join between Project and Employee.
--
-- The Project model today only carries a single `created_by_id` FK — there is
-- no way to record which employees are currently working on a project.
-- This migration adds a `project_assignment` join table so admins can
-- assign employees to projects (with an optional `role` label, e.g.
-- "Site Engineer", "QA", "Project Manager").
--
-- Schema details (cross-checked against schema.prisma @@map declarations):
--   ProjectAssignment model -> @@map("project_assignment")  (this file)
--   Project        model   -> @@map("project")
--   Employee       model   -> @@map("employees")
--
-- Columns
-- -------
--   id            TEXT         PK, uuid (gen_random_uuid via DEFAULT — note
--                               the migration is consistent with the model
--                               default but application code passes its own
--                               uuid() at create time)
--   project_id    TEXT         NOT NULL FK -> project(id) ON DELETE CASCADE
--   employee_id   TEXT         NOT NULL FK -> employees(id) ON DELETE CASCADE
--   role          TEXT         optional free-text label (max 60 chars in app)
--   assigned_at   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
--   assigned_by_id TEXT        nullable FK -> employees(id) ON DELETE SET NULL
--                               (audit; SetNull matches the createById
--                                SetNull pattern on Project — deleting the
--                                assigning admin must not orphan an
--                                assignment row)
--
-- Constraints / indexes
-- ---------------------
--   * UNIQUE (project_id, employee_id) — same employee cannot have two
--     rows on the same project. The app's diff logic relies on this as
--     the upsert key.
--   * Index on (project_id) — "list assignments for this project"
--   * Index on (employee_id) — "list projects assigned to this employee"
--
-- Idempotency
-- -----------
-- All DDL uses IF NOT EXISTS or guards via pg_constraint so a re-run
-- against a partially-applied database is a no-op (matches the
-- S3-6 follow-up migration's idempotency pattern, verified against
-- Postgres 15 on Supabase).
--
-- Why a new migration (not an edit to an existing one)
-- ----------------------------------------------------
-- Migration history is append-only. The Phase-4 P0 postmortem
-- (memory file phase-4-p0-s3-6-typo-and-baseline-hazard.md) caught
-- `prisma migrate resolve --applied` LIES that left the underlying
-- ALTER TABLE unrun. A new migration is the canonical pattern for
-- schema additions — append, never rewrite.

-- ─── Join table ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "project_assignment" (
  "id"             TEXT         NOT NULL,
  "project_id"     TEXT         NOT NULL,
  "employee_id"    TEXT         NOT NULL,
  "role"           TEXT,
  "assigned_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "assigned_by_id" TEXT,
  CONSTRAINT "project_assignment_pkey" PRIMARY KEY ("id")
);

-- @@unique([projectId, employeeId])
CREATE UNIQUE INDEX IF NOT EXISTS "project_assignment_project_id_employee_id_key"
  ON "project_assignment" ("project_id", "employee_id");

-- @@index([projectId])
CREATE INDEX IF NOT EXISTS "project_assignment_project_id_idx"
  ON "project_assignment" ("project_id");

-- @@index([employeeId])
CREATE INDEX IF NOT EXISTS "project_assignment_employee_id_idx"
  ON "project_assignment" ("employee_id");

-- ─── Foreign keys ───────────────────────────────────────────────────────────
-- Postgres has no "ADD CONSTRAINT IF NOT EXISTS" — guard via a
-- pg_constraint lookup inside a DO block. Cascade on project_id +
-- employee_id; SetNull on assigned_by_id (audit-only).

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_assignment_project_id_fkey') THEN
    ALTER TABLE "project_assignment" ADD CONSTRAINT "project_assignment_project_id_fkey"
      FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_assignment_employee_id_fkey') THEN
    ALTER TABLE "project_assignment" ADD CONSTRAINT "project_assignment_employee_id_fkey"
      FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='project_assignment_assigned_by_id_fkey') THEN
    ALTER TABLE "project_assignment" ADD CONSTRAINT "project_assignment_assigned_by_id_fkey"
      FOREIGN KEY ("assigned_by_id") REFERENCES "employees"("id") ON DELETE SET NULL;
  END IF;
END $$;
