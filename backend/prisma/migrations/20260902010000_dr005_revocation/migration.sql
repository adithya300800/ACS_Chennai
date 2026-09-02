-- Round-20 DR-005: durable token revocation.
--
-- Background: "sign out" did not end a session.
--
--   * routes/auth.js kept a per-process `tokenBlacklist` Map and exported an
--     `isTokenRevoked()` helper that middleware/auth.js never called. Logout
--     therefore revoked nothing at all — a bearer token copied out of
--     localStorage stayed valid for the rest of its 24h life.
--   * Refresh tokens were bare stateless JWTs with no server-side record, so
--     they could not be rotated or terminated and were worth a full 7 days of
--     access to anyone holding a copy.
--   * Even the Map that did exist was process-local, so a Render restart or
--     redeploy silently un-revoked every token in it.
--
-- This migration adds the two tables that make revocation durable:
--
--   revoked_token  — one row per access token killed by logout, keyed by the
--                    token's `jti` claim. requireAuth now consults this on
--                    every authenticated request.
--   refresh_token  — one row per issued refresh token, storing sha256(token)
--                    and NEVER the token itself. `rotated_from_id` chains the
--                    rotation history; a non-null `revoked_at` marks a row as
--                    spent, which is what makes replay detection possible.
--
-- Neither table carries a foreign key to `employees`. A revocation record must
-- outlive the employee row it refers to — deleting an employee must not
-- cascade-delete the rows that deny their still-unexpired tokens. `employee_id`
-- is kept as a plain column for audit and for bulk "revoke all sessions".
--
-- Both tables are indexed on `expires_at` so lib/revocation.js pruneExpired()
-- can drop rows that can no longer deny anything.
--
-- DDL generated with `prisma migrate diff --script` (see the DR-005 report for
-- why `prisma migrate dev` could not be run in this environment). Note the
-- deploy pipeline currently applies schema via `prisma db push`
-- (.github/workflows/backend-deploy.yml), so this file is the reviewable
-- record of the change rather than the thing that runs in production.

-- CreateTable
CREATE TABLE "revoked_token" (
    "jti" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "revoked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "revoked_token_pkey" PRIMARY KEY ("jti")
);

-- CreateTable
CREATE TABLE "refresh_token" (
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotated_from_id" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),

    CONSTRAINT "refresh_token_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "revoked_token_expires_at_idx" ON "revoked_token"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_token_token_hash_key" ON "refresh_token"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_token_employee_id_idx" ON "refresh_token"("employee_id");

-- CreateIndex
CREATE INDEX "refresh_token_expires_at_idx" ON "refresh_token"("expires_at");
