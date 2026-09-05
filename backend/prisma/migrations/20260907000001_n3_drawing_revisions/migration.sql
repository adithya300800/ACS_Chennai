-- ─────────────────────────────────────────────────────────────────────────────
-- N3 (Phase-E) — Drawing Revision Register + DPR/Inspection drawing link
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Establishes a curated register of construction drawings per project. Each
-- drawing has a (drawingNumber, revision) pair; subsequent revisions are
-- added as NEW rows that supersede the previous one (the supersedesId FK).
-- DPR and Inspection records can link to a specific drawing revision so the
-- stamp UI can render "Filed against drawing X rev Y".
--
-- Design notes:
--
--   * drawing_number + revision is the natural key inside a project.
--     Unique index (project_id, drawing_number, revision) prevents two
--     rows for the same drawing at the same revision.
--
--   * status is a string (`ACTIVE` | `SUPERSEDED`) rather than an enum so a
--     future state (e.g. `ARCHIVED`) doesn't require a schema change. The
--     DPR / Inspection drawing link is drawn from the ACTIVE row of a
--     (project, drawingNumber) pair.
--
--   * Drawing.pdfBlobPath references an R2 path uploaded through the
--     existing DPR upload flow (the dpr-documents bucket). The blob path
--     is stored verbatim — the same `applyR2Cors` self-heal covers it.
--
--   * drawing_id + drawing_rev on DPR / InspectionRecord is intentionally
--     denormalized: drawing_rev is copied at submit time so list views
--     don't need to JOIN drawing just to render "rev 2" in a queue card.
--     FK is SetNull on drawing delete so the link can be cleared without
--     cascade-deleting historic reports.
--
--   * Idempotency guards match the N1 Project FK migration convention:
--     ADD COLUMN IF NOT EXISTS + DO $$ blocks for FK + indexes. Lets the
--     migration re-run safely against a DB that was previously seeded by
--     a partial run.
--
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. New table: drawing
CREATE TABLE IF NOT EXISTS "drawing" (
  "id"              TEXT PRIMARY KEY,
  "project_id"      TEXT NOT NULL,
  "drawing_number"  TEXT NOT NULL,
  "title"           TEXT,
  "revision"        TEXT NOT NULL DEFAULT '0',
  "status"          TEXT NOT NULL DEFAULT 'ACTIVE',
  "issued_date"     DATE,
  "issued_by_id"    TEXT,
  "pdf_blob_path"   TEXT,
  "supersedes_id"   TEXT,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 2. FKs (idempotent)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drawing_project_id_fkey') THEN
    ALTER TABLE "drawing"
      ADD CONSTRAINT "drawing_project_id_fkey"
      FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drawing_issued_by_id_fkey') THEN
    ALTER TABLE "drawing"
      ADD CONSTRAINT "drawing_issued_by_id_fkey"
      FOREIGN KEY ("issued_by_id") REFERENCES "employees"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drawing_supersedes_id_fkey') THEN
    ALTER TABLE "drawing"
      ADD CONSTRAINT "drawing_supersedes_id_fkey"
      FOREIGN KEY ("supersedes_id") REFERENCES "drawing"("id") ON DELETE SET NULL;
  END IF;
END $$;

-- 3. Unique + indexes (idempotent)
CREATE UNIQUE INDEX IF NOT EXISTS "drawing_project_id_drawing_number_revision_key"
  ON "drawing" ("project_id", "drawing_number", "revision");
CREATE INDEX IF NOT EXISTS "drawing_project_id_idx" ON "drawing" ("project_id");
CREATE INDEX IF NOT EXISTS "drawing_status_idx" ON "drawing" ("status");
CREATE INDEX IF NOT EXISTS "drawing_supersedes_id_idx" ON "drawing" ("supersedes_id");

-- 4. Add drawing_id + drawing_rev columns on DPR + inspection_record
ALTER TABLE "dpr" ADD COLUMN IF NOT EXISTS "drawing_id" TEXT;
ALTER TABLE "dpr" ADD COLUMN IF NOT EXISTS "drawing_rev" TEXT;
ALTER TABLE "inspection_record" ADD COLUMN IF NOT EXISTS "drawing_id" TEXT;
ALTER TABLE "inspection_record" ADD COLUMN IF NOT EXISTS "drawing_rev" TEXT;

-- 5. FKs from DPR / InspectionRecord to drawing (idempotent)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dpr_drawing_id_fkey') THEN
    ALTER TABLE "dpr"
      ADD CONSTRAINT "dpr_drawing_id_fkey"
      FOREIGN KEY ("drawing_id") REFERENCES "drawing"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inspection_record_drawing_id_fkey') THEN
    ALTER TABLE "inspection_record"
      ADD CONSTRAINT "inspection_record_drawing_id_fkey"
      FOREIGN KEY ("drawing_id") REFERENCES "drawing"("id") ON DELETE SET NULL;
  END IF;
END $$;

-- 6. Indexes on the FK columns
CREATE INDEX IF NOT EXISTS "dpr_drawing_id_idx" ON "dpr" ("drawing_id");
CREATE INDEX IF NOT EXISTS "inspection_record_drawing_id_idx" ON "inspection_record" ("drawing_id");
