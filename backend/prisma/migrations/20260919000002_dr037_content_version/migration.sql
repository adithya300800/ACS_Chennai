-- ─────────────────────────────────────────────────────────────────────────────
-- DR-037 — content-version optimistic concurrency on project_attachment
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Pre-DR-037, an admin could Approve / Reject / Request-Revision on a
-- report, and a separate admin (or the same admin in a stale tab) could
-- then Replace the file from a different browser. The replace path
-- correctly reset status to PENDING_REVIEW on the *new* blob, but a
-- PATCH that already had a 200 OK in flight on the OLD blob would
-- still land on the row — stamping status='APPROVED' on a blob the
-- reviewer never saw. The reviewer had no way to know their decision
-- was made against a now-superseded file.
--
-- Trigger:
--   The SOL review document (Code review by SOL/
--   ACS-Portal-Media-Workflow-Review-2026-09-19-f53c22b.md) DR-037
--   calls out:
--     "Review-A/replace-B yields a stale-review conflict;
--      competing decisions have one winner."
--   Smallest correct fix is an integer `contentVersion` on the row,
--   monotonic per write, that every review/replace/delete mutation
--   must pass back as `expectedVersion`. A mismatch returns
--   409 STALE_REVIEW_VERSION with the row's current version + the
--   client's submitted version so the SPA can render "Refresh and try
--   again" instead of silently approving an unseen blob.
--
-- Effect (1 additive column, additive default — no destructive change):
--
--   1. content_version  INT NOT NULL DEFAULT 1
--      Monotonic counter stamped on every successful mutation
--      (review, replace, delete). Defaults to 1 so all existing rows
--      and freshly-created rows start in a coherent state.
--
-- Existing rows: every row already has the column = 1 via DEFAULT 1.
-- No backfill of historical versions — we cannot reconstruct who
-- reviewed which prior blob, and the SOL doc explicitly says
-- "do not invent lost historical actors or reasons."
--
-- Index: a small composite index on (status, content_version) keeps
-- the admin queue's version-locked read bounded if a future feature
-- needs it (currently no read filters by version, so the index is a
-- no-op on the hot path — kept for symmetry with the other composite
-- indices on this table).

ALTER TABLE project_attachment
  ADD COLUMN IF NOT EXISTS content_version INT NOT NULL DEFAULT 1;

-- [DR-037] Symmetric with the existing (status, project_id) composite;
-- keeps version-bounded lookups covered if/when one is added.
CREATE INDEX IF NOT EXISTS project_attachment_status_content_version_idx
  ON project_attachment (status, content_version);
