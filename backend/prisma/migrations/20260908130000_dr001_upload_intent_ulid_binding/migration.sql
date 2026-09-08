-- ─────────────────────────────────────────────────────────────────────────────
-- SOL DR-001: upload-intent binding for non-photo document owners.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The S3-7 durable sweep's CONFIRMED-orphan pass retires any
-- `status='CONFIRMED' AND bound_at IS NULL` intent past its grace window.
-- It is correct for DPR photos and Inspection photos (both store `ulid` as
-- an FK-style column on the photo row, so the sweep's "referenced-ulid"
-- defence finds them and excludes the still-bound intents).
--
-- It is WRONG for the three document-owner tables — Drawing,
-- ProjectAttachment, BillingCertification — whose blob reference is a
-- `blobPath` STRING, not a `ulid` FK column. A CONFIRMED intent behind a
-- legacy drawing/report/COP row stays `bound_at IS NULL` (the legacy
-- intent backfill only covers `dpr_photo` / `inspection_photo`), and the
-- sweep retires its blob. The report still says "filed", the bytes are
-- gone, and the only signal is a 404 from R2 weeks later.
--
-- This migration adds `upload_intent_ulid` to all three tables. New
-- entities populated via the 4-step pipeline (sas-url → R2 PUT →
-- confirm-upload → POST) record the ulid verbatim; the route layer
-- stamps the intent inside the create transaction so the sweep sees
-- `boundAt != NULL` and leaves the row alone.
--
-- Legacy rows (pre-deploy) keep their `upload_intent_ulid` NULL. They
-- are protected by a parallel sweep defence that selects their
-- `blobPath` into a referenced set — see internal-upload-sweep.js. A
-- future migration can backfill `upload_intent_ulid` for those rows
-- once a reverse-mapping script ships.
--
-- Idempotency: every step guards with `IF NOT EXISTS` / `ADD COLUMN
-- IF NOT EXISTS` so a re-run on a DB that already has the columns is a
-- no-op. Matches the R37 / R35 / N3 migration convention.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Drawing: add the new ulid column
ALTER TABLE "drawing"
  ADD COLUMN IF NOT EXISTS "upload_intent_ulid" TEXT;

-- 2. ProjectAttachment: add the new ulid column
ALTER TABLE "project_attachment"
  ADD COLUMN IF NOT EXISTS "upload_intent_ulid" TEXT;

-- 3. BillingCertification: add the new ulid column
ALTER TABLE "billing_certification"
  ADD COLUMN IF NOT EXISTS "upload_intent_ulid" TEXT;

-- 4. Indexes for the sweep's referenced-ulid lookup. Indexing
--    `upload_intent_ulid` makes the sweep's `findMany({ select: { ulid: true } })`
--    O(rows) instead of O(table). The sweep is the only hot reader of
--    these columns today (route writes are sparse).
CREATE INDEX IF NOT EXISTS "drawing_upload_intent_ulid_idx"
  ON "drawing" ("upload_intent_ulid");
CREATE INDEX IF NOT EXISTS "project_attachment_upload_intent_ulid_idx"
  ON "project_attachment" ("upload_intent_ulid");
CREATE INDEX IF NOT EXISTS "billing_certification_upload_intent_ulid_idx"
  ON "billing_certification" ("upload_intent_ulid");
