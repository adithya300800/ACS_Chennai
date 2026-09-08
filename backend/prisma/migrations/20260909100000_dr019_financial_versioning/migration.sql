-- ─────────────────────────────────────────────────────────────────────────────
-- DR-019 (audit, 2026-09-08) — Version-pinned financial approvals + correction
--                              history for BillingCertification + VariationOrder
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Audit verdict (Code review by SOL/ACS-Portal-Workflow-Completeness-Review-
-- 2026-09-08-5c61cd8.md, lines 300-310):
--
--   "No-PDF draft -> CERTIFIED -> DISPUTED worked. There was no draft/
--    correction editor; disputed offered recertification rather than a
--    correction workflow. Source permits certified amounts/PDF to change
--    while retaining prior approval metadata. Competing VO/COP decisions
--    and stale edits read state first and later update by ID alone — no
--    version pin."
--
-- Repair / acceptance:
--   "support draft correction (CERTIFIED -> edit -> corrected CERTIFIED);
--    bind a certification to a content version; retain prior amounts,
--    reasons and actors. Use conditional state/version writes so one
--    competing decision wins and stale content cannot silently change an
--    approved version."
--
-- This migration adds four things:
--
--   1. `version` Int @default(0) on both billing_certification and
--      variation_order. Every content-changing PATCH (and every
--      status-transition) increments it; the WHERE clause on the
--      conditional update pins the CLIENT-supplied version (matching the
--      DPR LPR-008 pattern in backend/src/routes/dpr.js:1309-1326) so a
--      stale editor cannot overwrite an approved row.
--
--   2. `parent_certification_id` String? on billing_certification.
--      Nullable self-reference — points at the prior version when a
--      CORRECTED row is created. History view is a recursive select over
--      this FK; no separate immutable audit table needed (per the audit's
--      "focused approval snapshot/audit trail is sufficient; wholesale
--      event sourcing is not required" adversarial resolution).
--
--   3. `superseded_at` DateTime? on billing_certification. Stamped on
--      the original CERTIFIED row when a CORRECTION is created from it.
--      Lets the list/aggregates distinguish "active" rows (NULL) from
--      "history" rows (NOT NULL) without losing the prior amounts /
--      reasons / actors — the audit's "retain prior approval metadata"
--      requirement. SupersededAt is NOT the same as deletedAt: a
--      deletedAt row is archived (gone from every list); a supersededAt
--      row is history (gone from the default list but still retrievable
--      via the detail / corrections endpoints).
--
--   4. Indexes on parent_certification_id + superseded_at cover the
--      "show me the correction chain for this row" + "filter the list
--      to active rows only" hot reads.
--
-- Why a new migration (not an edit to r37_billing_certifications / n2)
-- --------------------------------------------------------------------
-- Append-only by Phase-4 P0 policy (see memory/phase-4-p0-s3-6-typo-and-
-- baseline-hazard.md). The originals stay frozen as the audit trail for
-- the initial R37 / N2 schemas.
--
-- Idempotency
-- -----------
-- All DDL uses IF NOT EXISTS / DO $$ blocks (verified against Postgres
-- 15 on Supabase). A re-run against a partially-applied DB is a no-op.
--
-- Backward compatibility
-- ----------------------
-- Existing rows get version=0 by default — the migration is safe on
-- legacy data. parent_certification_id defaults to NULL — existing
-- CERTIFIED rows simply have no parent. The version pin becomes active
-- the moment any client passes {version: 0} in a PATCH body (or no
-- version, in which case the route's PATCH-only-update preserves
-- legacy behaviour for clients that haven't upgraded yet — see
-- billingCertifications.js PATCH handler comments for the exact
-- contract).
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── billing_certification.version ──────────────────────────────────────────
-- Default 0 — same convention as DPR.version which defaults to 1 on
-- create (see backend/prisma/schema.prisma:245). BillingCertification
-- uses 0 because legacy rows from r37 land at 0; new rows from POST are
-- stamped with version=0 on create and incremented on every PATCH /
-- state transition. The route's conditional update reads
-- `existing.version` (the live value) and writes
-- `version: { increment: 1 }`, so 0 is the natural starting point.

ALTER TABLE "billing_certification"
  ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 0;

-- ─── billing_certification.parent_certification_id ──────────────────────────
-- Self-referencing FK. Nullable: rows that aren't corrections have
-- NULL here. ON DELETE SET NULL so a hard-delete of an old row doesn't
-- cascade-delete the corrected row's pointer back to it (matches
-- ProjectAssignment.assignedById's SetNull pattern — preserving the
-- audit trail when an admin is removed).

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'billing_certification'
      AND column_name = 'parent_certification_id'
  ) THEN
    ALTER TABLE "billing_certification"
      ADD COLUMN "parent_certification_id" TEXT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'billing_certification_parent_certification_id_fkey'
  ) THEN
    ALTER TABLE "billing_certification"
      ADD CONSTRAINT "billing_certification_parent_certification_id_fkey"
      FOREIGN KEY ("parent_certification_id")
      REFERENCES "billing_certification"("id")
      ON DELETE SET NULL;
  END IF;
END $$;

-- Index on parent_certification_id — supports the "show me the
-- correction chain for this row" lookup (recursive select from a
-- parent down to the latest corrected version).

CREATE INDEX IF NOT EXISTS "billing_certification_parent_certification_id_idx"
  ON "billing_certification" ("parent_certification_id");

-- ─── billing_certification.superseded_at ────────────────────────────────────
-- Stamped when an admin POSTs /:id/correct — distinguishes "this row is
-- archived" (deletedAt) from "this row is replaced by a newer
-- correction" (supersededAt). A superseded row keeps all its audit
-- metadata (certifiedById, certifiedAt, certifiedAmount, disputeReason,
-- etc.) intact so the correction history can be re-walked from the
-- corrected row's parentCertificationId back to the original.

ALTER TABLE "billing_certification"
  ADD COLUMN IF NOT EXISTS "superseded_at" TIMESTAMP(3);

-- Index on superseded_at — supports the list / aggregates filters
-- (`WHERE superseded_at IS NULL`). Without it, every list read does a
-- seq scan filtering superseded rows.

CREATE INDEX IF NOT EXISTS "billing_certification_superseded_at_idx"
  ON "billing_certification" ("superseded_at");

-- ─── variation_order.version ────────────────────────────────────────────────
-- Default 0 (mirrors billing_certification above). Every PATCH on a
-- DRAFT row, and every state transition (submit / approve / reject),
-- increments it. The conditional-update pattern is identical to the
-- one pinned in backend/src/routes/dpr.js:2014-2024 — WHERE
-- id = ? AND version = ?; a stale reader whose read happened BEFORE
-- another writer's commit gets P2025 → 409 VERSION_CONFLICT instead
-- of silently overwriting the new state.

ALTER TABLE "variation_order"
  ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 0;
