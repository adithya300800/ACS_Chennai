-- N2 (Phase C — ACS Portal): RFI (Request for Information) + Variation Order
-- tables, the second half-step into the project module.
--
-- What this migration adds
-- ─────────────────────────
-- Two new tables, mirroring the Prisma `Rfi` and `VariationOrder` models in
-- prisma/schema.prisma. Both models use `@@map("...")` with snake_case
-- singular names (`rfi`, `variation_order`) — same convention as `dpr`,
-- `inspection_record`, `training_enrollment`, `cube_test`, `project`.
--
-- 1) `rfi` — Request for Information.
--    A project-level question a contractor raises against the design
--    documents, with a target responder, an optional due date, and a
--    response field. Status lifecycle: OPEN → RESPONDED → CLOSED. OPEN
--    with a past `due_date` is reported as OVERDUE by the route layer
--    (deriveRfiStatus) so the DB schema stays status-only and the
--    temporal view is derived on read.
--
--    Columns:
--      id                       TEXT          PK (UUID)
--      project_id               TEXT          FK -> project(id) ON DELETE CASCADE
--                                              (nullable: legacy/unfiled RFI allowed)
--      subject                  TEXT          NOT NULL  (≤ 200 chars, app-validated)
--      question                 TEXT          NOT NULL  (≤ 4000 chars, app-validated)
--      response                 TEXT          NULL      (≤ 4000 chars, app-validated)
--      status                   TEXT          NOT NULL DEFAULT 'OPEN'
--                                              (OPEN | RESPONDED | CLOSED)
--      target_responder_id      TEXT          FK -> employees(id) ON DELETE SET NULL
--      responder_id             TEXT          FK -> employees(id) ON DELETE SET NULL
--      due_date                 DATE          NULL
--      raised_by_id             TEXT          FK -> employees(id) ON DELETE RESTRICT
--      responded_at             TIMESTAMP(3)  NULL
--      closed_at                TIMESTAMP(3)  NULL
--      created_at               TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP
--      updated_at               TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP
--
--    Indexes (mirror the @@index declarations on the model):
--      (project_id)              — per-project RFI list
--      (status)                  — admin queue by status
--      (due_date)                — overdue dashboard tile
--
-- 2) `variation_order` — Contract change-of-scope with a monetary delta.
--    Optionally linked to the RFI that triggered it (`reference_rfi_id`).
--    Status lifecycle: DRAFT → SUBMITTED → APPROVED | REJECTED. Client
--    approval is a per-row boolean flag — `client_approval_required` —
--    so a small variation can be approved in-house without a client
--    sign-off round trip.
--
--    Columns:
--      id                        TEXT             PK (UUID)
--      project_id                TEXT             FK -> project(id) ON DELETE CASCADE
--                                               (NOT NULL — every variation is project-anchored)
--      reference_rfi_id          TEXT             FK -> rfi(id) ON DELETE SET NULL
--      title                     TEXT             NOT NULL  (≤ 200 chars)
--      description               TEXT             NULL      (≤ 4000 chars)
--      delta_amount              NUMERIC(15, 2)   NOT NULL
--                                               (signed: negative for scope reduction)
--      status                    TEXT             NOT NULL DEFAULT 'DRAFT'
--                                               (DRAFT | SUBMITTED | APPROVED | REJECTED)
--      client_approval_required  BOOLEAN          NOT NULL DEFAULT TRUE
--      raised_by_id              TEXT             FK -> employees(id) ON DELETE RESTRICT
--      approved_by_id            TEXT             FK -> employees(id) ON DELETE SET NULL
--      rejected_reason           TEXT             NULL      (≤ 1000 chars)
--      submitted_at              TIMESTAMP(3)     NULL
--      approved_at               TIMESTAMP(3)     NULL
--      rejected_at               TIMESTAMP(3)     NULL
--      created_at                TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP
--      updated_at                TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP
--
--    Indexes:
--      (project_id)              — per-project variation list
--      (status)                  — admin queue by status
--
-- FK semantics
-- ───────────
--   project_id ON DELETE CASCADE on both tables — the N1 contract is
--   "deleting a project removes its RFIs and variations". This is a
--   deviation from DPR / InspectionRecord / BoqItem (which use SetNull to
--   preserve the audit trail) because RFIs and variations are PROJECT-
--   OWNED and have no other business record referencing them. The
--   historical audit lives on the Project row's `updatedAt` + the
--   `createdAt` on each RFI / variation row.
--
--   raised_by_id ON DELETE RESTRICT — deleting an employee who raised an
--   RFI / variation is a business operation that needs an admin transfer-
--   out flow, not a silent row deletion. Same pattern as BoqItem.createdById
--   (see prisma/schema.prisma N7 header).
--
--   target_responder_id / responder_id / approved_by_id ON DELETE SET NULL
--   — these are audit-trail FKs; deleting the referenced employee must
--   not cascade-delete the RFI / variation.
--
--   reference_rfi_id ON DELETE SET NULL — the link is informational. If
--   the source RFI is deleted, the variation survives as a standalone
--   record (the title / description / amount are the source of truth).
--
-- Idempotency
-- ───────────
-- CREATE TABLE / CREATE INDEX IF NOT EXISTS (Postgres 9.6+, Supabase 15+)
-- make this migration safe to re-run against a partially-migrated DB.
-- DO $$ … ALTER TABLE … ADD CONSTRAINT blocks guard the FKs so a re-run
-- on a DB that already has them short-circuits. Same pattern as the
-- 20260905020000_n5_cube_tests / 20260904020000_s3_11_admin_digest_run
-- migrations. The append-only rule applies: if this migration lands
-- wrong, fix it with a new migration, never rewrite this one (see
-- phase-4-p0-s3-6-typo-and-baseline-hazard memory file).
--
-- Why no backfill
-- ───────────────
-- Empty tables on roll-out — no historical RFIs or variations existed
-- before N2. The first RFI raised AFTER deploy will start writing rows
-- here when the create handler lands in Phase C.

CREATE TABLE IF NOT EXISTS "rfi" (
  "id"                    TEXT             NOT NULL,
  "project_id"            TEXT,
  "subject"               TEXT             NOT NULL,
  "question"              TEXT             NOT NULL,
  "response"              TEXT,
  "status"                TEXT             NOT NULL DEFAULT 'OPEN',
  "target_responder_id"   TEXT,
  "responder_id"          TEXT,
  "due_date"              DATE,
  "raised_by_id"          TEXT             NOT NULL,
  "responded_at"          TIMESTAMP(3),
  "closed_at"             TIMESTAMP(3),
  "created_at"            TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "rfi_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "rfi_project_id_idx"
  ON "rfi" ("project_id");

CREATE INDEX IF NOT EXISTS "rfi_status_idx"
  ON "rfi" ("status");

CREATE INDEX IF NOT EXISTS "rfi_due_date_idx"
  ON "rfi" ("due_date");

CREATE TABLE IF NOT EXISTS "variation_order" (
  "id"                       TEXT             NOT NULL,
  "project_id"               TEXT             NOT NULL,
  "reference_rfi_id"         TEXT,
  "title"                    TEXT             NOT NULL,
  "description"              TEXT,
  "delta_amount"             NUMERIC(15, 2)   NOT NULL,
  "status"                   TEXT             NOT NULL DEFAULT 'DRAFT',
  "client_approval_required" BOOLEAN          NOT NULL DEFAULT TRUE,
  "raised_by_id"             TEXT             NOT NULL,
  "approved_by_id"           TEXT,
  "rejected_reason"          TEXT,
  "submitted_at"             TIMESTAMP(3),
  "approved_at"              TIMESTAMP(3),
  "rejected_at"              TIMESTAMP(3),
  "created_at"               TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"               TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "variation_order_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "variation_order_project_id_idx"
  ON "variation_order" ("project_id");

CREATE INDEX IF NOT EXISTS "variation_order_status_idx"
  ON "variation_order" ("status");

-- FKs added in DO $$ blocks so a re-run on a DB where they already exist
-- is a no-op (information_schema.table_constraints lookup). Postgres
-- rejects ADD CONSTRAINT referencing missing columns, so the CREATE
-- TABLE blocks above must run before these.

-- ─── rfi FKs ───────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'rfi_project_id_fkey'
      AND table_name = 'rfi'
  ) THEN
    ALTER TABLE "rfi"
      ADD CONSTRAINT "rfi_project_id_fkey"
      FOREIGN KEY ("project_id") REFERENCES "project"("id")
      ON DELETE CASCADE
      ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'rfi_target_responder_id_fkey'
      AND table_name = 'rfi'
  ) THEN
    ALTER TABLE "rfi"
      ADD CONSTRAINT "rfi_target_responder_id_fkey"
      FOREIGN KEY ("target_responder_id") REFERENCES "employees"("id")
      ON DELETE SET NULL
      ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'rfi_responder_id_fkey'
      AND table_name = 'rfi'
  ) THEN
    ALTER TABLE "rfi"
      ADD CONSTRAINT "rfi_responder_id_fkey"
      FOREIGN KEY ("responder_id") REFERENCES "employees"("id")
      ON DELETE SET NULL
      ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'rfi_raised_by_id_fkey'
      AND table_name = 'rfi'
  ) THEN
    ALTER TABLE "rfi"
      ADD CONSTRAINT "rfi_raised_by_id_fkey"
      FOREIGN KEY ("raised_by_id") REFERENCES "employees"("id")
      ON DELETE RESTRICT
      ON UPDATE CASCADE;
  END IF;
END $$;

-- ─── variation_order FKs ───────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'variation_order_project_id_fkey'
      AND table_name = 'variation_order'
  ) THEN
    ALTER TABLE "variation_order"
      ADD CONSTRAINT "variation_order_project_id_fkey"
      FOREIGN KEY ("project_id") REFERENCES "project"("id")
      ON DELETE CASCADE
      ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'variation_order_reference_rfi_id_fkey'
      AND table_name = 'variation_order'
  ) THEN
    ALTER TABLE "variation_order"
      ADD CONSTRAINT "variation_order_reference_rfi_id_fkey"
      FOREIGN KEY ("reference_rfi_id") REFERENCES "rfi"("id")
      ON DELETE SET NULL
      ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'variation_order_raised_by_id_fkey'
      AND table_name = 'variation_order'
  ) THEN
    ALTER TABLE "variation_order"
      ADD CONSTRAINT "variation_order_raised_by_id_fkey"
      FOREIGN KEY ("raised_by_id") REFERENCES "employees"("id")
      ON DELETE RESTRICT
      ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'variation_order_approved_by_id_fkey'
      AND table_name = 'variation_order'
  ) THEN
    ALTER TABLE "variation_order"
      ADD CONSTRAINT "variation_order_approved_by_id_fkey"
      FOREIGN KEY ("approved_by_id") REFERENCES "employees"("id")
      ON DELETE SET NULL
      ON UPDATE CASCADE;
  END IF;
END $$;
