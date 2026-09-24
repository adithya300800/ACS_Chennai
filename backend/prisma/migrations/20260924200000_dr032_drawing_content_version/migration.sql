-- ─────────────────────────────────────────────────────────────────────────────
-- DR-032 — content-version optimistic concurrency on drawing
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Pre-DR-032, an ACTIVE drawing that downstream records (DPR, Inspection)
-- stamped against could have its `pdf_blob_path` replaced or its
-- `upload_intent_ulid` swapped by an admin PATCH, and the historical
-- stamp on the existing DPR/Inspection row would silently resolve to
-- the new bytes — under the same drawing ID + revision label. The
-- downstream reader (DPR modal, InspectionDetail) cached only the
-- drawing ID and the revision string, so a later "Replace PDF" PATCH
-- on the same drawing row produced a stamp-stable link that resolved
-- to a different blob.
--
-- Trigger:
--   The Fresh24 audit (ACS-Portal-Fresh-Product-Audit-2026-09-24-71f183a.md
--   lines 456-466) DR-032 calls out:
--     "Records stamp a drawing ID/revision, but an ACTIVE referenced
--      drawing can have its PDF pointer replaced. Historical preview
--      then resolves different bytes under the same label."
--   Smallest correct fix is an integer `content_version` on the row,
--   monotonic per write, that every PATCH must pass back as
--   `expectedVersion`. A mismatch returns 409 STALE_VERSION so a stale
--   admin tab cannot silently replace bytes that downstream readers
--   have already stamped against.
--
-- Effect (1 additive column, additive default — no destructive change):
--
--   1. content_version  INT NOT NULL DEFAULT 1
--      Monotonic counter stamped on every successful mutation of a
--      content field (`pdf_blob_path`; `upload_intent_ulid` is bound
--      to it so it rides the same bump). Metadata corrections
--      (title / issuedDate / issuedById / status transitions) do NOT
--      bump the version — those are safe to amend in-place and don't
--      change the bytes the stamp resolves to.
--
-- Existing rows: every row already has the column = 1 via DEFAULT 1.
-- No backfill of historical versions — we cannot reconstruct who
-- replaced which prior blob, and the audit explicitly says
-- "do not invent lost historical actors or reasons."
--
-- Index: a small composite index on (status, content_version) keeps
-- a future "show me active drawings whose version moved" UI bounded.
-- Currently no read filters by version, so the index is a no-op on
-- the hot path — kept for symmetry with project_attachment's
-- DR-037 composite.

ALTER TABLE drawing
  ADD COLUMN IF NOT EXISTS content_version INT NOT NULL DEFAULT 1;

-- [DR-032] Symmetric with project_attachment's (status, content_version)
-- composite; keeps version-bounded lookups covered if/when one is
-- added. No read currently filters by version — present for symmetry.
CREATE INDEX IF NOT EXISTS drawing_status_content_version_idx
  ON drawing (status, content_version);
