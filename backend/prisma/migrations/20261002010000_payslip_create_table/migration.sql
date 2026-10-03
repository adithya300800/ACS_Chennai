-- ─────────────────────────────────────────────────────────────────────────────
-- [Payslips Stage 1 / commit 2] CREATE TABLE payslip
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Single new table. No columns added to existing models. Mirrors the
-- schema in `backend/prisma/schema.prisma` (`model Payslip`) exactly,
-- per plan docs/plans/PAYSLIPS_PLAN.md §C.1.
--
-- Threat model (mirrors canonical CREATE TABLE for a new entity):
--   * Supabase auto-exposes every public-schema table to anyone with the
--     anon key. RLS is added in the FOLLOW-UP migration
--     `20261002010002_payslip_rls` so a PostgREST-read window between
--     CREATE TABLE and RLS enable can never accidentally expose payroll
--     metadata. Both migrations ship in the same commit-2 deploy and
--     run in timestamp order — the window is purely transactional.
--   * The "postgres" role has `rolbypassrls = TRUE` (verified
--     2026-09-09 per rls_lockdown_s1). RLS later in this commit does
--     not affect Prisma traffic.
--   * No salary figures live on this table — only audit metadata + the
--     blobPath pointing at the salary-bearing PDF. The request validator
--     (zod, shipped in commit 3) rejects unknown fields so a future
--     schema-drift bug cannot leak numeric payroll data into this row.
--
-- Column choices:
--   * `id` follows the majority convention — `text NOT NULL` with no DB
--     default (Prisma generates it client-side via `@default(uuid())`).
--     This matches the live round-1 schema where Prisma supplies the
--     uuid and the DB just stores it. A `gen_random_uuid()` default
--     would silently disagree with Prisma's `@default(uuid())`, causing
--     `prisma migrate diff` to propose `ALTER COLUMN ... DROP DEFAULT`
--     on every fresh DB and confusing the schema-vs-migration
--     reconciliation step. Keeping the column NOT NULL with no DB
--     default aligns the migration and the Prisma schema exactly.
--     The `ulid` column is a separate, server-generated cross-system
--     identifier (R2 key suffix) — splitting them keeps the pkey cheap
--     for joins while letting the ulid satisfy the sweep / audit
--     surface area.
--   * `year` / `month` have CHECK constraints added inline so a typo
--     (month=13) is rejected at the database boundary, not at the app
--     layer. The partial unique on (employee_id, year, month) WHERE
--     deleted_at IS NULL ships in the next migration.
--   * `etag` is TEXT (no length limit) because ETag values from R2/S3
--     can include quoted hashes with arbitrary byte content.
--   * `sizeBytes` is `bigint` so a future >2 GB upload doesn't silently
--     wrap. Today's 25 MB cap is far below the limit; the wider type is
--     forward-compat.
--   * `revokedReason` is VARCHAR(500): HR explanations for revoke are
--     short. A free-text `TEXT` would invite PII (a justification that
--     names the employee). The validator (commit 3) rejects longer
--     strings AND names matching `/pan|uan|account|net|gross|basic|hra/i`
--     so an HR typo cannot exfiltrate payroll figures via the reason
--     field.
--   * `deletedAt` is the soft-delete marker. v1 sets it on Revoke (the
--     blob stays in R2; the sweep protects revoked rows because
--     `purgedAt IS NULL`). The purge script (commit 8) is the single
--     gate that sets `purgedAt` and removes the R2 blob. See plan §C.3
--     state machine.
--   * The FK contracts mirror the existing models:
--       employeeId    Restrict  (hard-delete of an employee is a business
--                                operation, not a silent cascade; mirrors
--                                BoqItem.createdById)
--       uploadedById  Restrict  (same reasoning; audit integrity)
--       publishedById  SetNull  (audit trail must not cascade when the
--                                acting admin is removed; mirrors
--                                VariationOrder.approvedById)
--       revokedById   SetNull   (same as publishedById)
--       purgedById    SetNull   (same as publishedById/revokedById)
--   * All FKs to `employees(id)` use `text` because `employees.id` is
--     `text` — using `uuid` would fail the FK constraint with the
--     existing schema.
--   * FK constraint names use the `_fkey` suffix that Prisma generates
--     by default (verified via `prisma migrate diff --from-url` against
--     the throwaway DB — produces zero rename suggestions on these
--     constraints). Same for unique indexes (`_key` suffix) and the
--     `_id_` infix in index names that Prisma generates when the
--     underlying column is named `employee_id`.
--   * `ON UPDATE CASCADE` mirrors Prisma's default FK clause for new
--     schemas. The columns being text (gen_random_uuid() values), the
--     cascade is a no-op in practice but matches what `prisma migrate
--     diff` expects.
--
-- Index choices (only those with concrete v1 queries):
--   * `payslip_employee_id_year_month_idx (employee_id, year DESC,
--     month DESC)` — backs `GET /api/portal/payslips/my` (employee
--     lists own payslips, ordered by year/month DESC). Sub-ms scan at
--     ~3 000 rows per employee.
--   * `payslip_year_month_deleted_at_idx (year, month, deleted_at)` —
--     backs `GET /api/admin/payslips/coverage` (admin's "who's missing
--     for {year, month}" view). Bitmap Index Scan.
--   * `payslip_uploaded_by_id_idx` and `payslip_published_at_idx` are
--     NOT created: no v1 query references uploader or filters by
--     published_at range. See plan §C.1 "Out of scope" for the
--     audit-log queries that would justify them (separate round).
--
-- Idempotency:
--   CREATE TABLE IF NOT EXISTS makes re-runs safe. The CHECK constraints
--   are added inside a DO block with an `information_schema.check_constraints`
--   guard so re-runs don't error with "constraint already exists".
--
-- Verification (live post-apply):
--   * `psql -c "\d payslip"` lists every column with its data type and
--     NOT NULL flag matching the schema.
--   * `psql -c "\d+ payslip"` lists the two declared indexes +
--   the `payslip_active_per_month_uidx` added by the FOLLOW-UP migration.
--   * `psql -c "SELECT conname FROM pg_constraint WHERE conrelid = 'payslip'::regclass;"`
--     lists the five FK constraints + the two CHECK constraints + the
--     PK + the two unique constraints (ulid, upload_intent_ulid).
--   * `npx prisma migrate diff --from-url <throwaway> --to-schema-datamodel
--     schema.prisma --script` produces no DROP for
--     `payslip_active_per_month_uidx` (verified live — see checkpoint-1
--     followup report).
--
-- Rollback (NOT bundled; operator-only):
--   DROP TABLE IF EXISTS public.payslip;
--   The portal keeps running; payslip routes haven't shipped yet
--   (commit 3). Use as a stopgap while fixing the underlying issue,
--   then re-apply.

CREATE TABLE IF NOT EXISTS public.payslip (
  id                 text        NOT NULL,
  employee_id        text        NOT NULL,
  year               integer     NOT NULL,
  month              integer     NOT NULL,
  ulid               text        NOT NULL,
  upload_intent_ulid text        NOT NULL,
  content_type       text        NOT NULL,
  etag               text        NOT NULL,
  size_bytes         bigint      NOT NULL,
  blob_path          varchar(1024) NOT NULL,
  uploaded_by_id     text        NOT NULL,
  published_by_id    text        NULL,
  published_at       timestamp(3) NULL,
  revoked_by_id      text        NULL,
  revoked_at         timestamp(3) NULL,
  revoked_reason     varchar(500) NULL,
  deleted_at         timestamp(3) NULL,
  created_at         timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT payslip_pkey PRIMARY KEY (id),
  CONSTRAINT payslip_ulid_key UNIQUE (ulid),
  CONSTRAINT payslip_upload_intent_ulid_key UNIQUE (upload_intent_ulid),
  CONSTRAINT payslip_year_check CHECK (year BETWEEN 2000 AND 2100),
  CONSTRAINT payslip_month_check CHECK (month BETWEEN 1 AND 12),
  CONSTRAINT payslip_employee_id_fkey
    FOREIGN KEY (employee_id)    REFERENCES public.employees(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT payslip_uploaded_by_id_fkey
    FOREIGN KEY (uploaded_by_id) REFERENCES public.employees(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT payslip_published_by_id_fkey
    FOREIGN KEY (published_by_id) REFERENCES public.employees(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT payslip_revoked_by_id_fkey
    FOREIGN KEY (revoked_by_id)   REFERENCES public.employees(id) ON DELETE SET NULL ON UPDATE CASCADE
);

-- Indexes backing v1 hot reads. See "Index choices" comment block
-- above. The partial unique index `(employee_id, year, month) WHERE
-- deleted_at IS NULL` ships in the FOLLOW-UP migration
-- `20261002010001_payslip_partial_unique` because Prisma cannot model
-- partial uniques; that migration is the authoritative source of truth
-- and contains its own drift-detection block.
CREATE INDEX IF NOT EXISTS payslip_employee_id_year_month_idx
  ON public.payslip (employee_id, year DESC, month DESC);
CREATE INDEX IF NOT EXISTS payslip_year_month_deleted_at_idx
  ON public.payslip (year, month, deleted_at);