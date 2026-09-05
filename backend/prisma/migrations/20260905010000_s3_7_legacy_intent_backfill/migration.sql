-- S3-7 follow-up: SOL DR-002 — backfill `bound_type` + `bound_at` for legacy
-- upload_intent rows that pre-date the original S3-7 migration.
--
-- ── Why this is a separate migration, not a `migrate resolve --applied` ──
--
-- The original S3-7 migration
-- (20260904010000_s3_7_upload_intent_binding/migration.sql) added the
-- `bound_type` / `bound_at` columns but intentionally did NOT backfill them,
-- on the theory that any pre-existing `status='CONFIRMED'` row was an
-- orphan. SOL DR-002 surfaced that this theory was wrong: every upload that
-- produced a CONFIRMED intent ALSO produced a Photo row in either
-- `dpr_photo` or `inspection_photo`, and the photo row owns the bytes the
-- report displays. Deleting the R2 blob behind a CONFIRMED + unbound intent
-- leaves a photo row in the database pointing at a 404 in the bucket.
--
-- Per the project's migration-replay lesson (see memory file
-- phase-4-p0-s3-6-typo-and-baseline-hazard.md), we DO NOT rewrite the
-- applied history. This is a new migration that does one thing only:
-- stamp every pre-existing CONFIRMED intent whose ulid is still referenced
-- by a Photo row as a still-owned, no-sweep target. Idempotent (uses
-- `bound_at IS NULL` guard), safe to re-run.
--
-- ── The two UPDATEs ──────────────────────────────────────────────────────
--
-- One per photo table. An intent whose ulid is referenced by BOTH tables
-- (essentially never, but not impossible) is processed by the second
-- UPDATE which wins; both `bound_type` values are valid business claims,
-- so this is informational, not corrupting. The COALESCE on `bound_at`
-- means the first non-NULL stamp wins, so an earlier backfill is never
-- overwritten.
--
-- ulids are scoped per-employee in upload_intent (`UNIQUE(employeeId, ulid)`)
-- and the photo rows do not store employee_id, so the join is on `ulid`
-- alone. That join is correct because the intent row is the source of
-- truth for ownership: a Photo row with that ulid must, by construction,
-- have come from the same employee who created the intent. If a second
-- employee ever happens to mint the same ulid (ULID collisions are
-- astronomically unlikely), their intent remains a separate row and is
-- not affected by this UPDATE.
--
-- The sweep's defence-in-depth (see
-- src/routes/internal-upload-sweep.js) ALSO excludes any ulid still
-- referenced by a Photo row at sweep time. This migration is the
-- one-time clean-up; the sweep guard is the ongoing safety net.

UPDATE "upload_intent" ui
SET    "bound_type" = 'dpr',
       "bound_at"   = COALESCE(ui."bound_at", now())
FROM   "dpr_photo" dp
WHERE  ui."ulid" = dp."ulid"
  AND  ui."bound_at" IS NULL;

UPDATE "upload_intent" ui
SET    "bound_type" = 'inspection',
       "bound_at"   = COALESCE(ui."bound_at", now())
FROM   "inspection_photo" ip
WHERE  ui."ulid" = ip."ulid"
  AND  ui."bound_at" IS NULL;
