-- ─────────────────────────────────────────────────────────────────────────────
-- DR-002 (fresh-product audit 2026-09-24) — durable rotation receipt
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Trigger:
--   The audit's DR-002 finding traces the failure mode where /api/auth/refresh
--   spent the old refresh-token row (via claimRefreshToken's CAS) BEFORE
--   looking up the employee, inserting the successor row, or publishing the
--   in-memory replay entry. The combination produces two concrete bugs:
--
--     1. A legitimate concurrent loser (a sibling tab that raced for the same
--        shared refresh token) can arrive in the brief window after the spend
--        but before rememberRotation() publishes the replay entry. The
--        claimRefreshToken CAS loses, the in-memory replay lookup misses, and
--        the loser is treated as a thief — every live session for the
--        employee is revoked. False theft revocation.
--
--     2. A pre-commit failure (DB error between claimRefreshToken and
--        recordRefreshToken in the old code) leaves the token spent with no
--        successor and no recoverable ordinary retry — the only usable
--        session is consumed without an explicit recovery outcome.
--
--   The fix lives in lib/revocation.js (spend + successor + receipt in ONE
--   transaction) and routes/auth.js (loser path consults the durable receipt
--   when the in-memory replay cache misses). This migration is just the
--   durable storage the receipt needs.
--
-- Schema (matches backend/prisma/schema.prisma's RotationReceipt model
-- header — keep the two in sync):
--   spent_row_id      — UNIQUE; the refresh_token row that was spent
--   successor_row_id  — the new refresh_token row minted in the same tx
--   employee_id       — for the loser-path log line; the receipt itself
--                       is keyed by spent_row_id, not employee
--   access_token      — short-lived (15m) but we need the full JWT to hand
--                       back to the loser; the loser already presented the
--                       old token, so they have no other way to recover it
--   refresh_token     — also plaintext; we cannot reverse sha256 to recover
--                       it for a re-presented loser
--   created_at        — sub-second ordering under rotation bursts
--   expires_at        — matches the successor refresh_token row's expiresAt;
--                       pruneExpired() deletes receipts whose pair is gone
--
-- Plaintext tokens in this table are a deliberate trade-off:
--   * Without them, the loser has no way to receive the winner's pair
--     after a process restart / lost response / lost-replay-cache window.
--   * Exposure is bounded by the TTL (7d, matches refresh token expiry)
--     and by the pruner deleting receipts the moment their successor
--     expires.
--   * We do NOT add RLS — there is no PostgREST anon surface reading
--     this table; the only writer is the backend's transaction body
--     (postgres role, BYPASSRLS). All reads go through prisma.*.
--
-- Idempotency:
--   CREATE TABLE uses IF NOT EXISTS so re-runs of the migration don't
--   fail. CREATE UNIQUE INDEX IF NOT EXISTS ditto. The migration file
--   itself is wrapped in BEGIN/COMMIT so the table + index land or
--   neither does.
--
-- Rollback (NOT bundled in this file):
--   DROP INDEX IF EXISTS rotation_receipt_expires_at_idx;
--   DROP INDEX IF EXISTS rotation_receipt_spent_row_id_key;
--   DROP TABLE IF EXISTS rotation_receipt;
--   The portal keeps running — only the durable recovery for a lost
--   post-rotation response disappears, falling back to the in-memory
--   replay window (30s) for the concurrent-tab case.
--
-- Out of scope (separate commits, not this migration):
--   * lib/revocation.js — rotateRefreshTokenAtomic + findRotationReceiptBySpentRowId
--   * routes/auth.js — loser-path uses the durable receipt when replay misses
--   * tests — backend/__tests__/dr002-refresh-rotation.test.js
--
-- Lint IDs to re-check after apply:
--   * 0013 rls_disabled_in_public — table is intentionally RLS-off (only the
--     postgres role writes/reads; no PostgREST surface).
--   * 0023 sensitive_columns_exposed — plaintext token columns will flag
--     here. The access token is short-lived; the refresh token is hashed
--     only in refresh_token, plaintext only here. Accept this exposure
--     because the receipt IS the durable replay channel.
--

BEGIN;

CREATE TABLE IF NOT EXISTS public.rotation_receipt (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  spent_row_id     TEXT         NOT NULL,
  successor_row_id TEXT         NOT NULL,
  employee_id      TEXT         NOT NULL,
  access_token     TEXT         NOT NULL,
  refresh_token    TEXT         NOT NULL,
  created_at       TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  expires_at       TIMESTAMPTZ(6) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS rotation_receipt_spent_row_id_key
  ON public.rotation_receipt (spent_row_id);

CREATE INDEX IF NOT EXISTS rotation_receipt_expires_at_idx
  ON public.rotation_receipt (expires_at);

COMMIT;
