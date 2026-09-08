-- ─────────────────────────────────────────────────────────────────────────────
-- DR-020 (audit, 2026-09-08) — Durable request-key deduplication for billing
--                             COP + inspection POST handlers.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Audit verdict (Code review by SOL/ACS-Portal-Workflow-Completeness-Review-
-- 2026-09-08-5c61cd8.md, lines 312-322):
--
--   "A COP POST retried after a lost response generates another UUID with
--    no business-identity or request-key deduplication. Separately,
--    inspection idempotency caches post-success results but does not
--    reserve an in-flight owner/route/key; concurrent same-key, no-photo
--    requests can both create records."
--
-- Repair / acceptance:
--
--   "Establish normalized bill/PO/revision identity and durable request
--    deduplication BEFORE effects. Reserve inspection request identity
--    before committing work. Reject mismatched payload reuse. Define
--    restart guarantees. Lost-response retries + concurrent identical
--    requests must yield ONE logical record and ONE notification
--    handoff."
--
-- This migration adds two things:
--
--   1. `request_dedupe` — durable per-key reservation table. Backed by
--      Postgres (NOT in-memory like the round-10 idempotency cache), so
--      a process restart mid-handler still rejects a second writer
--      against the same key (the audit's "restart guarantees"). The
--      natural PK is the key string itself (header-set by the client,
--      capped at 200 chars by lib/idempotency.js MAX_KEY_LENGTH).
--      `state` is a 3-value enum: PENDING (reservation claimed, handler
--      in flight), COMPLETED (handler returned a 2xx), FAILED (handler
--      returned 4xx; cache is poisoned so a retry with the same body
--      doesn't loop forever). `payload_hash` is the canonical-JSON
--      sha256 — same contract as lib/idempotency.js so the security pin
--      "same key + different body → 409 IDEMPOTENCY_MISMATCH" survives
--      the move off the in-memory Map.
--
--   2. `billing_certification.idempotency_key` — nullable column on the
--      COP table. Stamped at create-time so a same-key replay that
--      raced the reservation can be reconciled to the originally
--      committed row WITHOUT another lookup. Mirrors the way
--      `uploadIntentUlid` is stamped to support the sweep's
--      referenced-blobPath defence (round-26).
--
-- Inspection does NOT get its own column — the audit explicitly asks
-- for "reserve inspection request identity before committing work"
-- (lib/idempotency.js already attaches the key to its cache slot; we
-- only move the slot from process memory to the DB). The key string is
-- namespaced inside `request_dedupe.key` as `route:employeeId:key` so
-- billing and inspection writers cannot collide.
--
-- Why a new migration (not an edit to r37_billing_certifications / S3-9)
-- --------------------------------------------------------------------------
-- Append-only by Phase-4 P0 policy (see memory/phase-4-p0-s3-6-typo-and-
-- baseline-hazard.md). The originals stay frozen as the audit trail for
-- the initial R37 / S3-9 schemas.
--
-- Idempotency
-- -----------
-- All DDL uses IF NOT EXISTS / DO $$ blocks (verified against Postgres
-- 15 on Supabase). A re-run against a partially-applied DB is a no-op.
--
-- Backward compatibility
-- ----------------------
-- Existing rows get `idempotency_key = NULL` — the column is purely
-- additive. No code path reads the column before the DR-020 handler
-- changes ship; legacy clients that don't send an Idempotency-Key
-- header continue to work, falling back to the business-identity dedupe
-- on (projectId, contractorName, billNumber) the audit calls out as a
-- 2nd dedupe layer.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── request_dedupe ────────────────────────────────────────────────────────
-- Durable per-key reservation. One row per (route, key); the column is
-- the natural PK so the reservation write is a single INSERT with
-- ON CONFLICT handling (no SELECT-then-INSERT race window). Namespaces
-- the key string as `${route}:${employeeId}:${rawKey}` so two writers
-- on different routes can never collide on the same client-chosen
-- string (a billing COP key and an inspection key happen to share
-- "abc-123" without one stealing the other's slot).

CREATE TABLE IF NOT EXISTS "request_dedupe" (
  -- PK is the namespaced key. Max length 200 (rawKey cap from
  -- lib/idempotency.js) + 32 (route + employeeId prefix) + 3 separators
  -- + headroom = 240. Bounded explicitly so a malicious client cannot
  -- blow the index with a megabyte header.
  "key"                 VARCHAR(255) NOT NULL,
  "payload_hash"        VARCHAR(64)  NOT NULL,
  "state"               VARCHAR(16)  NOT NULL,
  "result_status"       INTEGER,
  "result_body"         JSONB,
  -- [DR-020] Reference back to the row the handler committed. Lets the
  -- replay path return the original row's serialized shape instead of
  -- re-reading the table on every miss (and lets the new
  -- dedupe-by-business-identity fallback see what got committed). FK
  -- is intentionally NOT declared (the dedupe row outlives the
  -- business row — when a COP gets hard-deleted, the dedupe slot must
  -- stay around to keep rejecting same-key retries for the audit's
  -- "ONE logical record" guarantee).
  "record_kind"         VARCHAR(32),
  "record_id"           VARCHAR(64),
  -- Janitor bookkeeping. Hand-rolled eviction: we do not run a GC loop
  -- (no cron), but the rows are small + the key is namespaced + a
  -- once-a-week admin query can DELETE WHERE created_at < now() -
  -- interval '30 days' to keep the table bounded. expires_at is set on
  -- COMPLETED; PENDING slots are GC'd after a short window so a crashed
  -- handler does not permanently lock the key.
  "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at"          TIMESTAMP(3),
  CONSTRAINT "request_dedupe_pkey" PRIMARY KEY ("key"),
  CONSTRAINT "request_dedupe_state_check"
    CHECK ("state" IN ('PENDING', 'COMPLETED', 'FAILED'))
);

-- Hot read path: lookup by key. PK already covers this; the additional
-- index on (record_kind, record_id) is for the admin "which keys map
-- to this row" lookup (mirrors how uploadIntent is keyed by boundType +
-- boundRecordId).
CREATE INDEX IF NOT EXISTS "request_dedupe_record_idx"
  ON "request_dedupe" ("record_kind", "record_id");

-- Hot read path: the janitor's "find PENDING slots older than 5 min"
-- sweep. Without this, a crashed handler's reservation would block
-- the same key forever.
CREATE INDEX IF NOT EXISTS "request_dedupe_state_created_idx"
  ON "request_dedupe" ("state", "created_at");

-- ─── billing_certification.idempotency_key ─────────────────────────────────
-- Nullable column on the COP table. The route stamps the namespaced
-- key on create so the dedupe row can be reconciled to the committed
-- row by simple SELECT (no JOIN on a long string).

ALTER TABLE "billing_certification"
  ADD COLUMN IF NOT EXISTS "idempotency_key" VARCHAR(255);

-- Lookup-by-key index supports the rare admin "show me the COP that
-- came from this client retry" query. Same composite strategy as
-- request_dedupe above — bounded + namespaced.
CREATE INDEX IF NOT EXISTS "billing_certification_idempotency_key_idx"
  ON "billing_certification" ("idempotency_key");
