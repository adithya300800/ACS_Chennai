-- N17 (Project-level dashboard with KPI tiles): lightweight Project master.
--
-- Context: N1 (full Project module) is out of scope for this round (XL
-- effort). N17 needs a project dimension today so the PM dashboard can
-- group DPRs / inspections / cube-tests / BOQ by project, but most of the
-- other modules it depends on (RFI, Drawings, BOQ, CubeTest) are also
-- shipping in parallel rounds (N2/N3/N5/N7). Half-step: introduce a
-- lightweight Project master keyed on the name string that already
-- appears as DPR.projectName / InspectionRecord.projectName, so the
-- dashboard can group by either a curated Project row OR a name auto-
-- discovered from existing DPR submissions.
--
-- Schema rules (per project memory "phase-4-p0-s3-6-typo-and-baseline-hazard.md"):
--   - `@@map` MUST equal the physical table name. Model is `Project` (PascalCase);
--     table is `project` (singular snake_case). Drift here was the source of the
--     S3-6 hazard.
--   - Append-only — this migration is new, never rewrites a prior one.
--
-- Columns:
--   - id              uuid PK (Prisma default)
--   - name            matches DPR.projectName (the canonical identifier for
--                     cross-module joins); @unique so the admin "create" form
--                     dedupes against existing DPR submissions.
--   - code            optional short code (e.g. "T-NAGAR") for human-readable
--                     references in DPR/inspection reports.
--   - client / location / startDate / expectedEndDate — admin-curated
--                     metadata; nullable because the dashboard must work
--                     for auto-discovered projects too.
--   - is_active       soft-delete flag; admin DELETE flips this to false.
--   - created_by_id   FK to employees (cascade on employee delete would be
--                     destructive — SET NULL so audit trail survives a
--                     deleted admin).
--   - created_at / updated_at — standard Prisma timestamps.
--
-- Indexes:
--   - name (already unique, auto-creates an index)
--   - is_active (filter for "active projects" list query)

CREATE TABLE IF NOT EXISTS "project" (
  "id"                TEXT         NOT NULL,
  "name"              TEXT         NOT NULL,
  "code"              TEXT,
  "client"            TEXT,
  "location"          TEXT,
  "is_active"         BOOLEAN      NOT NULL DEFAULT TRUE,
  "start_date"        DATE,
  "expected_end_date" DATE,
  "created_by_id"     TEXT,
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_name_key" UNIQUE ("name"),
  CONSTRAINT "project_code_key" UNIQUE ("code"),
  CONSTRAINT "project_created_by_id_fkey"
    FOREIGN KEY ("created_by_id")
    REFERENCES "employee"("id")
    ON DELETE SET NULL
    ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "project_is_active_idx"
  ON "project" ("is_active");
