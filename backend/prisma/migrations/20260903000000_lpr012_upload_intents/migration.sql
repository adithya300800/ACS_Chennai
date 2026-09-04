-- LPR-012 (round-26): durable upload intent registry.
--
-- Background: the previous upload handshake stored (employeeId, ulid)
-- pairs in a process-local Map (`pendingUploads` in src/lib/uploadRoutes.js).
-- That meant a process restart mid-upload would orphan the blob, and a
-- horizontal-scale deploy could not share the registry. The SOL
-- production-readiness reassessment (LPR-012) flagged this as the next
-- gap after the round-20 storage hardening (DR-017).
--
-- This migration:
--   - Creates an `upload_intent` table with employee ownership,
--     scoped blob path, content-type, status (PENDING/CONFIRMED/EXPIRED),
--     and expiry.
--   - Adds a composite unique index on (employee_id, ulid) so a single
--     ulid can never collide across employees (defence-in-depth — ulid is
--     already server-generated).
--   - Adds an index on (status, expires_at) so the future orphan-cleanup
--     cron can scan EXPIRED rows cheaply.
--   - Adds a CASCADE FK back to employees so deleting an employee also
--     drops their intents (no orphans).
--
-- The in-process pendingUploads Map in uploadRoutes.js is preserved as a
-- hot-path cache for the 20-min TTL sweeper — the DB row is the source of
-- truth from this point forward.

CREATE TABLE "upload_intent" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "employee_id" UUID NOT NULL,
  "ulid"        TEXT NOT NULL,
  "container"   TEXT NOT NULL,
  "blob_path"   TEXT NOT NULL,
  "content_type" TEXT NOT NULL,
  "status"      TEXT NOT NULL DEFAULT 'PENDING',
  "expires_at"  TIMESTAMP(3) NOT NULL,
  "confirmed_at" TIMESTAMP(3),
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "upload_intent_employee_id_fkey"
    FOREIGN KEY ("employee_id")
    REFERENCES "employees"("id")
    ON DELETE CASCADE
);

-- Defence-in-depth: even though ulid is server-generated, the unique
-- index prevents a single ulid from ever being re-used across employees.
CREATE UNIQUE INDEX "upload_intent_employee_id_ulid_key"
  ON "upload_intent"("employee_id", "ulid");

-- Hot-path for the future EXPIRED-cleanup cron (and any "show me active
-- intents" admin view): scan by status + expiry without scanning the
-- whole table.
CREATE INDEX "upload_intent_status_expires_at_idx"
  ON "upload_intent"("status", "expires_at");

-- Per-employee intent lookup (e.g. when a user lands on the upload page
-- and the client wants to know which uploads are still in flight).
CREATE INDEX "upload_intent_employee_id_status_idx"
  ON "upload_intent"("employee_id", "status");
