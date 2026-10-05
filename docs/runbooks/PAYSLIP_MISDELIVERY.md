# Payslip Misdelivery Runbook

> **Scope.** Operator-facing procedure for retiring a payslip that was sent
> to the wrong employee, or to the right employee for the wrong period,
> or any other case where the PDF bytes must be removed from R2 without
> delay. The row is **tombstoned, not hard-deleted** — the audit trail
> survives the byte retirement.

**Pre-flight.** Before ANY operator runs ANY purge command:

```bash
source scripts/db-host-guard.sh
echo "$DB_HOST_OK"  # MUST print 1
```

If `DB_HOST_OK` is unset or `0`, the script refused the `DATABASE_URL`
because it points at production Supabase (`tqmmspqvqtajbijbbsii`).
**Stop. Do not bypass it. Take this to a developer.**

The purge script itself re-checks the host and refuses to run against
production even if the pre-flight was skipped.

---

## 1. Triage (the operator's first five minutes)

1. **Identify the offending row.**

   ```sql
   SELECT id, employee_id, year, month,
          blob_container, blob_path,
          published_at, deleted_at, purged_at,
          published_by_id, revoked_by_id, purged_by_id
     FROM payslip
    WHERE id = '<payslip-id>';
   ```

   Note `blob_container`. The script **refuses** any container other
   than `dpr-documents` (the v1 payslip bucket). If the row's blob is
   in a different bucket, this runbook does not apply — escalate to a
   developer with the row id.

2. **Confirm the deletion before publication.**
   The script does NOT verify the PDF was actually downloaded by the
   wrong recipient — only that the row was published and should not
   have been. The HR partner confirms; the operator does the audit.

3. **HR phones the wrong recipient directly.**
   In-person or phone. **NEVER email.** A misdelivery notification is
   itself a leak vector — the wrong recipient gets a second PDF
   mentioning their salary in plaintext. The runbook forbids this.
   The operator records the call in the runbook log (template below).

---

## 2. Step 1: Revoke (always first)

Revoke marks the row as soft-deleted so it disappears from every
employee-facing surface immediately. The audit is captured in the
`revokedAt` / `revokedById` / `revokedReason` columns.

**Prefer the admin UI** for the revoke step unless the row is already
revoked. The admin Revoke button captures the same audit columns and
adds a UI breadcrumb for HR's post-incident review.

If the admin UI is unreachable, the script does the revoke inline
(Step 3 below). Same audit, no UI breadcrumb.

---

## 3. Step 2: Purge (the script)

```bash
node backend/scripts/purge-misdelivered-payslip.js \
  --payslip-id <uuid> \
  --operator-id <admin-uuid> \
  --reason '<short audited reason, no salary / UAN / PAN / tax id>'
```

**Dry-run is the default.** The script prints exactly what would
change and what would be deleted, then exits 0 without writing
anything. Inspect the plan.

Re-run with `--apply` to commit:

```bash
node backend/scripts/purge-misdelivered-payslip.js \
  --payslip-id <uuid> \
  --operator-id <admin-uuid> \
  --reason '<short audited reason>' \
  --apply
```

The script:

1. Revokes the row (only if not already revoked) — captures
   `deletedAt`, `revokedAt`, `revokedById`, `revokedReason`.
2. Tombstones the row — stamps `purgedAt`, `purgedById`,
   `purgedReason`.
3. Deletes the R2 object from the recorded `blob_container` /
   `blob_path`. A blob already gone (404) is reported but does not
   fail the tombstone stamp — the audit wins.

### Exit codes

| Code | Meaning | Operator action |
|---|---|---|
| 0 | Success (dry-run or applied) | Continue. |
| 2 | Bad CLI args / missing required flag | Fix the command, re-run. |
| 3 | Refused by safety guard | Read the message — usually "already purged" (no-op, exit 0 next time) or "blob container out of scope" (escalate). |
| 1 | Fatal — DB or R2 unreachable | Re-run after the outage clears. The tombstone stamp is in one Prisma update, the blob delete is a separate call — re-running is safe. |

---

## 4. Step 3: Verify (post-conditions)

```sql
-- 1. The four-guard predicate now excludes the row from every
--    portal read (employee list, employee download, employee
--    portal coverage).
SELECT id, employee_id, year, month,
       published_at, deleted_at, purged_at
  FROM payslip
 WHERE id = '<payslip-id>';
-- Expect: deleted_at IS NOT NULL AND purged_at IS NOT NULL.

-- 2. The partial unique index freed up the (employee, year, month)
--    tuple — a corrected re-upload can be bound without first
--    manually deleting the tombstone.
SELECT count(*) AS active_rows_for_same_period
  FROM payslip
 WHERE employee_id = '<employee-id>'
   AND year        = <year>
   AND month       = <month>
   AND deleted_at IS NULL;
-- Expect: 0 (or 1 if HR already re-uploaded).

-- 3. The R2 object is gone.
--    Use `aws s3api head-object` or the R2 dashboard with the
--    row's `blob_container` and `blob_path`. Expect 404.
```

The admin list endpoint `/api/admin/payslips` keeps showing the
tombstoned row (with `purgedAt` / `purgedReason` / `purgedById`
populated) — that's by design, the audit trail stays.

---

## 5. What the script does NOT do

- **Does NOT email the wrong recipient.** The HR phone call is the
  notification. See §1 step 3.
- **Does NOT hard-delete the row.** The row is tombstoned.
- **Does NOT cascade-delete dependent rows.** `DPRPhoto`,
  `InspectionPhoto`, and other modules that share the `blob_path`
  namespace are untouched (the payslip blob prefix
  `payslips/<employeeId>/<ulid>.pdf` is disjoint from the photo
  prefix).
- **Does NOT touch the `EmailLog` row.** The audit row from the
  publish step stays — HR reviews it during the incident write-up.
- **Does NOT touch `AppLog`.** A future enhancement would write a
  `payslip.purged` AppLog row from the script; out of scope for v1.

---

## 6. Operator log (per incident)

```
date          : YYYY-MM-DD
operator      : <name>, <admin-id>
hr partner    : <name>, <phone>
wrong recipient : <employee-id>
correct period : YYYY-MM
script run     : <timestamp> --apply
exit code      : 0
phone call made: HH:MM, by <name>
notes          :
```

File a copy in the HR partner's ticket system. The script's audit
columns are the system's record; the log is the operator's record.

---

## 7. Tests / coverage

`backend/__tests__/payslip-purge.test.js` covers the helper, the
script's argv parser, the dry-run default, and the safety guards
(already-purged no-op, not-yet-revoked refusal, blob container
out-of-scope refusal, PII-in-reason refusal, idempotent re-run,
apply-mode happy path).

---

## 8. Related

- Plan: `docs/plans/PAYSLIPS_STAGE1_ORDER.md` §3 commit 8.
- Helper: `backend/src/lib/payslip.js#purgePayslipBlob`.
- Script: `backend/scripts/purge-misdelivered-payslip.js`.
- Pre-flight guard: `scripts/db-host-guard.sh`.
- Schema: `backend/prisma/schema.prisma` (`payslip` model, the
  `purgedById` / `purgedAt` / `purgedReason` columns).
- Partial unique index: `backend/prisma/migrations/20261002010001_payslip_partial_unique/`.