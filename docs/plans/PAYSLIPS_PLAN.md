# Payslip Feature — Implementation Plan (v2 — 2026-10-02)

**Status:** Planning only. No code, no migrations, no pushes.
**v2 changes from v1:** publish-gate state machine (state machine A′), `publishedById`/`publishedAt`/`revokedById`/`revokedAt`/`revokedReason` audit columns on the row, dropped `originalFilenameHash` and `contentVersion`, no cursor pagination, magic-byte sniff at `confirm` (not at intent), per-row picker (not the legacy `EMPID_mmyyyy.pdf` filename pattern), documented manual purge script for misdelivery, R2 backup gap documented, new-joiner coverage uses `Employee.createdAt` proxy until HR supplies a true `joinedAt`. v2 details in §K.

---

## Constraint summary (read first)

- **Single-tenant** (per [TENANCY.md](../../TENANCY.md)): ACS Chennai only, `acschennai.com` OAuth allowlist, single R2 account, single Supabase DB.
- **No salary figures stored.** The PDF is the only salary-bearing artifact. We store document + metadata; no amount, net, gross, tax, deductions, basic, hra, pf, PAN, UAN, or any numeric pay field. **The request validator (zod) must reject unknown fields, not just omit them.**
- **No `employee_code` / `payroll_id` field exists** on [Employee](../../backend/prisma/schema.prisma). The plan uses Employee.id (uuid) or Employee.email for attribution. There is **no** `joinedAt`/`hireDate` field either — see §C.7 for the new-joiner coverage decision (use `Employee.createdAt` as proxy).
- **Reuse existing infrastructure**: [mountUploadRoutes](../../backend/src/lib/uploadRoutes.js) (DR-021), [blobStorage](../../backend/src/lib/blobStorage.js) (R2 SAS, ULID, verifyBlobExists, **new** verifyBlobMagicBytes), [uploadIntentBinding](../../backend/src/lib/uploadIntentBinding.js) (DR-001/006/008), [requestLogger](../../backend/src/middleware/requestLogger.js) (AppLog), [auth middleware](../../backend/src/middleware/auth.js) (requireAuth / requireAdmin / requireFreshAdmin), [notify](../../backend/src/lib/notify.js) (Notification + EmailLog), [rateLimit](../../backend/src/middleware/rateLimit.js), and the existing [RLS pattern](../../backend/prisma/migrations/20260910000000_rls_lockdown_s1/migration.sql) (S1 lockdown).
- **DR-001 destructive cleanup is disabled in production** without `?override=DR001_RECONCILED` or `DR001_RECONCILED` env. Soft-delete only; **no** `internal-payslip-sweep` in v1.
- **Privacy is the primary design driver.** This drives every API, RLS, email, and download decision below.
- **Audit history lives on the row, not in `AppLog`.** `AppLog` retention is 30 days and the team is logging less — neither is payroll-grade. All who/when/why fields are nullable columns on `Payslip` (§C.1).
- **Backup gap.** The nightly DB backup does not cover R2 files. R2's own 11-nines durability is the only safety net. Documented in §J.12.

---

## A. Scope and personas

### A.1 In v1

- Admin (HR/payroll) uploads one PDF per employee per month via drag-and-drop or single-file pick. Each dropped file sits beside an unsetsed employee picker; admin resolves all rows before confirming.
- Admin coverage view: which employees have / have not got a payslip for the selected month. Filtered to exclude employees who were not yet in the system for that month (see §C.7).
- **Two-step lifecycle**: upload creates a **draft** row (not visible to the employee, no email). Admin clicks **Publish {Month}** to flip every draft for the month to **published** and fire per-employee emails.
- Admin can publish a single draft in isolation (for late additions).
- Admin replace: re-uploading a payslip for the same (employee, year, month) silently supersedes via soft-delete. New row sits in draft until published.
- Admin revoke: soft-delete with `revokedAt`, `revokedById`, optional `revokedReason`. Employee sees "Contact HR" on next view.
- Manual misdelivery purge: documented `scripts/purge-payslip-misdelivery.js` for hard-delete of a soft-deleted row + its R2 blob. Idempotent. No cron.
- Employee "My Payslips" list: **plain newest-first list**, no pagination (≤50 rows cap).
- Employee download: streams through our origin (no raw R2 SAS reaches the browser), `Content-Disposition: attachment; filename="Payslip-{Month}-{Year}.pdf"`.
- In-portal bell notification per published payslip.
- Email notification per published payslip (link only — never attach the PDF), throttled to the mail provider's limits.
- Audit log via existing [AppLog](../../backend/src/middleware/requestLogger.js) AND per-row audit columns on `Payslip`. AppLog captures the request shape (route, status, latencyMs, requestId, employeeHash); `Payslip.uploadedBy/paidPublishedBy/revokedBy` columns capture the payroll-grade history.
- Soft-delete forever (no hard-delete cron in v1; storage cost is rounding error at 50 emp × 5 yr ≈ 250 MB).
- Bulk upload is per-row picker, **not** filename-pattern matching — see §C.8.

### A.2 Explicitly out of v1 (deferred)

- In-portal PDF preview.
- Multi-language (portal is English-only today).
- Salary charts, YTD totals, year-over-year comparison.
- Per-employee encryption keys.
- Automated payroll-SaaS integration.
- E-signature / digital sign-off.
- Tax computation, Form 16 generation.
- Multi-currency (single-tenant is INR per [TENANCY.md](../../TENANCY.md)).
- Web push notifications, Slack/Teams integration.
- Admin "preview" PDF viewer.
- Employee self-service "request re-issue" / dispute form.
- 90-day hard-delete cron / `internal-payslip-sweep`.
- `AdminAudit` table (existing AppLog + per-row audit columns; no SOC2/ISO driver).
- `payroll_id` column on `Employee` (Stage 1 uses Employee.id/email; if a real payroll id is later supplied, add it).
- Magic-link email download (privacy + email-forwarding risk).
- Backfill of historical payslips.
- Cursor pagination on `My Payslips` (12 rows/year × N years fits a plain list).
- `originalFilenameHash` column (was carried in v1 for "what was the source file" audit; per v2 review, guessable names make it low-value).
- `contentVersion` column (was carried in v1 for replace detection; soft-delete + audit columns cover this).

### A.3 Personas

**(P1) Priya — HR / payroll admin.** ~50 employees, single admin, 6 years tenure. Monthly ritual: open portal, pick month, see coverage (who is missing), drag PDFs into the dropzone (each file appears with an unsetsed employee picker beside it), resolve the employee for each row, confirm upload, then click **Publish October 2026**. Time budget: 30 min, then forget about it. Trust signals: coverage view as source of truth, one-click replace, single publish action for the whole month, no nag emails.

**(P2) Karthik — site employee.** 28-45, mobile-first (Android, portrait, intermittent 4G), 2-4 payslip downloads per year. Use cases: bank loan, IT filing, personal archive. Trust signals: only his payslips visible, "Contact HR" CTA on errors, re-downloadable anytime. Friction budget: three taps from bell → downloaded, or he calls Priya.

---

## B. UX specification

### B.1 Surface inventory

| # | Surface | Who | Purpose |
|---|---|---|---|
| S1 | Employee "My Payslips" list | Employee | Browse own payslips, download |
| S2 | Employee payslip download (in-app fetch proxy) | Employee | Stream the PDF; never a raw R2 URL |
| S3 | Admin "Payslips" unified page | Admin | Coverage grid + drag-and-drop upload + replace + revoke |
| S4 | Admin per-row picker | Admin | Pick the employee for each dropped file |
| S5 | Admin "Publish {Month}" action | Admin | Flip draft → published for the whole month; fan out notifications |
| S6 | Admin "Publish" per-row action | Admin | Publish a single late-added draft |
| S7 | Admin replace (in-row, no modal) | Admin | Click Replace → file picker → confirm → publish gate |
| S8 | Admin revoke (in-row, with reason) | Admin | Click Revoke → typed reason → confirm |
| S9 | Bell notification | Employee | "Your October 2026 payslip is ready" |
| S10 | Email notification | Employee | Subject + portal link only, never PDF attachment |

### B.2 Wireframes

#### B.2.1 Employee "My Payslips" (mobile, 375 px)

```
+----------------------------------+
| <  My Payslips              (...) |  ← page heading + UserMenu portal (R21)
+----------------------------------+
| Home > Records > My Payslips     |  ← breadcrumb (collapsed on mobile to icon row)
+----------------------------------+
|                                  |
| +------------------------------+ |
| | October 2026                 | |  ← row, no NEW pill
| | Published 02 Oct 2026        | |  ← "Published", not "Uploaded" — only published rows visible
| |                       [Download] |  ← 44 px touch target
| +------------------------------+ |
|                                  |
| +------------------------------+ |
| | September 2026               | |
| | Published 03 Sep 2026        | |
| |                       [Download] |
| +------------------------------+ |
|                                  |
| ... (up to 50 rows)              |
|                                  |
+----------------------------------+
| (footer nav)                     |
+----------------------------------+
```

No year filter, no cursor, no "Load older" button. 12 rows/year × 5 years ≈ 60 rows in the worst case — well under the 50-row cap. If a single employee ever accumulates >50, we revisit (per §J.1).

Empty state: centered illustration, "No payslips yet. Your payslips will appear here after HR publishes them — usually around the 1st of each month." Single secondary CTA "Contact HR" → `mailto:` to `PAYSLIP_HR_CONTACT_EMAIL` (default `hr@acschennai.com`).

#### B.2.2 Admin "Payslips" unified page — DRAFTS view (desktop, 1280 px)

```
+--------------------------------------------------------------------------+
| < Payslips                                                               |
+--------------------------------------------------------------------------+
| Home > Admin > Payslips                                                  |
+--------------------------------------------------------------------------+
| [Month: October 2026 v]   Coverage: 0 / 50 (0%)  ·  [Publish October]    |
|                                                     ↑ disabled until ≥1 draft
+--------------------------------------------------------------------------+
| Employee                  Status         Uploaded        Actions         |
+--------------------------------------------------------------------------+
| Aarav Sharma              [Draft]        02 Oct 14:21    [Publish] [Replace] [Revoke] |
| Anitha Krishnan           [Draft]        02 Oct 14:21    [Publish] [Replace] [Revoke] |
| Murugan S.                [Missing]      --              [Upload]        |
| Priya R.                  [Missing]      --              [Upload]        |
+--------------------------------------------------------------------------+

+-- below the table: drag-and-drop zone (always present) -+
|                                                       |
|     [ Drop one or many PDFs here — or click to choose files ]    |
|     Only application/pdf. 5 MB max per file.                      |
|                                                               |
+---------------------------------------------------------------+

Files queued (each row has an unsetsed employee picker):
+-------------------------------------------------------------------+
| october_2026_aarav.pdf   124 KB   [Pick employee v]   [x]         |
| october_2026_anitha.pdf  118 KB   [Pick employee v]   [x]         |
| payslip_misc.pdf         132 KB   [Pick employee v]   [x]         |
+-------------------------------------------------------------------+

[Cancel]                                          [Confirm upload (3)]
```

After confirm: per-row progress (pending → uploading with % → done | failed with reason + Retry). On all-done: "Uploaded 3 of 3 drafts. Coverage now 3 / 50." The page stays in **DRAFTS view** until admin clicks **Publish October**.

#### B.2.3 Admin "Payslips" unified page — PUBLISHED view (after Publish click)

```
+--------------------------------------------------------------------------+
| [Month: October 2026 v]   Coverage: 3 / 50 (6%)  ·  [Published 02 Oct]   |
+--------------------------------------------------------------------------+
| Employee                  Status         Published       Actions        |
+--------------------------------------------------------------------------+
| Aarav Sharma              [Published]    02 Oct 14:35    [Replace] [Revoke] |
| Anitha Krishnan           [Published]    02 Oct 14:35    [Replace] [Revoke] |
| ...                                                                      |
| Murugan S.                [Missing]      --              [Upload]         |
| Priya R.                  [Missing]      --              [Upload]         |
+--------------------------------------------------------------------------+
```

Late additions: drag a new PDF → confirm upload → a new **Draft** row appears at the top of the same page → admin clicks **Publish** on that single row → coverage bumps, email fires for that one employee. No re-publish for the month.

#### B.2.4 Edge states

| Scenario | UI response |
|---|---|
| Employee, zero published payslips | Empty state, "Contact HR" CTA. No bell. No notification. |
| Employee, BLOB_GONE on download | Inline row state "This payslip is no longer available — contact HR." (Not a 500 / stack trace.) |
| Admin drops non-PDF | Rejected at dropzone with per-file chip "Not a PDF" + dropzone red flash. No network call. |
| Admin drops >5 MB | Rejected at dropzone with "File exceeds 5 MB" chip. No network call. |
| Admin drops a file with no employee picked | Listed in queue with "Pick employee" inline dropdown (required before Confirm). |
| Admin re-uploads for employee with existing published payslip | Soft-delete the published row; insert new draft. Row flips to **Draft**. Admin clicks Publish (per-row or per-month) to make it live. |
| Two admins race the same (employee, year, month) | Second admin sees [Uploaded] on refresh; first wins (P2002 → silent retry → success). |
| Admin clicks Publish on a month with 0 drafts | Button disabled with tooltip "No drafts to publish for this month". |
| Publish click succeeds but email provider 429s | AppLog row with `email_send_throttled`; UI shows "Published N of N, but some emails queued for retry. Employees will see the bell on their next page load regardless." Bell is created independent of email (per R25), so bell always fires. |

### B.3 Component reuse

**Reused as-is:** `PortalLayout` (sidebar, UserMenu via `createPortal` per R21), `Breadcrumb`, `FilterChip`, status pill, page-heading + sub-copy pattern from [MyProjectReports.jsx](../../src/pages/portal/MyProjectReports.jsx), `useToast` (ToastProvider + R17 dedupe), [src/lib/api.js](../../src/lib/api.js) global fetch wrapper (handles 401 → AuthContext), [src/lib/blobUpload.js](../../src/lib/blobUpload.js) `uploadBlob` + `BlobUploadError`, `EmptyState` from [MyProjectReports.jsx](../../src/pages/portal/MyProjectReports.jsx).

**New (small, contained):**
- `PayslipRow` — presentational; takes `{ monthLabel, periodISO, publishedAt, onDownload, downloading }`.
- `CoverageRow` — presentational; takes `{ employee, status, publishedAt, uploadedAt, onReplace, onRevoke, onPublish, onUpload }`.
- `BulkDropzone` — wraps native `input[type=file][accept=application/pdf,multiple]` with HTML5 drag events. ~80 lines, no library. Renders queued files as `{file, assignedEmployeeId}` rows with an inline employee picker.
- `EmployeePicker` — tiny autocomplete bound to `GET /api/admin/employees`; the same picker is used by both `BulkDropzone` (per-row) and the single `[Upload]` button. ~40 lines.
- `payslip.svg` icon — 24×24, monochrome, fits `REPORT_ICON` slot in [PortalLayout](../../src/components/PortalLayout.jsx).

**No new dependencies.** No new CSS framework, no new modal library, no new date picker (use existing `<select>` per R44.1).

### B.4 Sidebar placement

- Employee: **Records** group → "My Payslips" with `payslip.svg` icon. Order: directly under "My Project Reports".
- Admin: **Admin** group → "Payslips" with `payslip.svg` icon. Order: alongside "Training", "Billing Certifications".
- No sidebar badge (bell already indicates).

### B.5 Notification & email UX

**When it fires.** Per `publishedAt` transition, not per `createdAt`. Upload alone does not notify; the publish action is the gate.

**Bell (S9).** Body: `Your October 2026 payslip is ready.` No salary figure, no filename, no file size, no preview text. Tapping opens `My Payslips` scrolled to the new row. Bell badge decrements the moment the list page is opened (R25 dedupe).

**Email (S10).**

```
Subject: Your October 2026 payslip is ready
Body (plain-text):
  Hi — your payslip for October 2026 is ready.
  Sign in to the portal to download it:
  https://acs-portal-spa.onrender.com/#/portal/payslips
  — ACS Chennai HR
```

No name, no employee id, no filename, no salary figure, no period range, **never a direct PDF link or magic link**. The body text contains exactly one identifier: the period string, which is non-identifying on its own.

**Bypass behavior:** Payslip notifications bypass `NotificationPreference.typeMutes` and `emailEnabled`. The user cannot mute a payslip notification. Documented in the email footer: "This is an automated message about a payroll document and is not affected by your notification preferences." One bypass; any expansion requires a code-review comment.

**Throttling.** The publish action fans out per-employee emails. Resend's free tier limits to ~100 emails/day by default (per Resend's published limits, verify at publish time — see §J.11). For 50 employees on a single month this fits well within daily limit. For multi-month back-publish (out of v1) we may need to chunk by hour. We add `BULK_PUBLISH_EMAIL_DELAY_MS` env (default `100` ms between emails) so a publish action that fires 50 emails takes ~5 s and stays comfortably under burst limits. The publish endpoint returns `{published: N, emailsSent: N, emailsThrottled: 0}` so the UI can surface partial-success.

### B.6 Accessibility & mobile

- WCAG 2.1 AA target. Mobile-first for employees (375 px portrait primary).
- Touch targets ≥44 × 44 px on every action.
- Focus order: page heading → row 1 download → row 2 download → ... → footer. No jumps.
- Screen reader labels: `aria-label="Download payslip for October 2026"` (full month name).
- Color contrast: status pills ≥ 4.5:1; never icon-only.
- Reduced motion: dropzone shake wrapped in `@media (prefers-reduced-motion: no-preference)`.
- Text scaling: layout holds at 200% browser zoom; admin coverage table collapses to stacked cards < 640 px viewport.
- Keyboard: admin upload — Tab moves through month → dropzone (tabindex 0) → per-row employee pickers → per-row remove buttons → Cancel → Confirm. Enter on dropzone opens file picker. **Publish** button appears in the tab order between the coverage header and the table.
- PDF download semantics: `<button type="button">` that triggers programmatic `<a download>`; keyboard- and screen-reader-accessible. No `<a href="...">` alone (breaks Android back-navigation).

### B.7 What we do NOT show on any surface

- No salary amount (schema enforces it; UI enforces it by not having a field).
- No "year totals" / "monthly comparison".
- No count of payslips above the list.
- No filename, no file size on the employee list.
- No "X employees also downloaded" social proof.
- No notification badge on the sidebar entry.
- No "Replaced" pill on employee view (admin-only metadata).

---

## C. Data model (additive, no salary columns)

### C.1 New model: `Payslip`

Single new table. No columns added to existing models except four back-relations on `Employee` and a `joinedAt` follow-up decision in §C.7.

```prisma
model Payslip {
  id                String    @id  // ULID, 26 chars, Crockford base32
  employeeId        String    @db.Uuid
  year              Int       // 2000-2100
  month             Int       // 1-12, CHECK (month BETWEEN 1 AND 12)
  ulid              String    // R2 key suffix
  uploadIntentUlid  String    @unique  // back-link to UploadIntent
  contentType       String    // locked to "application/pdf" by validator
  contentLength     BigInt

  // ── Payroll-grade audit (lives on the row, NOT in AppLog) ──────────────
  // AppLog retention is 30 days and the team is logging less; payroll-grade
  // "who uploaded / published / revoked what" must survive independently.
  // All server-stamped, never client-supplied. Nullable = not yet actioned.
  uploadedById      String    @db.Uuid                       // admin who uploaded (always set on create)
  publishedById     String?   @db.Uuid                       // admin who clicked Publish; null = still draft
  publishedAt       DateTime?                                 // when Publish fired; null = still draft
  revokedById       String?   @db.Uuid                       // admin who clicked Revoke; null = active
  revokedAt         DateTime?                                 // when Revoke fired; null = active; stamped in same UPDATE as deletedAt
  revokedReason     String?   @db.VarChar(500)              // admin-provided reason, optional

  deletedAt         DateTime?                                 // soft-delete marker; for v1, only set on Revoke

  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt

  employee       Employee  @relation("EmployeePayslips",   fields: [employeeId],      references: [id], onDelete: Restrict)
  uploadedBy     Employee  @relation("PayslipUploader",   fields: [uploadedById],    references: [id], onDelete: Restrict)
  publishedBy    Employee? @relation("PayslipPublisher",  fields: [publishedById],   references: [id], onDelete: SetNull)
  revokedBy      Employee? @relation("PayslipRevoker",    fields: [revokedById],     references: [id], onDelete: SetNull)

  @@index([employeeId, year(sort: Desc), month(sort: Desc)])  // "My Payslips" recent-first
  @@index([year, month, deletedAt])                           // admin coverage
  @@index([uploadedById])
  @@index([publishedAt])
  @@map("payslip")
}
```

**`Employee` gets four back-relation fields**:

```prisma
payslips            Payslip[] @relation("EmployeePayslips")
payslipsUploaded    Payslip[] @relation("PayslipUploader")
payslipsPublished   Payslip[] @relation("PayslipPublisher")
payslipsRevoked     Payslip[] @relation("PayslipRevoker")
```

No new columns on `Employee` in v1.

**Privacy constraint (non-negotiable, repeated):** the schema does NOT include `netPay`, `grossPay`, `tax`, `basic`, `hra`, `deductions`, `earnings`, `bankAccount`, `pan`, `uan`, or any numeric salary field. The PDF is the only salary-bearing artifact. The request validator (zod) rejects unknown fields, not just omits them.

**Migration-level partial unique index** (Prisma cannot model partial uniques — see §C.6 for the no_overlap_leave pattern this mirrors):

```sql
CREATE UNIQUE INDEX payslip_active_per_month_uidx
  ON payslip (employee_id, year, month)
  WHERE deleted_at IS NULL;
```

This is the **single source of truth for "active row"**. With v2's publish-gate, "active" means "exists" — whether draft or published. Employee visibility is a separate filter (`publishedAt IS NOT NULL AND deletedAt IS NULL`).

### C.2 Indexes and query plan

Scale: ~50 employees × 12 months × 5 years ≈ 3,000 rows. Trivial today; indexes are forward-compat.

| Index | Purpose | Expected plan |
|---|---|---|
| `payslip_pkey` (ULID btree) | PK + time order | Index Scan, O(log n) |
| `(employee_id, year DESC, month DESC)` | `GET /api/payslips/my` | Index Scan Backward; sort elided |
| `(year, month, deleted_at)` | `GET /api/admin/payslips/coverage` | Bitmap Index Scan |
| `(employee_id, year, month) WHERE deleted_at IS NULL` UNIQUE | Race protection; "one current per (emp, month)" | Unique violation on conflict |
| `(upload_intent_ulid)` UNIQUE | Back-link to `UploadIntent` (sweep + audit) | Index Scan, single tuple |
| `(uploaded_by_id)` | Admin "what I uploaded" | Index Scan |
| `(published_at)` | "Published between" cron / reports (future) | Index Scan |

**Worked example — "My Payslips":**

```sql
SELECT id, year, month, ulid, content_type, content_length
FROM payslip
WHERE employee_id = $1
  AND published_at IS NOT NULL
  AND deleted_at IS NULL
ORDER BY year DESC, month DESC
LIMIT 50;
```

Plan: Index Scan Backward using `(employee_id, year DESC, month DESC)`, filter applies, LIMIT 50 short-circuits. Sub-millisecond at 3,000 rows.

**Worked example — admin coverage for {year, month}:**

```sql
-- missing rows: employees with created_at <= month-start AND no active payslip
SELECT e.id, e.name, e.email
FROM employees e
WHERE e.created_at <= make_date($year, $month, 1)
  AND NOT EXISTS (
    SELECT 1 FROM payslip p
    WHERE p.employee_id = e.id
      AND p.year = $year AND p.month = $month
      AND p.deleted_at IS NULL
  );
```

(Other half of the coverage list — present rows — uses the `(year, month, deleted_at)` index.)

### C.3 State machine A′ (state machine A + publish gate)

Three states, modeled via two SQL rows-or-null columns + one bit column (`deletedAt`):

```
                  created
                    │
                    ▼
                ┌────────┐   publish ──────────────┐
                │ DRAFT  │ ──────────────────────►  │
                │        │  publishedById = admin    │
                │        │  publishedAt = NOW()      │
                └────────┘                          │
                    ▲                               ▼
                    │                          ┌───────────┐   revoke ───────┐
                    │                          │ PUBLISHED │ ──────────────►  │
                    │                          │           │  revokedById     │
                    │                          │           │  revokedAt       │
                    │                          │           │  revokedReason?  │
                    │                          │           │  deletedAt = NOW │
                    │                          └───────────┘                  │
                    │                                                          │
                    │                                                          ▼
                    │                                                  ┌──────────┐
                    └─────────────── replace (soft-delete + insert) ◄──│ REVOKED  │
                                                                       └──────────┘
```

- **Draft**: `publishedAt IS NULL AND deletedAt IS NULL`. Admin-only. No employee visibility, no notification.
- **Published**: `publishedAt IS NOT NULL AND deletedAt IS NULL`. Employee visible, email/bell fired. Re-publish on already-published row is a no-op.
- **Revoked**: `deletedAt IS NOT NULL` (and `revokedAt` mirrors). Admin tombstone. Employee sees "Contact HR" on download attempt. Replace (admin re-upload) takes a Revoked row's place at the (employee, year, month) key.

Replace = `UPDATE Payslip SET deleted_at = NOW(), revoked_by_id = $admin, revoked_at = NOW() WHERE employee_id = $1 AND year = $2 AND month = $3 AND deleted_at IS NULL; INSERT new draft row;`. Both inside a `SERIALIZABLE` transaction (or `SELECT ... FOR UPDATE` on the candidate row). The partial unique catches the second inserter with `P2002`; app retries the read+update cycle once.

**Notification fan-out fires on the transition Draft → Published**, not on upload. Re-publish (Publish clicked twice for the same row) is a no-op — `publishedAt` is already set; we don't re-send the email. The publish endpoint guards: `IF NEW.published_at IS NOT NULL AND OLD.published_at IS NOT NULL THEN no-op END`.

### C.4 RLS policies

Mirror the canonical pattern at [migrations/20260910000000_rls_lockdown_s1/migration.sql](../../backend/prisma/migrations/20260910000000_rls_lockdown_s1/migration.sql):

```sql
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname='payslip' AND relrowsecurity) THEN
    ALTER TABLE payslip ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;

DROP POLICY IF EXISTS payslip_deny_anon ON payslip;
CREATE POLICY payslip_deny_anon TO anon USING (false) WITH CHECK(false);

DROP POLICY IF EXISTS payslip_deny_authenticated ON payslip;
CREATE POLICY payslip_deny_authenticated TO authenticated USING (false) WITH CHECK(false);
```

**No** `FORCE ROW LEVEL SECURITY` (would break `BYPASSRLS` for the `postgres` role). **No** write policy for `authenticated` — writes go through Prisma as `postgres`. RLS is defense-in-depth; the canonical tenant enforcement is in the controller.

### C.5 Storage path

Keep payslips in the existing `dpr-documents` bucket. No new bucket. New R2 key prefix only.

```
payslips/{year}/{month}/{employeeId}/{ulid}.pdf
```

Add `'payslips'` to the `allowedPathPrefixesPerContainer['dpr-documents']` allowlist in the `mountUploadRoutes` config that backs the payslips route (one-line config change in the same shape as the existing `'billing'` entry at [uploadRoutes.js:139](../../backend/src/lib/uploadRoutes.js#L139)). The orphan sweep at [internal-upload-sweep.js](../../backend/src/routes/internal-upload-sweep.js) iterates `UploadIntent` rows by `(container, blobPath)`, not by prefix — so the new prefix needs **no** sweep changes.

### C.6 Partial unique migration — copy the `no_overlap_leave` pattern

The partial unique index cannot be expressed in `schema.prisma` (Prisma has no partial-unique syntax), so the migration ships as raw SQL. To avoid the kind of drift that DR-031 caught in [migrations/20260908150000_dr031_leave_constraint_correct_bound/migration.sql](../../backend/prisma/migrations/20260908150000_dr031_leave_constraint_correct_bound/migration.sql), the migration follows the same defensive pattern:

```sql
-- 20261002000000_payslip_partial_unique/migration.sql
--
-- Mirrors the no_overlap_leave pattern (DR-031):
--   1. Inspect the installed definition via pg_get_constraintdef /
--      pg_get_indexdef.
--   2. If the constraint/index already matches the desired shape, no-op.
--   3. If it has drifted (someone ran an out-of-band ALTER INDEX, or the
--      predicate column was renamed under our schema), drop and recreate.
--   4. Final sanity check: re-read the installed definition; RAISE
--      EXCEPTION on drift so the migration fails loudly rather than
--      silently shipping a partial-unique that admits duplicate active rows.
--
-- The Payslip migration uses a UNIQUE INDEX (not an EXCLUDE constraint),
-- because the predicate is just a partial-WHERE filter on `deleted_at`.
-- No overlap arithmetic needed.

DO $$
DECLARE
  current_def text;
  index_exists boolean := false;
  bad_definition boolean := false;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = 'payslip_active_per_month_uidx'
  ) INTO index_exists;

  IF index_exists THEN
    SELECT pg_get_indexdef(c.oid) INTO current_def
      FROM pg_class c WHERE c.relname = 'payslip_active_per_month_uidx';

    -- Drift detector. The exact desired predicate is:
    --   CREATE UNIQUE INDEX ... ON payslip (employee_id, year, month)
    --     WHERE deleted_at IS NULL
    -- Any of these missing or rearranged → recreate.
    bad_definition := (
      position('payslip' in current_def) = 0
      OR position('(employee_id, year, month)' in current_def) = 0
      OR position('WHERE (deleted_at IS NULL)' in current_def) = 0
    );

    IF bad_definition THEN
      DROP INDEX payslip_active_per_month_uidx;
      index_exists := false;
      RAISE NOTICE 'payslip: dropped drifted partial-unique index, recreating';
    ELSE
      RAISE NOTICE 'payslip: existing partial-unique index is already correct, skipping';
    END IF;
  END IF;

  IF NOT index_exists THEN
    CREATE UNIQUE INDEX payslip_active_per_month_uidx
      ON payslip (employee_id, year, month)
      WHERE deleted_at IS NULL;
  END IF;

  -- Final sanity check, mirroring DR-031's no_overlap_leave pattern.
  SELECT pg_get_indexdef(c.oid) INTO current_def
    FROM pg_class c WHERE c.relname = 'payslip_active_per_month_uidx';

  IF position('payslip' in current_def) = 0
     OR position('(employee_id, year, month)' in current_def) = 0
     OR position('WHERE (deleted_at IS NULL)' in current_def) = 0 THEN
    RAISE EXCEPTION 'payslip: partial-unique still in wrong shape: %', current_def;
  END IF;
END$$;
```

The pattern is deliberately similar to `no_overlap_leave` so future readers recognize the shape. Drift detection catches the same class of bug DR-031 caught (silent predicate drift) and fails loudly.

### C.7 New-joiner coverage (decision needed: `joinedAt` proxy)

`Employee` has **no** `joinedAt` / `hireDate` / `startDate` column. Only `createdAt DateTime @default(now())` ([schema.prisma:47](../../backend/prisma/schema.prisma#L47)), which is when the employee row was inserted in our portal — not necessarily their hire date.

Coverage-grid behavior for an employee who joined mid-month:
- We do not want to show "Missing" for August when they joined in September. That's noise.
- We also do not want to silently skip employees who joined before the month-start and are still missing a payslip.

**v1 default (recommendation):** filter the coverage grid to employees whose `Employee.created_at <= first day of {year}-{month}`. Treat portal-add-date as hire-date proxy. Document in the plan and the admin UI as "Employees who joined after this month are not included in the count." HR confirms the proxy at go-live.

**Alternative (defer to follow-up if needed):** add `Employee.joinedAt DateTime?` column (additive, nullable, fill-once). Coverage filters by `joinedAt` instead of `createdAt`. Decision captured in §J.4.

### C.8 Bulk-upload attribution (decision: per-row picker)

The v1 plan assumed a filename pattern (`EMPID_mmyyyy.pdf`). The v2 review correctly noted that a payroll SaaS will not output our internal Employee.id, and that guessing an internal id from a filename pattern is the wrong abstraction.

**v1 default:** per-row picker. Each dropped file appears in the queue with an unsetsed employee dropdown (the same `EmployeePicker` used by the single `[Upload]` button). The Confirm button is disabled until every file has an assigned employee.

Why this is the right choice for Stage 1:
- It works regardless of what Priya's payroll SaaS emits — no filename-pattern coupling.
- It costs one extra click per file (50 files × 1 click = 50 clicks), compared to the 250 clicks the model assumed when the filename pattern fails.
- It mirrors the same component (`EmployeePicker`) used elsewhere in the admin, so no special-purpose filename parser ships.

If a payroll id is later added to `Employee` (`payrollId String? @unique`), we can layer filename-pattern matching on top in v2 — but only for the admin-issuer flow where it is bounded and audited, never for employee-facing paths.

### C.9 Retention

Soft-delete forever in v1. No `internal-payslip-sweep` endpoint. No cron. Storage at scale (50 emp × 5 yr × 1 MB ≈ 250 MB) is rounding error. If compliance asks for hard-delete-within-X-days, add the cron then (GH Actions pattern per R40, not a new internal endpoint).

### C.10 Misdelivery manual purge script

Soft-delete leaves the wrong file in R2 storage. The plan adds a documented manual purge script for misdelivery:

**File**: `backend/scripts/purge-payslip-misdelivery.js`
**Inputs**: one or more `--payslipId=<ulid>` flags, or `--batch-file=<path>` (one ulid per line)
**Pre-conditions** (script aborts loudly if violated):
- Row exists.
- Row is currently soft-deleted (`deletedAt IS NOT NULL`).
- The R2 blob exists (HEAD-verify via `verifyBlobExists`).
**Actions**:
1. Write an `AppLog` row `event: 'payslip.purged'` with `{payslipId, employeeHash, ulid, requestId, adminId, reason}` (the calling admin must supply `--admin=<email>` and `--reason=<text>`; the script refuses to run without them).
2. `DeleteObjectCommand` against `payslips/{year}/{month}/{employeeId}/{ulid}.pdf` in `dpr-documents`.
3. `DELETE FROM payslip WHERE id = $1`.
**Idempotency**: re-running on already-purged row fails fast with "row already purged (no row found)". The script never deletes an active row (revoked or not).
**No cron. No automation.** The script is documented in this plan and lives at the path above when implemented.

---

## D. API surface

All routes mount under `/api/payslips` in [backend/src/index.js](../../backend/src/index.js). Auth + rate-limit + error envelope match the existing per-route convention.

| Method | Path | Auth | Rate limit | Body | Success | Errors |
|---|---|---|---|---|---|---|
| POST | `/api/payslips/upload-intents` | `requireFreshAdmin` | `sasLimiter` 60/min | `{ items: [{employeeId, year, month, fileSizeBytes, contentType}], batchId }` | `{ items: [{ulid, intentId, putUrl, expiresIn}], batchId }` | 400 size/type, 404 employee, 415 wrong magic bytes at confirm |
| POST | `/api/payslips/confirm-uploads` | `requireFreshAdmin` | `sasLimiter` | `{ items: [{ulid, employeeId, year, month}], batchId }` | `{ confirmed: [{payslipId, ulid}], failed: [{ulid, reason}] }` | 404 intent, 410 BLOB_GONE, 409 binding conflict, **415 magic-byte mismatch (NEW v2)** |
| POST | `/api/admin/payslips/publish?year=&month=` | `requireFreshAdmin` | `payslipWriteLimiter` 20/h per admin | — | `{ published: N, skipped: [...], emailsSent: N, emailsThrottled: 0 }` | 400 invalid month |
| POST | `/api/payslips/:id/publish` | `requireFreshAdmin` | `payslipWriteLimiter` | — | `{ id, publishedAt, publishedById }` | 404, 409 already published (silent no-op) |
| GET | `/api/payslips/my` | `requireAuth` | `payslipListLimiter` 30/min | — | `{ items: [{id, year, month, contentLength, createdAt}] }` | — |
| GET | `/api/payslips/my/:id/download` | `requireAuth` | `payslipDownloadLimiter` 10/min + 50/day per-employee | — | `application/pdf` stream with `Content-Disposition: attachment; filename="Payslip-{Month}-{Year}.pdf"` | 404 cross-employee, 410 BLOB_GONE |
| GET | `/api/payslips/:id` | `requireAuth` (employee-self OR admin) | `payslipListLimiter` | — | `{ id, year, month, employeeId, createdAt, contentLength, publishedAt, deletedAt }` | 404 |
| GET | `/api/payslips?year=&month=` | `requireFreshAdmin` | `sasLimiter` | — | `{ items, counts: {draft, published, revoked}, nextCursor? }` | 400 |
| GET | `/api/admin/payslips/coverage?year=&month=` | `requireFreshAdmin` | `sasLimiter` | — | `{ employees: [{id, name, email, status, payslipId?, publishedAt?, uploadedAt?}] }` | 400 |
| PATCH | `/api/payslips/:id/revoke` | `requireFreshAdmin` | `payslipWriteLimiter` 20/h per admin | `{ reason }` | `{ id, revokedAt, revokedById, deletedAt }` | 404, 409 already revoked |
| POST | `/api/payslips/:id/replace` | `requireFreshAdmin` | `payslipWriteLimiter` | `{ fileSizeBytes, contentType, batchId }` | `{ ulid, intentId, putUrl, expiresIn, batchId }` | 404, 410 BLOB_GONE on prior blob, 400 not PDF |

**`Idempotency-Key` header is REQUIRED** on `POST /api/payslips/confirm-uploads`. Key = `payslip-confirm-{adminId}-{batchId}`. Frontend auto-generates per batch. Backed by `RequestDedupe` (DR-020) via [lib/idempotency.js](../../backend/src/lib/idempotency.js).

**Conventions:** error envelope `{error: {code, message, requestId}}`. All endpoints inherit `requestLogger` → `AppLog` row automatically (§G.6). **No cursor on `My Payslips`** — plain list, hard-cap 50 rows server-side (per §A.1 / answer to open question 1).

### D.1 Magic-byte check timing — `confirm`, not `intent`

The user's v2 review caught this: in a direct-to-storage upload flow, the file does **not** exist at upload-intent time. Server-side magic-byte sniff must run at `confirm-upload` time, after the bytes have landed in R2.

- **Client-side (defense in depth, pre-flight only)**: `src/lib/blobUpload.js` reads first 4 bytes via `FileReader` on the browser's `File` object. If mismatch, throws `BlobUploadError({code: 'NOT_PDF'})` and no network call. Cost: ~0 ms.
- **Server-side (authoritative, at confirm)**: `backend/src/lib/uploadRoutes.js` `/confirm-upload` calls a new helper `verifyBlobMagicBytes(container, blobPath, magic = Buffer.from('%PDF-'))` from `backend/src/lib/blobStorage.js`. Helper does `GetObjectCommand` with `Range: bytes=0-3`. Returns `{ok: true}` on match, `{ok: false, reason: 'MAGIC_BYTE_MISMATCH'}` on mismatch, `{ok: null, reason: 'HEAD_RANGE_UNREADABLE'}` on R2 read failure. The confirm handler:
  - `ok: true` → proceed with intent bind (current behavior).
  - `ok: false` → 415 with code `NOT_PDF`.
  - `ok: null` → 503 (R2 read failure); admin retries.

The helper lives next to `verifyBlobExists` in `blobStorage.js`, sharing the same 3-state return shape so the existing `isAbsent` / `isUnknown` discriminators cover both consumer routes (`uploadRoutes.js` + future `internal-upload-sweep.js` consumers). The DR-004 `SIZE_TOLERANCE_BYTES=0` policy applies here too — bytes from R2 are byte-exact.

### D.2 Publish endpoint behavior

`POST /api/admin/payslips/publish?year=&month=`:

```js
// pseudocode
const result = await prisma.$transaction(async (tx) => {
  const candidates = await tx.payslip.findMany({
    where: { year, month, deletedAt: null, publishedAt: null },
    select: { id: true, employeeId: true },
  });
  if (candidates.length === 0) return { published: 0, skipped: [], emailsSent: 0, emailsThrottled: 0 };
  await tx.payslip.updateMany({
    where: { id: { in: candidates.map(c => c.id) } },
    data: { publishedAt: now(), publishedById: admin.id },
  });
  return { published: candidates.length, skipped: [], emailsSent: 0, emailsThrottled: 0 };
});
// Outside the transaction: fan out emails + bell rows.
for (const payslip of result) {
  await sendPayslipEmail(payslip, { employee, payslip, period });
  await sleep(process.env.BULK_PUBLISH_EMAIL_DELAY_MS || 100);
}
```

Re-publish on already-published rows is a no-op (`WHERE publishedAt IS NULL` excludes them). The transaction guarantees that the publish transition is atomic; the email fan-out runs outside the transaction (consistent with [notify.js:130](../../backend/src/lib/notify.js) `fanOutEmail` semantics). A failure during email fan-out does not roll back the publish; the bell row still fires (R25), so the employee sees the payslip on next page load.

`POST /api/payslips/:id/publish` — single-row variant. Same atomic guard. Same fan-out. Used for late additions after the bulk publish.

---

## E. Frontend integration

### E.1 Routes ([src/App.jsx](../../src/App.jsx))

```jsx
<Route path="/portal/payslips" element={<MyPayslips />} />          // requireAuth
<Route path="/admin/payslips" element={<AdminPayslips />} />        // requireAdmin
```

No nested routes; no `:id` segments. Both pages are list/coverage views; the only employee action is download (in-place button) and the only admin actions are replace/revoke/publish/upload (in-row or in-button-group).

### E.2 Sidebar entries ([src/components/PortalLayout.jsx](../../src/components/PortalLayout.jsx))

- Employee, "Records" group: label `"My Payslips"`, icon `PAYSLIP_ICON` (lucide `Receipt`).
- Admin, "Admin" group: label `"Payslips"`, icon `PAYSLIP_ICON`. Path `#/admin/payslips`.

### E.3 New pages

- `src/pages/portal/MyPayslips.jsx` — employee list. State: `{ payslips, loading, error, downloadingId }`. Reuses `Breadcrumb`, `EmptyState`, page-heading pattern from [MyCertifications.jsx](../../src/pages/portal/MyCertifications.jsx). **No filter chips, no year selector, no cursor, no "Load older".**
- `src/pages/admin/AdminPayslips.jsx` — unified coverage + upload + per-row picker + replace + revoke + publish. State: `{ coverage, month, year, loading, error, queuedFiles, uploadStateByEmpId, publishInFlight }`. Reuses `FilterChip` for month/year, the 3-step upload state machine from [MyProjectReports.jsx](../../src/pages/portal/MyProjectReports.jsx) (idle → uploading → confirming → done). Two view modes: **Drafts** (default) and **Published** (after a Publish click). The mode is determined by `coverage.counts.draft > 0` AND `coverage.counts.published === 0`; otherwise Published.

### E.4 New components

- `src/lib/constants.js`: `PAYSLIP_ICON`, `MAX_PAYSLIP_BYTES = 5 * 1024 * 1024`, `ACCEPTED_PAYSLIP_TYPES = ['application/pdf']`. (No `PAYSLIP_FILENAME_PATTERN` in v2 — see §C.8.)
- `src/lib/format.js`: `formatMonthYear(month, year)` if not already present.
- `src/components/PayslipRow.jsx`, `CoverageRow.jsx`, `BulkDropzone.jsx`, `EmployeePicker.jsx` — presentational, no new state libraries.

### E.5 API client additions ([src/lib/api.js](../../src/lib/api.js))

```js
api.listMyPayslips()                                      // Payslip[]
api.getMyPayslipDownloadUrl(payslipId)                    // triggers proxy GET, returns Blob
api.listPayslipsForMonth({ month, year })                 // admin
api.getPayslipCoverage({ month, year })                    // admin
api.createPayslipUploadIntents({ items, batchId })        // admin: returns upload URLs
api.confirmPayslipUploads({ items, batchId }, { idempotencyKey })  // admin
api.createPayslipReplaceIntent(payslipId, { fileSizeBytes, contentType }, { idempotencyKey })  // admin
api.confirmPayslipReplace(payslipId, { ulid }, { idempotencyKey })   // admin
api.revokePayslip(payslipId, { reason })                   // admin
api.publishPayslipsForMonth({ month, year })              // admin: bulk publish + fan out
api.publishPayslip(payslipId)                              // admin: per-row publish
```

No `nextCursor` consumers — the employee endpoint returns `{ items: [...] }` only.

Errors: each function throws on non-2xx; the global `fetch` wrapper in `src/lib/api.js` already funnels 401s through `AuthContext` (per the project's `RouterScope` design in [src/contexts/AuthContext.jsx](../../src/contexts/AuthContext.jsx)). Returns: plain JSON for list/coverage/CRUD; `Blob` for download.

### E.6 Upload state machine

Reuse [src/lib/blobUpload.js](../../src/lib/blobUpload.js) `uploadBlob(file, uploadUrl, { onProgress, signal })`. Same 3-step shape as [MyProjectReports.jsx](../../src/pages/portal/MyProjectReports.jsx):

1. `api.createPayslipUploadIntents({ items, batchId })` → `{ items: [{ulid, putUrl, ...}] }`
2. Per item: `uploadBlob(file, putUrl, { onProgress })`
3. `api.confirmPayslipUploads({ items, batchId }, { idempotencyKey })` → `{ confirmed, failed }`

Client-side cap: `MAX_PAYSLIP_BYTES = 5 MB`. Client-side type check: `file.type === 'application/pdf'`. Client-side magic-byte sniff (defense in depth): first 4 bytes equal `0x25 0x50 0x44 0x46` (`%PDF-`). The server re-checks the magic bytes at confirm-upload time, AFTER the file is in R2 (see §D.1).

### E.7 Download flow

**Proxy through our origin (not raw R2 SAS).** `api.getMyPayslipDownloadUrl(payslipId)` does:

```js
const res = await fetch(`/api/payslips/my/${payslipId}/download`, { credentials: 'include' });
if (!res.ok) throw new Error(`Download failed: ${res.status}`);
const blob = await res.blob();
const url = URL.createObjectURL(blob);
const a = document.createElement('a');
a.href = url;
a.download = `Payslip-${monthName(year, month)}.pdf`;
a.click();
URL.revokeObjectURL(url);
```

R2 SAS URLs never reach the browser. The server-side stream enforces `Content-Disposition` and gives the API a deterministic filename. Trade-off: extra hop through our origin, but payslip PDFs are <500 KB typical and the cost is ~50–150 ms on 4G.

### E.8 Bundle impact

~14-18 kB raw, ~5-6 kB gzipped (slightly larger than v1 due to `BulkDropzone` + `EmployeePicker`). Route-level code splitting (existing pattern) keeps the entry chunk unchanged. No new dependencies.

---

## F. Reuse and infrastructure

Every concern is mapped to the existing file/line it reuses.

| Concern | Reuses |
|---|---|
| SAS mint + confirm mount (per-container caps + path prefixes) | [uploadRoutes.js](../../backend/src/lib/uploadRoutes.js) `mountUploadRoutes` (DR-021); add `'payslips'` to `allowedPathPrefixesPerContainer['dpr-documents']` next to the existing `'billing'` entry at [uploadRoutes.js:139](../../backend/src/lib/uploadRoutes.js#L139). **No new prefix-handling code anywhere — the orphan sweep iterates by `(container, blobPath)`, not by prefix.** |
| Upload URL + ULID + content-type map | [blobStorage.js](../../backend/src/lib/blobStorage.js) `generateUploadSASUrl`, `generateReadSASUrl`, `generateULID`, `CONTENT_TYPE_EXT` |
| Blob existence check + 3-state | [blobStorage.js](../../backend/src/lib/blobStorage.js) `verifyBlobExists` |
| **Magic-byte check (NEW v2)** | New `verifyBlobMagicBytes(container, blobPath, magic)` in `blobStorage.js`. `GetObjectCommand` with `Range: bytes=0-3`. 3-state return `{ok: true, ok: false, ok: null}`. Called by `mountUploadRoutes` `/confirm-upload` (not `/sas-url`). |
| Upload intent binding + 409 conflict | [uploadIntentBinding.js](../../backend/src/lib/uploadIntentBinding.js) `validatePhotoIntents`, `bindPhotoIntentsTx`, `assertPhotoIntentsBindable`, `PhotoBindingLostError → 409` |
| Request log → `AppLog` (HMAC employeeHash) | [requestLogger.js](../../backend/src/middleware/requestLogger.js) |
| Auth middleware chain | [auth.js](../../backend/src/middleware/auth.js) `requireAuth`, `requireAdmin`, `requireFreshAdmin` |
| Self-vs-admin scoping pattern | [attendance.js:95](../../backend/src/routes/attendance.js), [leave.js:246](../../backend/src/routes/leave.js) |
| Read-sas + BLOB_GONE + `canReplace` | [drawings.js:819](../../backend/src/routes/drawings.js) |
| Admin list pattern (directory) | [adminEmployees.js](../../backend/src/routes/adminEmployees.js) |
| Notification + preference mute + EmailLog | [notify.js](../../backend/src/lib/notify.js) `CRITICAL_TYPES`, `shouldSkipSend`, `fanOutEmail`. **Reuse `sendPayslipEmail()` direct-call bypass (not `CRITICAL_TYPES`).** |
| Notification preferences API shape | [routes/notifications.js](../../backend/src/routes/notifications.js) `/preferences` |
| Idempotency (required for `confirm-uploads`) | [RequestDedupe](../../backend/prisma/schema.prisma) (DR-020) via `lib/idempotency.js` |
| Pending-intent sweep | [internal-upload-sweep.js](../../backend/src/routes/internal-upload-sweep.js) — **reused as-is for the `payslips/` UploadIntent rows; no new internal endpoint** |
| RLS pattern | [migrations/20260910000000_rls_lockdown_s1/migration.sql](../../backend/prisma/migrations/20260910000000_rls_lockdown_s1/migration.sql) |
| Bucket allowlist | `ALLOWED_R2_BUCKETS` / `REQUIRED_R2_BUCKETS` ([blobStorage.js](../../backend/src/lib/blobStorage.js)) — no change, reuse `dpr-documents` |
| Rate limit primitives | [rateLimit.js](../../backend/src/middleware/rateLimit.js) — extend with 4 new limiters (`payslipListLimiter`, `payslipDownloadLimiter` 10/min + 50/day, `payslipWriteLimiter` 20/h) |
| Soft-delete column convention | `ProjectAttachment.deletedAt`, `Employee.deletedAt` |
| Header parsing / helmet / CORS / body 1mb | [index.js](../../backend/src/index.js) |
| Tenant guardrail | [TENANCY.md](../../TENANCY.md) + [.github/workflows/tenancy-doc.yml](../../.github/workflows/tenancy-doc.yml) |
| SPA upload helper (3-step state) | [src/lib/blobUpload.js](../../src/lib/blobUpload.js) `uploadBlob`, `BlobUploadError` (now also does pre-flight magic-byte sniff) |
| Global 401 interceptor | [src/lib/api.js](../../src/lib/api.js) + [src/contexts/AuthContext.jsx](../../src/contexts/AuthContext.jsx) |
| Bell notification UI | [src/components/PortalLayout.jsx](../../src/components/PortalLayout.jsx) `NotificationBell` (R21 portal) |
| Sidebar group structure | [src/components/PortalLayout.jsx](../../src/components/PortalLayout.jsx) "Records" / "Admin" / "User" |
| Page heading + breadcrumb + filter chip | [src/pages/portal/MyProjectReports.jsx](../../src/pages/portal/MyProjectReports.jsx) |
| Empty state | [src/pages/portal/MyProjectReports.jsx](../../src/pages/portal/MyProjectReports.jsx) |
| Toast + dedupe | [src/contexts/ToastContext.jsx](../../src/contexts/ToastContext.jsx) (R17 dedupe by reason) |
| **Misdelivery purge script (NEW v2)** | `backend/scripts/purge-payslip-misdelivery.js` — `deleteBlob` from [blobStorage.js](../../backend/src/lib/blobStorage.js) + raw `DELETE FROM payslip` + AppLog audit row via [requestLogger.js](../../backend/src/middleware/requestLogger.js). No cron. |

**Net new code in backend:** 1 new Prisma model + 1 partial-unique-index migration (raw SQL with DR-031-pattern drift detection) + 1 RLS migration, 1 new `verifyBlobMagicBytes` helper in [blobStorage.js](../../backend/src/lib/blobStorage.js), 1 new `kind='payslip'` branch in [uploadIntentBinding.js](../../backend/src/lib/uploadIntentBinding.js), 3 new rate limiters, 1 new route file, 1 new documented manual purge script.

**Net new code in frontend:** 2 new page files, 4 new component files (including `EmployeePicker`), 1 new icon, 2 new constants, ~10 new functions in `api.js`. No new dependencies.

---

## G. Threat model and security controls

### G.1 Threat model table

| ID | Threat | Pre-condition | Primary mitigation | Defense in depth | Severity | Detection signal |
|---|---|---|---|---|---|---|
| PAY-01 | IDOR — employee reads another employee's payslip | Valid employee JWT, attacker knows/guesses ULID | `requireAuth` + controller `where: { employeeId: req.employeeId, publishedAt: { not: null }, deletedAt: null }` ([attendance.js:95](../../backend/src/routes/attendance.js), [leave.js:246](../../backend/src/routes/leave.js) patterns) | RLS `deny_authenticated` on `payslip` ([S1 migration](../../backend/prisma/migrations/20260910000000_rls_lockdown_s1/migration.sql) pattern) | H | AppLog row 404 on attempted cross-employee ULID |
| PAY-02 | Privilege escalation — employee calls admin endpoint | Employee JWT to `/api/admin/payslips` | `requireAdmin` + `requireFreshAdmin` ([auth.js](../../backend/src/middleware/auth.js)) | No service-role client in employee-facing handlers; route prefix `/api/admin/*` exclusively `requireAdmin`-gated | H | AppLog row 401/403 from admin route |
| PAY-03 | Upload tampering — malicious PDF triggers XSS/SSRF on render | Admin uploads PDF with embedded JS or external fetch | Server-side magic-byte sniff (`%PDF-`) at **confirm-upload** time (§D.1); 5 MB cap stricter than `MAX_PHOTO_SIZE=10MB`; SPA never renders inline (downloads via Blob URL); CSP `frame-ancestors 'none'` ([index.js](../../backend/src/index.js)) | Client-side pre-flight sniff; 5 MB cap; no in-portal preview | H | AppLog on confirm with non-PDF magic if client check fails |
| PAY-04 | SAS leakage — read URL shared externally | Employee shares 1h SAS link in chat/email | **No SAS reaches the browser for employee download** (proxy through origin) | Admin replace flow uses SAS internally only; 15-min TTL via `expiresIn` (not 1h) | M | AppLog on every internal SAS mint |
| PAY-05 | Audit tampering — admin deletes audit rows | Admin attempts UPDATE/DELETE on `Payslip` audit columns | Audit history lives on the `Payslip` row, not in `AppLog`. RLS deny for `authenticated` covers the table. No application-level UPDATE on `uploadedById` / `publishedById` / `revokedById` (only the controllers that perform the transitions write those columns). | DB-level protection via `REVOKE UPDATE` on the audit columns is deferred (no SOC2/ISO driver); `AppLog` retains request-shape audit at the HTTP layer. | M | Periodic sweep detecting sequence gaps (deferred) |
| PAY-06 | PII in logs — employee name/email in URL or body | Verbose log captures `req.body` raw | Structured logging via `lib/log` + [requestLogger.js](../../backend/src/middleware/requestLogger.js) HMAC `employeeHash`; URL object key hashed before log | No raw `req.body` logging; numeric-field scrubber in `lib/log`; lint rule banning `console.log(req.*)` in `src/routes/*` | H | Log-scan job + lint CI |
| PAY-07 | Salary-figure exfiltration via email/logs | Notification body or AppLog captures amount | **Schema excludes amount fields**; payslip events bypass `shouldSkipSend` via direct `sendPayslipEmail()` call (see §I); email body is the neutral template in §B.5 | AppLog metadata limited to `{payslipId, year, month, requestId, latencyMs, status}`; numeric-field scrubber; per-row audit columns store only ids + timestamps | M | Email template review; log-scan job |
| PAY-08 | BLOB_GONE confusion — sweep deletes confirmed blob, employee gets 410 | DR-001 sweep races with employee download | **DR-001 destructive cleanup is disabled in production** (per [DR-008 investigation](../../verification/2026-09-23-dr-008-investigation/)); soft-delete only on explicit admin action; employee 410 → "Contact HR" | Read-sas HEAD-verify + 410 BLOB_GONE pattern from [drawings.js:819](../../backend/src/routes/drawings.js) | M | AppLog 410 BLOB_GONE spike |
| PAY-09 | Sweep cleanup race — TTL window collision | Upload-confirm and sweep both fire on same row | Atomic `bindPhotoIntentsTx` ([uploadIntentBinding.js](../../backend/src/lib/uploadIntentBinding.js)) + `PhotoBindingLostError → 409`; partial unique `(employee_id, year, month) WHERE deleted_at IS NULL` catches the duplicate | PENDING TTL 20min ([uploadRoutes.js](../../backend/src/lib/uploadRoutes.js)); `PayslipBindingLostError` analogue for the `payslips/` kind | L | Duplicate `UploadIntent` log rows in same second |
| PAY-10 | Multi-tenant drift — code path adds per-employee data isolation that conflicts with TENANCY.md | Future dev adds `tenantId` column or per-tenant RLS | [.github/workflows/tenancy-doc.yml](../../.github/workflows/tenancy-doc.yml) guardrail fails CI on `tenantId` mentions in new code; [TENANCY.md](../../TENANCY.md) declares single-tenant | Single schema; grep for `tenantId` in PR review; linter rule | M | CI failure on PR |
| PAY-11 | Token theft → payslip archive dump | Attacker steals employee JWT (XSS, malicious extension, leaked device) | Short-lived JWT (≤15min stale); revoked-token check in `requireAuth`; per-employee download rate limit (10/min + 50/day) | Re-derive `req.employeeId` from JWT sub only, never from body/query (server-side test) | H | Spike in `payslipDownloadLimiter` 429s from one token |
| PAY-12 | RLS bypass via service role misconfig | Prisma client uses service-role DB user in employee-facing handler | All employee-facing routes use request-scoped Prisma without service role; RLS pattern at [S1 migration](../../backend/prisma/migrations/20260910000000_rls_lockdown_s1/migration.sql) | Controller filter is the contract; CI guard rejects `prisma.payslip.*` calls in `src/routes/me/*` that don't pass `req.employeeId` | H | Static analysis: grep for unguarded `findMany`/`findFirst` in employee handlers |
| PAY-13 | Supply-chain risk — malicious npm dep exfiltrates `R2_*` env vars | Compromise of a transitive dep | `dependency-audit.yml` (npm audit, non-blocking); Dependabot capped at 5 PRs, majors ignored; Semgrep OSS digest-pinned | Restrict `R2_*` env to essential processes; egress allowlist | M | Outbound network egress from API process to unknown host |
| PAY-14 | Publish race — two admins click Publish for the same month | Concurrent admin clicks | `publishedAt IS NULL` predicate in the publish UPDATE guards re-publish as a no-op; both admins see the same coverage state after; emails fire once per row per publish | Idempotency-Key on the publish endpoint also routes through `RequestDedupe` | L | Duplicate email-row count in AppLog (`sendPayslipEmail`) |
| PAY-15 | Wrong-employee upload — admin assigns file to wrong employee | Manual misdelivery | (a) Draft state means employee doesn't see it before Publish; admin can re-pick employee via Replace before clicking Publish. (b) Post-publish correction: replace creates a new draft that the admin must re-pick and re-publish. (c) Hard purge via `scripts/purge-payslip-misdelivery.js` (documented) | Audit columns (`uploadedById`, `publishedById`) let us identify who did it; coverage grid shows status | M | AppLog `payslip.purged` rows |

### G.2 IDOR analysis (every endpoint)

| Endpoint | Employee A requests B's resource | Response |
|---|---|---|
| `GET /api/payslips/my` | n/a — A's own list scoped at controller (`employeeId = req.employeeId`, `publishedAt NOT NULL`, `deletedAt IS NULL`) | A's rows only |
| `GET /api/payslips/my/:id/download` (id = B's payslipId) | `findFirst({ where: { id, employeeId: A } })` returns null | **404** (not 403, to avoid existence disclosure; [drawings.js:819](../../backend/src/routes/drawings.js) precedent) |
| `GET /api/payslips/:id` (id = B's, A is employee) | controller filter rejects | 404 |
| `GET /api/payslips?year=&month=` (A is employee) | `requireFreshAdmin` rejects | 401/403 |
| `GET /api/payslips/:id/read-sas` (A is employee) | `requireFreshAdmin` rejects | 401/403 |
| `PATCH /api/payslips/:id/revoke` (A is employee) | `requireFreshAdmin` rejects | 401/403 |
| `POST /api/payslips/upload-intents` (A is employee) | `requireFreshAdmin` rejects | 401/403 |
| `POST /api/payslips/confirm-uploads` (A is employee) | `requireFreshAdmin` rejects | 401/403 |
| `POST /api/admin/payslips/publish` (A is employee) | `requireFreshAdmin` rejects | 401/403 |
| `POST /api/payslips/:id/publish` (A is employee) | `requireFreshAdmin` rejects | 401/403 |

The two highest-risk endpoints are the read-sas-equivalents (`/my/:id/download` proxy and admin `/replace` mint). QA must run `--repeat-each=10` on both, asserting identical 404 timing for: B's ULID, soft-deleted ULID, non-existent ULID.

### G.3 PII minimization

**Stored on `Payslip`:** `id` (ULID), `employeeId` (FK), `year`, `month`, `ulid`, `contentType` (locked to `application/pdf`), `contentLength`, audit (`uploadedById`, `publishedById?`, `publishedAt?`, `revokedById?`, `revokedAt?`, `revokedReason?`), `deletedAt?`, `createdAt`, `updatedAt`.

**Rejected at the boundary:** the request validator (zod) rejects unknown fields, not just omits them. **v2 dropped `originalFilenameHash`** (carried for v1 privacy, removed per the user's "harmless but drop if privacy-only" call — names like `EMP012_092026` are guessable).

**`AppLog` on download — metadata only:** `{event: 'payslip.download', payslipId, year, month, requestId, latencyMs, status}`. Never log: filename, employee name, email, employeeId raw (HMAC `employeeHash` is fine), R2 URL, blob key.

**Email body — neutral template:** the exact text from §B.5. No name, no employee id, no filename, no salary figure, no period range, never a direct PDF link.

**Magic-byte PDF check at confirm-upload time:** server does `Range: bytes=0-3` GET against R2 and asserts the first 4 bytes equal `%PDF-`. Mismatch → 415 `NOT_PDF`. See §D.1 for the helper and timing.

### G.4 Download architecture — proxy through our origin

The frontend's "in-app fetch + Blob URL" pattern wins over backend's "raw 1h SAS URL to the browser" because:

1. R2 SAS may not honor `Content-Disposition` reliably across clients. Direct SAS gives the browser a key-shaped filename (`01J9X4K7ZP_102026.pdf`), not "Payslip-October-2026.pdf".
2. A SAS URL in the address bar is a visible signed token. Even 1h is enough for shoulder-surfing on a shared device — payslip is the highest-PII document in the portal.
3. On Karthik's 4G, the extra hop is ~50–150 ms for a <500 KB PDF. Irrelevant for 2-4 downloads/year.
4. Audit (which employee downloaded which) and progress UX are easier with proxy.
5. Testing is simpler — mock one endpoint, not SAS issuance + R2 fetch.

**`GET /api/payslips/my/:id/download` (proxy):** server validates ownership (employee-self OR admin), HEAD-verifies via `verifyBlobExists` ([blobStorage.js](../../backend/src/lib/blobStorage.js)), fetches the blob server-side (or streams via a 15-min internal SAS that never leaves the server), and returns the binary with `Content-Disposition: attachment; filename="Payslip-{Month}-{Year}.pdf"` + `Content-Type: application/pdf` + `X-Frame-Options: DENY` + `Content-Security-Policy: frame-ancestors 'none'`.

The 1h SAS TTL is no longer a concern for employee downloads. The 15-min internal SAS used by the proxy is short by design (just enough to cover the upstream fetch). Admin `replace` flow mints a 15-min PUT SAS (already in `mountUploadRoutes` via the `PENDING_TTL_MS=20min` window).

### G.5 Notification privacy

`shouldSkipSend` ([notify.js](../../backend/src/lib/notify.js)) lets an employee mute notification types. The mute applies to "marketing" or low-stakes events. A payslip is a legal/financial event — silent failure is worse than the override.

**Resolution:** Payslip events bypass `NotificationPreference.emailEnabled` and `typeMutes` directly. Implementation: the payslip notification path calls a dedicated `sendPayslipEmail()` helper outside the standard `shouldSkipSend` gate. Document in the email footer: "This is an automated message about a payroll document and is not affected by your notification preferences."

**Why not `CRITICAL_TYPES.PAYSLIP_AVAILABLE`?** That special-case flag would be checked in `shouldSkipSend`, audited separately, and expanded by every future "important" event — drift risk. A direct `sendPayslipEmail()` call is one explicit code path with no special-case branch in the shared helper.

**Bell:** the in-portal `Notification` row fires regardless of `typeMutes` (per R25). The publish endpoint always creates both the email and the bell row, regardless of preference state.

### G.6 Audit and logging

**Two audit sources** (v2 — explicit split):

1. **`Payslip` row audit columns** (payroll-grade, durable beyond 30 days):
   - `uploadedById` + `createdAt` — who and when uploaded (immutable after row creation).
   - `publishedById?` + `publishedAt?` — who and when published (immutable after the publish transition; second publish attempt is a no-op).
   - `revokedById?` + `revokedAt?` + `revokedReason?` — who, when, why revoked (immutable after revoke).
   - `deletedAt?` — soft-delete marker.

2. **`AppLog` row** (HTTP-shape audit, 30-day retention per existing cron): every endpoint inherits `AppLog` from [requestLogger.js](../../backend/src/middleware/requestLogger.js) (`route`, `method`, `status`, `latencyMs`, `requestId`, `employeeHash`, `isAdmin`). Captures the request shape; never captures PII in metadata.

**Structured application log lines added** (via `lib/log.js`, mirroring existing `safeAsync` pattern):

| Event | Metadata | Redacted |
|---|---|---|
| `payslip.upload_intent.created` | `{employeeId, year, month, fileSizeBytes, contentType, requestId, adminId}` | filename never logged |
| `payslip.upload_intent.bound` | `{payslipId, ulid, employeeId, year, month, requestId, adminId}` | — |
| `payslip.upload_intent.failed` | `{ulid, employeeId, year, month, reason, requestId, adminId}` | — |
| `payslip.confirm.magic_byte_mismatch` | `{ulid, employeeId, year, month, requestId, adminId}` | — |
| `payslip.download` (employee, proxy) | `{payslipId, year, month, requestId, latencyMs, status}` | employeeId already in JWT subject; HMAC `employeeHash` always |
| `payslip.publish.bulk` | `{year, month, publishedCount, skippedCount, emailsSent, emailsThrottled, requestId, adminId}` | — |
| `payslip.publish.single` | `{payslipId, requestId, adminId}` | — |
| `payslip.replace.intent_created` | `{payslipId, requestId, adminId}` | — |
| `payslip.replace.bound` | `{payslipId, ulid, requestId, adminId}` | — |
| `payslip.revoked` | `{payslipId, employeeId, year, month, requestId, adminId, reason}` | — |
| `payslip.purged` (script, NEW v2) | `{payslipId, employeeId, year, month, ulid, blobPath, requestId, adminId, reason}` | — |

No PII (name, email, raw filename, raw employeeId) in any line. SAS URLs never logged.

### G.7 Right to erasure / retention

Default in v1: **soft-delete forever**. No hard-delete cron. The `deletedAt` row stays, the R2 blob stays. Storage at 250 MB is rounding error. If compliance asks for hard-delete-within-X-days, add a GH Actions cron then (per the R40 pattern). Until then, the only delete paths are:

- Admin `PATCH /api/payslips/:id/revoke` — soft-delete on the row only (R2 blob stays).
- Manual `scripts/purge-payslip-misdelivery.js` — soft-delete on row + R2 blob delete + hard-delete on row. Used only for misdelivery, not for routine retention. Requires `--reason` argument.

`AppLog` rows for a deleted employee remain for audit; `employeeHash` is already one-way (HMAC), so no FK to the deleted employee is required. `Payslip` audit columns are nullable and survive employee-row deletion via `onDelete: SetNull` on `publishedBy` / `revokedBy`, and `onDelete: Restrict` on `uploadedById` (the uploader must remain a real employee for the audit to be meaningful).

### G.8 R2 backup gap (decision deferred)

R2 files are not covered by the nightly DB backup. Two options if backup is required:

- (a) Enable R2 cross-region replication (paid tier, ~$0.02/GB-month replication egress).
- (b) Add a periodic `rclone sync` to a second Cloud account or Render persistent volume (custom code + storage).

v1 default: **rely on R2's 11-nines durability, document the gap explicitly.** If HR / compliance asks for cross-region backup, add option (a) in v2 — it is the lower-friction path. Captured in §J.12.

### G.9 Open questions for Security (escalated to §J)

- Step-up auth before first download per session?
- Device binding / corporate-IP restriction?
- Reminder email if not viewed within 7 days?

These are P2 in v1. None blocks launch.

---

## H. Test plan

### H.1 Pyramid and budget

- **Unit (jest, backend) — 14 tests.** Models, helpers, RLS shape, log redaction, magic-byte helper.
- **Integration (jest + supertest) — 24 tests.** Every route, every documented error path, every cross-employee boundary. Mock external (R2, notify) at the module boundary; Prisma against a per-test transactional schema.
- **E2E (Playwright) — 7 journeys.** Admin monthly ritual (with publish), employee download, cross-employee attempt, BLOB_GONE replace path, two privacy guards, wrong-employee recovery.

Total: **45 tests**. Integration is intentionally the heaviest layer.

### H.2 Unit (jest, backend)

- `payslip.unique-constraint-p2002` — partial unique catches duplicate month.
- `mountUploadRoutes.rejects-non-payslips-prefix` — proposed R2 key outside `payslips/` is rejected by `allowedPathPrefixesPerContainer`.
- `verifyBlobExists.three-state-happy / three-state-gone / three-state-throws` — the proxy download branches on this.
- `verifyBlobMagicBytes.three-state-pdf / three-state-non-pdf / three-state-r2-unreadable` — NEW v2: the confirm handler branches on this.
- `notify.shouldSkipSend.payslip-muted` — non-payslip types are gated; confirms `shouldSkipSend` is unchanged.
- `sendPayslipEmail.bypasses-mute` — dedicated helper sends regardless of `emailEnabled` / `typeMutes`.
- `notify.email-template.no-pii` — captured email body asserted to contain no name, no employee id, no filename, no period range, only the period string.
- `requestDedupe.key-shape-confirm-uploads` — `payslip-confirm-{adminId}-{batchId}` exact string.
- `requestDedupe.key-shape-publish` — publish-key pattern (employee-self excludes any publish key).
- `rls.anon-select-denied` — anon on `payslip` returns 0 rows.
- `rls.authenticated-select-denied` — `authenticated` policy is `USING(false)`, returns 0 rows.
- `lib.log.redaction-payslip-download` — `payslip.download` row contains no employee name / no filename / no email.
- `lib.log.redaction-payslip-revoked` — `payslip.revoked` row contains only ids, period, reason, requestId.
- `partial-unique-migration.drift-detected` — simulate a drift in `pg_get_indexdef`; verify the migration's `RAISE EXCEPTION` fires (mirrors the no_overlap_leave DR-031 test).

### H.3 Integration (jest + supertest)

- `POST /api/payslips/upload-intents` (admin): `int.upload-intents.happy` · `int.upload-intents.missing-scope-employee` (403) · `int.upload-intents.oversize` (413) · `int.upload-intents.wrong-content-type` (415) · `int.upload-intents.unknown-employee` (404).
- `POST /api/payslips/confirm-uploads` (admin): `int.confirm-uploads.happy` · `int.confirm-uploads.missing-idempotency-key` (400) · `int.confirm-uploads.ulid-reused` (409) · `int.confirm-uploads.binding-conflict` (409) · `int.confirm-uploads.magic-byte-mismatch` (415, NEW v2 — server-side read after upload).
- `POST /api/admin/payslips/publish?year=&month=` (admin, NEW v2): `int.publish-bulk.happy` (transition draft→published, fan-out emails) · `int.publish-bulk.idempotent` (second call is no-op, no extra emails) · `int.publish-bulk.empty-month` (returns `{published: 0, ...}`, no fan-out) · `int.publish-bulk.skips-already-published`.
- `POST /api/payslips/:id/publish` (admin, NEW v2): `int.publish-single.happy` · `int.publish-single.already-published-noop`.
- `GET /api/payslips/my` (employee): `int.my.happy` · `int.my.excludes-drafts` (NEW v2 — admin-uploaded draft must not appear) · `int.my.excludes-deleted` · `int.my.empty-200` (no row → 200 `{items: []}`, not 404) · `int.my.no-cursor` (NEW v2 — assert response has no `nextCursor` field).
- `GET /api/payslips/my/:id/download` (employee proxy): `int.download.happy` (asserts `Content-Disposition` + `Content-Type` + `X-Frame-Options: DENY`) · `int.download.cross-employee-404` (must pass 10x in `--repeat-each=10`) · `int.download.revoked-token-401-cors` · `int.download.blob-gone-410` · `int.download.rate-limit-429` (10/min cap) · `int.download.draft-not-visible-404` (NEW v2 — admin uploaded but didn't publish, employee gets 404).
- `GET /api/payslips/:id` (employee-self OR admin): `int.get.happy-employee` · `int.get.happy-admin` · `int.get.cross-employee-404`.
- `GET /api/payslips?year=&month=` (admin): `int.list.happy` · `int.list.cursor-pagination` (admin list may still paginate) · `int.list.missing-scope-employee` (403).
- `GET /api/admin/payslips/coverage?year=&month=` (admin): `int.coverage.happy` · `int.coverage.excludes-pre-join-employees` (NEW v2 — uses `Employee.createdAt` proxy).
- `PATCH /api/payslips/:id/revoke` (admin): `int.revoke.happy-soft-delete` · `int.revoke.stamps-revokedById-and-revokedAt` (NEW v2 — assert columns populated) · `int.revoke.cannot-read-after-revoke-employee` (404) · `int.revoke.can-read-after-revoke-admin` (tombstone view).
- `POST /api/payslips/:id/replace` (admin): `int.replace.happy-creates-draft` (NEW v2 — replaces creates a draft row, not a published row; admin must then publish) · `int.replace.previous-blob-gone` (410) · `int.replace.wrong-content-type` (415).

### H.4 E2E (Playwright)

- `e2e.admin.monthly-upload-and-publish-ritual` (NEW v2 — covers full flow): log in, open admin payslips, pick `2026-09`, drag 50 PDFs into the dropzone, resolve each file to an employee via the per-row picker, confirm upload, see coverage = 50/50 in DRAFTS view, click **Publish September**, see coverage = 50/50 in PUBLISHED view.
- `e2e.admin.replace-creates-draft` (NEW v2): re-upload a PDF for an employee with a published row. Assert old row soft-deleted, new draft row appears. Click per-row Publish. Assert old row still soft-deleted, new row published, email fires.
- `e2e.employee.download` — log in as employee, open "My Payslips", tap Download on latest month, assert PDF downloads with `Payslip-October-2026.pdf` filename.
- `e2e.employee.cannot-see-admin-page` — log in as employee, navigate to `#/admin/payslips`, expect client-side redirect or 403.
- `e2e.cross-employee-idor` — log in as A, capture the read-sas proxy URL of A's payslip, log in as B, hit the same URL, expect 404. **Must pass 10/10 in `--repeat-each=10` locally and in CI.**
- `e2e.blob-gone-contact-hr` — admin soft-deletes a payslip (`PATCH /:id/revoke`), employee tries to download, sees "Contact HR" — never a stack trace, never the blob key.
- `e2e.employee.draft-not-visible` (NEW v2): admin uploads a payslip but does NOT publish. Employee opens My Payslips. The draft row must not appear.

### H.5 Security tests

Mapped to the §G.1 threat model:

1. Cross-employee read → 404, never 403, identical response body to "row does not exist".
2. RLS cross-employee read at DB layer — `SELECT` as `authenticated` returns 0 rows for non-owner.
3. Revoked token attempt → 401 with CORS headers intact.
4. Expired internal SAS → 410.
5. Tampered ulid → 400, no row created, no R2 call.
6. BLOB_GONE → 410 with `canReplace: false` for employee, `canReplace: true` for admin.
7. Magic-byte mismatch on non-PDF upload → 415 at confirm (after R2 has the bytes), no `Payslip` row created.
8. Partial unique race — two parallel uploads for same (employee, year, month), exactly one wins.
9. Audit row presence — every cross-tenant attempt writes an `AppLog` row with `route: 'POST /api/payslips/...'` + `requestId` + HMAC `employeeHash`. Audit columns on `Payslip` are populated by the controllers, not by `AppLog`.
10. Rate limit 429 — 11th request in 60s; 51st in 24h.
11. Content-Disposition + Content-Type + X-Frame-Options on the download proxy.
12. Email body redaction — capture sent email, assert no name, no employee id, no amount field, no filename, only the period string.
13. Payslip email bypass — set `NotificationPreference` to mute all + `emailEnabled: false`, trigger publish, assert email still sent.
14. Soft-delete race — admin revokes while employee is downloading; expect either success (stream completes) or 410, never inconsistent.
15. Publish idempotency — call publish endpoint twice; second call is no-op, exactly one set of emails per row.
16. Filename privacy — confirm `originalFilename` from the request body is NEVER persisted (no `originalFilenameHash` column in v2; the column was dropped per the v2 review).

### H.6 Mocking strategy

- **Prisma**: per [inspect-test-noisy-investigation.md](../../verification/) (mock was missing `prisma.project`), mock Prisma with `jest.mock('@prisma/client')` and a per-test `prismaMock` from `backend/__tests__/_mocks/prisma.js`. Every relation-touched test must register its findUnique.
- **`verifyBlobExists`**: `mockVerifyBlobExists` factory with three returned shapes — `ok`, `gone`, `throw`. Default `ok`. BLOB_GONE tests flip once.
- **`verifyBlobMagicBytes`** (NEW v2): `mockVerifyBlobMagicBytes` factory with three shapes — `pdf`, `non-pdf`, `r2-unreadable`. Default `pdf`.
- **SAS URL generator**: `jest.mock('@aws-sdk/s3-request-presigner', …)` returns a deterministic URL with `expires=` parsed from a fixture.
- **`lib/notify`**: fake in-memory queue. `shouldSkipSend` runs against an in-memory prefs map. The dedicated `sendPayslipEmail` helper is also faked and asserted directly.

### H.7 Test data

- `payslipFactory({ overrides })` returns `{id, employeeId, year, month, ulid, uploadIntentUlid, contentType: 'application/pdf', contentLength, uploadedById, publishedById: null, publishedAt: null, revokedById: null, revokedAt: null, revokedReason: null, deletedAt: null}`. **The factory throws if any salary field is requested** (regression guard for PAY-07).
- `payslipCoverageTestHelper(employees, existingPayslips)` returns the coverage DTO, pre-filtering employees by `Employee.createdAt <= month-start`.
- Per-worker fixtures: `w<workerIndex>-employee@acs.test`, `w<workerIndex>-admin@acs.test`. No PII.

### H.8 Coverage targets

- New payslip route file: **85% line, 80% branch**. Hard floor.
- Unique-constraint handling (P2002 catch + binding conflict): **100% line, 100% branch**. Privacy-critical.
- Download proxy path (cross-employee 404, BLOB_GONE 410, revoked 401, magic-byte 415, rate limit 429): **100% line, 100% branch**. Every branch is a disclosure vector.
- `lib/log` redaction for payslip events: **100% line**. Any new log line is a regression until proven redacted.
- `verifyBlobMagicBytes` (NEW v2): **100% line, 100% branch** on the 3-state return shape.

### H.9 Regression risk

Run the full `backend/__tests__/` jest suite plus the targeted cases below on every PR that touches `backend/src/routes/payslips*`, `backend/src/lib/uploadIntentBinding.js`, `backend/src/lib/blobStorage.js`, or `backend/src/middleware/auth.js`:

- `UploadIntent` happy-path (DR-001/006/008 binding) — confirms we did not regress the binding contract reused for payslips.
- [drawings.js:819](../../backend/src/routes/drawings.js) read-sas BLOB_GONE test — 3-state behavior is shared code, must not regress.
- [attendance.js:95](../../backend/src/routes/attendance.js) own-data-only test — confirms RLS pattern still works.
- [leave.js:246](../../backend/src/routes/leave.js) own-data-only test + `no_overlap_leave` constraint test — second opinion; the partial-unique migration mirrors this pattern, so any drift detection test exercises the same code shape.
- `AppLog` row presence for 401s — confirms the request logger still writes for the new route when auth fails.
- [.github/workflows/tenancy-doc.yml](../../.github/workflows/tenancy-doc.yml) — confirms CI still picks up the new test files.

---

## I. Design decisions and dissent

This section records the non-obvious calls made during the multi-agent design (Round 3) and the v2 review. Where v2 changed v1, the v1 call is shown alongside the v2 rationale.

### I.1 State machine A → A′ (publish gate)

**Chosen: state machine A′ — `deletedAt` for revoke + `publishedAt` for publish.**

v1 had a single `deletedAt` column (state machine A). v2 added `publishedAt` + `publishedById` because answer 5 made upload ≠ publish: "Send per employee, but only after an explicit publish rather than on each upload."

Why A′ wins:
- One explicit gate separates "admin action" (creates a draft, audit column populated) from "employee notification" (the publish transition, fires the email).
- Re-publish is a no-op (`publishedAt` is already set), so the publish endpoint is idempotent without extra plumbing.
- Revoke is unchanged: still soft-delete via `deletedAt`.
- The "Replaced" scenario is now simpler: replace creates a draft, admin re-publishes. Employee sees the latest published version only.

What we lose: one extra admin click per month (Publish after Confirm). Acceptable: the explicit publish gate is the entire privacy driver, and 50-row coverage flipping in one click is a clear affordance.

### I.2 Notification bypass — direct call, not `CRITICAL_TYPES`

**Chosen: dedicated `sendPayslipEmail()` helper, called outside `shouldSkipSend`.**

Three drafts disagreed in Round 1: backend said add to `CRITICAL_TYPES`, security agreed, product said "bell always fires, email respects prefs." UX cross-review recommended the dedicated helper. Security cross-review agreed.

Why the dedicated helper wins:
- One explicit code path, no special-case branch in the shared `shouldSkipSend` helper.
- `CRITICAL_TYPES` is a set of strings that future devs will add to without thinking. The dedicated function name documents the intent.
- The bypass scope is one type, defined in one place, with a code-review comment.
- The email footer documents the override behavior, so it's not surprising to muted users.

The publish endpoint fans out emails outside the transaction; partial-success returns `{emailsSent: N, emailsThrottled: M}` so the UI surfaces the gap.

### I.3 Download — proxy through our origin, not raw R2 SAS

**Chosen: `GET /api/payslips/my/:id/download` streams the blob server-side.**

Frontend draft and security draft both pushed for proxy. Backend draft proposed raw 1h SAS. UX cross-review strongly recommended proxy. Security cross-review agreed.

Why proxy wins (5 reasons): see §G.4.

The cost: one extra hop through our origin. For a 500 KB PDF on 4G, this is ~50–150 ms — irrelevant for 2–4 downloads/year.

### I.4 No `AdminAudit` table

**Chosen: rely on existing `AppLog` + per-row audit columns on `Payslip`.**

Security draft proposed a new `AdminAudit` table with `REVOKE UPDATE, DELETE`. Backend, DB, and QA drafts did not include it. UX cross-review recommended dropping it. Security cross-review agreed.

Why: the v2 plan uses two audit sources — `Payslip` row columns (payroll-grade, immutable beyond the row's existence) + `AppLog` (HTTP-shape audit, 30-day retention). Together they cover the threat model without doubling the write surface.

What we lose: `REVOKE UPDATE` on audit columns. Acceptable for v1 (no SOC2/ISO driver). Deferred.

### I.5 No `internal-payslip-sweep` / no 90-day cron

**Chosen: soft-delete forever in v1.**

DB draft proposed soft-delete + 90-day hard-delete cron + new `internal-payslip-sweep` endpoint. UX cross-review recommended soft-delete-forever. Security cross-review recommended reusing the existing DR-001 endpoint with a new flag (`?override=PAYSLIP_SWEEP_ENABLED`) rather than adding a new internal endpoint. Both agreed: no new internal endpoint in v1.

Why: storage at scale (50 emp × 5 yr × 1 MB ≈ 250 MB) is rounding error. Cron adds operational complexity (Render cron config, error handling, monitoring, sweep-race tests, double-firing protection) for no v1 user-visible benefit. If compliance asks, add the cron later (GH Actions pattern per R40, not a new internal endpoint).

The **manual purge script for misdelivery** is a separate thing — see §C.10 / §I.10.

### I.6 Filename handling — dropped in v2

**Chosen: drop `originalFilenameHash` entirely (v2).**

v1 stored `originalFilenameHash` (SHA-256), never the raw `originalFilename`. The v2 review correctly noted that names like `EMP012_092026` are guessable; a hash adds little privacy value for a low-entropy filename. Dropped.

### I.7 Bulk-upload attribution — per-row picker, not filename pattern (v2 change)

**Chosen: per-row picker.**

v1 had filename pattern matching (`EMPID_mmyyyy.pdf`) auto-attributing dropped files to employees. The v2 review correctly noted that payroll SaaS tools won't output our internal Employee.id, and that guessing an internal id from a filename pattern is the wrong abstraction.

Stage 1 = per-row picker. Each dropped file sits beside an unsetsed `EmployeePicker`. Admin resolves each row's employee before confirming. Same component used by the single `[Upload]` button.

Why this is the right Stage 1:
- Works regardless of what Priya's payroll SaaS emits.
- Costs one extra click per file compared to a working filename pattern, and saves the 50×5 = 250 clicks the v1 flow would cost when the pattern fails.
- Mirrors the existing admin pattern (`adminEmployees.js` directory).
- A `payrollId` column can be added to `Employee` later, layered on top of the picker.

### I.8 `Idempotency-Key` is REQUIRED on `confirm-uploads` (v1)

**Chosen: required, not optional.**

UX cross-review recommended required. With 50 bulk uploads on flaky 4G (admin is on the same portal as the employees), retries are guaranteed. Optional invites the "first attempt actually went through but the client retried, now we double-insert" failure mode.

### I.9 Bulk upload — drag-and-drop with per-row picker (v2 = v1 with picker change)

**Chosen: drag-and-drop per-row picker, P0 for Priya's monthly ritual.**

The v1 plan's drag-and-drop is preserved. The filename auto-match is dropped (see §I.7). The bulk dropzone queues files; each file gets a `EmployeePicker`; Confirm is disabled until all rows have an assigned employee.

### I.10 Manual misdelivery purge script (NEW v2)

**Chosen: documented `backend/scripts/purge-payslip-misdelivery.js`, no automation.**

The v2 review correctly noted that soft-delete leaves the wrong file in storage. The script:
- Verifies the row is currently soft-deleted (refuses otherwise).
- Deletes the R2 blob (`payslips/{year}/{month}/{employeeId}/{ulid}.pdf`).
- Hard-deletes the row.
- Writes an `AppLog` audit row.
- Requires `--admin=<email>` and `--reason=<text>` to run.
- Is idempotent and fails fast on re-runs.

This is **not** a cron. It is a documented manual tool for misdelivery only. Captured in §C.10.

### I.11 Partial unique migration mirrors `no_overlap_leave` (NEW v2)

**Chosen: PL/pgSQL block + idempotent drift detection + `RAISE EXCEPTION` on drift, mirroring [20260908150000_dr031_leave_constraint_correct_bound/migration.sql](../../backend/prisma/migrations/20260908150000_dr031_leave_constraint_correct_bound/migration.sql).**

v1 plan noted the partial unique index had to be raw SQL but did not specify the migration pattern. The v2 review correctly flagged this as drift-prone (the no_overlap_leave migration was rewritten twice — once silently broken, once with the right shape). We follow the same defensive pattern: detect drift, fail loudly.

### I.12 Unified admin page (coverage + upload + replace + revoke + publish)

**Chosen: one `/admin/payslips` page.**

UX cross-review recommended unifying. The v2 page has TWO view modes (Drafts / Published) selected by coverage state. The **Publish** button appears at the top of the page when there's at least one draft; per-row **Publish** buttons appear for late additions.

### I.13 What we cut from v1 (and from v2)

Following the user's "keep it simple, not overengineered" guidance, the following items were added by at least one Round 1 draft but cut in Round 3 (or in v2):

1. **`AdminAudit` table** (§I.4).
2. **`parentPayslipId` + `supersededAt` chain** (§I.1).
3. **90-day cron + `internal-payslip-sweep`** (§I.5).
4. **Year filter on employee view** — default sort newest; no cursor (per v2 answer 1).
5. **NEW pill on latest entry** — visual noise on a 6-inch screen.
6. **Self-service "resend notification" button** — the portal list is the source of truth.
7. **Sidebar badge** — bell already indicates.
8. **Replace confirmation modal** — silent supersede = single upload flow.
9. **Magic-link vs portal-link debate** — always portal-link.
10. **`contentVersion` column** — dropped in v2; soft-delete + audit columns cover replace detection.
11. **`originalFilenameHash` column** — dropped in v2; per the v2 review, guessable names make it low-value.
12. **`CRITICAL_TYPES.PAYSLIP_AVAILABLE` flag** (§I.2) — bypass directly.
13. **Bulk export (admin ZIP)** — not in v1.
14. **Filename-pattern auto-match (v1)** — dropped in v2; replaced by per-row picker.
15. **Cursor pagination on employee list (v1)** — dropped in v2; plain list ≤50 rows.
16. **`payrollId` column on `Employee`** — not in v2; Stage 1 uses Employee.id/email directly.
17. **`joinedAt` column on `Employee`** — not in v2; v1 uses `Employee.createdAt` as proxy (see §C.7).
18. **`contentHash` / `checksum` column** — R2 ETags; column duplicates.

---

## J. Known gaps and open questions

The following are decisions that affect v1 behavior and should be confirmed before implementation starts. Each is a "block ship until answered" question; everything else can be deferred to v2. The v2 review resolved the most critical items (1-8 from v1's open questions); the remaining items are the new v2 set.

### J.1 History cap on employee view

Confirmed (v2 answer 1): plain newest-first list, ≤50 rows server-side hard cap. If a single employee ever accumulates >50, revisit (deferred).

### J.2 Backfill strategy

Confirmed (v2 answer 2): start clean. No historical payslips in the system at go-live. If HR wants backfill of recent months at end of Stage 2 pilot, add a separate one-off script using the same upload pipeline.

### J.3 Retention period

Confirmed (v2 answer 3): no delete job in v1, regardless of retention period. HR/accountant confirms the actual period for compliance; we do not speculate (the "7 years under the IT Act" figure from v1 was unverifiable per the v2 review). If a hard-delete cron is added later, the value comes from HR/accountant, not from the plan.

### J.4 New joiner coverage

The v2 review correctly flagged the absence of `joinedAt`/`hireDate`/`startDate` on `Employee`. **v1 default:** use `Employee.createdAt` as proxy. Coverage grid filters out employees whose `createdAt > first day of {year}-{month}`.

This is a reasonable proxy because `Employee.createdAt` is the row-creation timestamp = essentially when they were added to the portal, which is at-or-after their actual hire date.

If HR supplies a true `joinedAt` (or `hireDate`), add `Employee.joinedAt DateTime?` as an additive nullable column and switch the coverage filter. Decision captured here so we don't quietly use the wrong date.

### J.5 Publish cadence

Confirmed (v2 answer 5): per-employee immediate, after explicit publish action. Throttle via `BULK_PUBLISH_EMAIL_DELAY_MS` (default 100 ms between emails). Verify Resend's daily limit at go-live (currently ~100/day on free tier, but check at deploy time).

### J.6 Replaced pill visibility for employees

Confirmed (v2 answer 6): latest only. No "Replaced" pill on employee view; it's admin metadata only.

### J.7 Revoke permanence

Confirmed (v2 answer 7): permanent in v1. Re-upload is the recovery path. Manual misdelivery purge via `scripts/purge-payslip-misdelivery.js` is the escape hatch (see §C.10 / §I.10).

### J.8 Filename pattern

Resolved (v2 §I.7): Stage 1 uses per-row picker. No filename pattern. If HR later supplies a `payrollId` on `Employee`, we can layer filename parsing on top in v2 (admin-only context, audited).

### J.9 Email link target

The email body links to `https://acs-portal-spa.onrender.com/#/portal/payslips`. The portal hash path is `/portal/payslips` per §E.1. **Recommend: confirm with marketing** whether the link should be to `acschennai.com` (the public origin per [TENANCY.md](../../TENANCY.md)) or the SPA host directly.

### J.10 "Contact HR" destination

Empty-state and BLOB_GONE states show a "Contact HR" CTA. **Recommend: `mailto:` with a `PAYSLIP_HR_CONTACT_EMAIL` env var, default `hr@acschennai.com`.** Confirm the address with HR.

### J.11 Mail provider limits

v2 answer 5 implies email fan-out on publish. **Confirm Resend's daily / per-second sending limit** at go-live. Current free-tier is ~100 emails/day by Resend's published docs, but verify at deploy. If 50-employee bulk publish exceeds the burst limit, chunk by hour.

### J.12 R2 backup strategy

R2 files are not covered by the nightly DB backup. v1 default: rely on R2's 11-nines durability, document the gap. If HR / compliance asks for cross-region backup, options:
- (a) Enable R2 cross-region replication (paid tier, ~$0.02/GB-month).
- (b) Add a periodic `rclone sync` to a second Cloud account (custom code + storage).

**Recommend: document explicitly and re-evaluate at end of Stage 2 pilot.** Captured in §G.8.

### J.13 Audit retention

Default AppLog retention applies (per the R40 retention cron). Payslip-grade history lives on `Payslip` audit columns (per §G.6) — those rows outlive AppLog. Do payslip `AppLog` events warrant longer retention than other events? **Recommend: defer; current cron is sufficient for v1.**

### J.14 Step-up auth for first download per session

Security draft open question. **Recommend: defer; no signal of compromise today.**

### J.15 Device binding / corporate-IP restriction

Security draft open question. **Recommend: defer; mobile employees on field WiFi would break.**

### J.16 Reminder email if not viewed within 7 days

Security draft open question. **Recommend: defer; bell + email is enough in v1.**

---

## K. v2 changelog (what changed from v1)

| Area | v1 → v2 | Rationale |
|---|---|---|
| State machine | A (deletedAt only) → A′ (deletedAt + publishedAt) | Answer 5: upload ≠ publish |
| Audit columns on row | uploadedById only | → + publishedById, publishedAt, revokedById, revokedAt, revokedReason | AppLog retention is 30 days; payroll-grade history on the row |
| Notification trigger | per upload | → per publish | Answer 5: explicit publish gate |
| Email throttling | implicit | → `BULK_PUBLISH_EMAIL_DELAY_MS` env, default 100 ms | Mail provider limits |
| `originalFilenameHash` column | yes | → dropped | v2 review: guessable names, low value |
| `contentVersion` column | yes | → dropped | Soft-delete + audit columns cover replace |
| Cursor pagination on `My Payslips` | yes | → no, hard cap 50 | Answer 1: ≤50 rows for years |
| Bulk-upload filename pattern | yes (EMPID_mmyyyy.pdf) | → per-row picker | v2 review: payroll tools won't output internal ids |
| Magic-byte check timing | at upload-intent | → at confirm-upload | v2 review: file doesn't exist at intent time |
| R2 backup | declared gap | documented explicitly | v2 review: confirm or document |
| Misdelivery path | soft delete only | → + manual purge script | v2 review: storage hygiene |
| `joinedAt` on Employee | not addressed | → use `createdAt` proxy until HR supplies true date | v2 review: confirm or add |
| Partial unique migration pattern | raw SQL, no drift detection | → mirrors `no_overlap_leave` DR-031 pattern with `RAISE EXCEPTION` on drift | v2 review: avoid silent drift |
| Total endpoints | 7 | → 9 (+ publish bulk, publish single) | Publish gate |

---

## L. Implemented deviations from this plan

The plan was reviewed by an Application Security Engineer pass (REVIEW.md,
2026-10-03). The reviewer flagged 23 findings; the implementation
accepted the following as deliberate, documented deviations from the
plan (rather than bugs to fix). The remaining reviewer findings are
either drift the plan itself was wrong about, or are unrelated to
stage 1. Each accepted deviation is recorded with one line of
reasoning and a pointer to where the implementation lives.

| # | Deviation | One-line reason | Where |
|---|---|---|---|
| **H3** | Magic-byte check moved from `/confirm-upload` to bind step | Defense-in-depth timing was lost, but a non-PDF cannot occupy a payslip row (the bind returns 422 before the create); R2 garbage is swept by the durable sweep on the intent-orphan path | `backend/src/lib/payslip.js:318` |
| **H4** | Purge script does not write an `AppLog` row | The runbook §5 explicitly lists AppLog as out of scope for v1; the audit trail is the `Payslip` row's audit columns (`purgedById`/`purgedAt`/`purgedReason`) plus the `revoke` row that precedes it | `backend/scripts/purge-misdelivered-payslip.js:228-256` |
| **M10** | `revoke` is `POST` (not `PATCH`); `replace` endpoint does not exist | `replace` is approximated by "revoke + rebind via the same 3-step pipeline"; the frontend's `AdminPayslips.jsx:32-41` documents this workaround | `backend/src/routes/payslip.js:278` |
| **M11** | Bulk publish-by-month is gone; admin list cap raised to 200 | One-click "Publish October" UX replaced with a multi-select checkbox flow over the list; the cap raise covers a single-month roster in one fetch | `backend/src/routes/payslip.js:241-273` |
| **M12** | `GET /api/admin/payslips/email-status?year=&month=` not present | The per-recipient `emailStatus` is merged into the coverage roster's response; a separate endpoint adds no value over the existing surface | `backend/src/routes/payslip.js:486-544` |
| **M13** | Rate limiters don't match the plan's contract (`payslipWriteLimiter` 20/h vs `payslipAdminLimiter` 60/h; `payslipListLimiter` not present; no day cap on `payslipDownloadLimiter`) | AppSec pre-review decision: 60/h covers the publish + resend-stuck admin sequence for a 15-employee monthly window comfortably; the day cap on the download limiter is deferred to stage 2 | `backend/src/middleware/rateLimit.js:213-251` |
| **M15** | `PAYSLIP_MAX_BYTES = 2 MB` (lowered from plan's 5 MB) | AppSec pre-review decision: a PDF > 2 MB is implausible for one month's payslip, and one number for both upload and download prevents drift | `backend/src/lib/payslip.js:574` + `src/lib/constants.js:371` |
| **L16** | Out-of-scope additions: `POST /:id/resend-email` and `POST /resend-stuck` | Both endpoints are user-required (the "N emails pending or failed" indicator and the manual resend for stuck PENDINGs) — the `emailStatus` column the plan never specified was added to support them | `backend/src/routes/payslip.js:342-440` |
| **L17** | `lib/payslip.js` is named identically to `routes/payslip.js` | The two files coexist by convention in this codebase (e.g. `lib/attendance.js` + `routes/attendance.js`); renaming the routes file to `payslips.js` (plural) is a one-line follow-up | `backend/src/lib/payslip.js` + `backend/src/routes/payslip.js` |
| **L18** | `blobPath` validator hard-coded to `payslips/<employeeId>/<ulid>.pdf` (plan had `payslips/{year}/{month}/...`) | The partial-unique index `(employee_id, year, month) WHERE deleted_at IS NULL` still protects against duplicates; year/month in the path would be redundant | `backend/src/lib/payslip.js:299` |
| **L19** | `coverage` response shape diverges from plan (`{employees: [...]}` → `{year, month, totalEmployees, coveredCount, missingCount, coverage: [...]}` with `employeeId`/`employeeName`/`employeeEmail` keys) | The new shape embeds `payslip.emailStatus` so the admin UI's "N emails pending or failed" indicator is one fetch, not two | `backend/src/routes/payslip.js:507-533` |
| **L20** | `serializePayslipForWire` exposes `recipientName`/`recipientEmail` on every admin read | Reviewer flagged this for PII-minimization; the admin list needs the name for the row label and the email for the "N emails pending or failed" count. A follow-up round should strip these on the bulk list and keep them only on the single-row detail | `backend/src/lib/payslip.js:220-222` |
| **422** | Magic-byte mismatch on bind returns **422 NOT_PDF** (plan §D.1 said 415) | The bind validates the *server-side* state of the bytes (the body has already arrived in R2 — the only "wrong" thing is the magic bytes, not the request format). RFC 7231 reserves 415 for `Content-Type` mismatches; the bind is a 422 *Unprocessable Entity* because the request was well-formed but the content is unprocessable. Same code, different semantics from what the plan said | `backend/src/routes/payslip.js:211-212` |

---

## References (file:line, verified)

- [TENANCY.md](../../TENANCY.md) — single-tenant boundary.
- [.github/workflows/tenancy-doc.yml](../../.github/workflows/tenancy-doc.yml) — guardrail.
- [backend/src/lib/uploadRoutes.js](../../backend/src/lib/uploadRoutes.js) — `mountUploadRoutes` (DR-021), `MAX_PHOTO_SIZE=10MB`, `PENDING_TTL_MS=20min`, `SIZE_TOLERANCE_BYTES=0`, `allowedPathPrefixesPerContainer` (where `'payslips'` joins `'billing'`).
- [backend/src/lib/blobStorage.js](../../backend/src/lib/blobStorage.js) — `generateUploadSASUrl` (15-min PUT), `generateReadSASUrl` (1h GET, `R2_READ_URL_TTL_SECONDS`), `generateULID` (Crockford base32), `verifyBlobExists` (3-state), **`verifyBlobMagicBytes` (NEW v2)**, `ALLOWED_R2_BUCKETS`, `REQUIRED_R2_BUCKETS`, `CONTENT_TYPE_EXT` (includes `application/pdf → pdf`).
- [backend/src/lib/uploadIntentBinding.js](../../backend/src/lib/uploadIntentBinding.js) — `validatePhotoIntents`, `bindPhotoIntentsTx`, `assertPhotoIntentsBindable`, `PhotoBindingLostError → 409`.
- [backend/src/middleware/requestLogger.js](../../backend/src/middleware/requestLogger.js) — `AppLog` writes (HMAC `employeeHash`, full `originalUrl`, `requestId`, `latencyMs`, `status`).
- [backend/src/middleware/auth.js](../../backend/src/middleware/auth.js) — `requireAuth` (revoked_token check), `requireAdmin`, `requireFreshAdmin`.
- [backend/src/middleware/rateLimit.js](../../backend/src/middleware/rateLimit.js) — `sasLimiter` 60/min, `exportLimiter` 5/min, `leaveCreateLimiter` 10/h, `trainingWriteLimiter` 120/h.
- [backend/src/routes/internal-upload-sweep.js](../../backend/src/routes/internal-upload-sweep.js) — 3-pass durable sweep; iterates `UploadIntent` rows by `(container, blobPath)`, **no prefix-specific code needed for `payslips/`**.
- [backend/src/routes/drawings.js](../../backend/src/routes/drawings.js) — read-sas HEAD-verify + 410 BLOB_GONE + `canReplace` (template for `Payslip` 410).
- [backend/src/routes/attendance.js](../../backend/src/routes/attendance.js) — own-data-only pattern at `:95` (`where: { employeeId: req.employeeId, date: { gte, lt } }`).
- [backend/src/routes/leave.js](../../backend/src/routes/leave.js) — own-data-only `/my` at `:246` (`where = { employeeId: req.employeeId }`).
- [backend/src/routes/adminEmployees.js](../../backend/src/routes/adminEmployees.js) — admin directory returns `{id, name, email}` (basis for coverage roster).
- [backend/src/routes/notifications.js](../../backend/src/routes/notifications.js) — `/preferences` keyed by `employeeId: req.employeeId`.
- [backend/src/lib/notify.js](../../backend/src/lib/notify.js) — `CRITICAL_TYPES` (line 34), `shouldSkipSend` (line 86), `fanOutEmail` (line 130). Reuse for `sendPayslipEmail` direct-call bypass.
- [backend/prisma/schema.prisma](../../backend/prisma/schema.prisma) — `Employee` (no `joinedAt`/`hireDate`/`startDate`; only `createdAt` at line 47), `UploadIntent @@unique([employeeId, ulid])`, `ProjectAttachment` (`deletedAt`), `BillingCertification` (`parentCertificationId` + `supersededAt` — historical pattern; rejected for v1), `RequestDedupe` (DR-020), `AppLog`. **No `employee_code` field exists.**
- [backend/prisma/migrations/20260910000000_rls_lockdown_s1/migration.sql](../../backend/prisma/migrations/20260910000000_rls_lockdown_s1/migration.sql) — canonical RLS pattern (per-table `DO $$ BEGIN ... END $$`, idempotent, `DROP POLICY IF EXISTS` + `CREATE POLICY <table>_deny_anon TO anon USING(false) WITH CHECK(false)` + same for `authenticated`, **no** `FORCE ROW LEVEL SECURITY`).
- [backend/prisma/migrations/20260908150000_dr031_leave_constraint_correct_bound/migration.sql](../../backend/prisma/migrations/20260908150000_dr031_leave_constraint_correct_bound/migration.sql) — `no_overlap_leave` PL/pgSQL + drift-detection pattern (mirrored by the v2 partial-unique migration).
- [backend/src/index.js](../../backend/src/index.js) — Helmet + CSP, request-id, requestLogger, CORS allowlist, body-parser 1mb, route mount points.
- [src/App.jsx](../../src/App.jsx) — route table.
- [src/components/PortalLayout.jsx](../../src/components/PortalLayout.jsx) — sidebar groups, UserMenu, NotificationBell via `createPortal` (R21), `REPORT_ICON` slot.
- [src/pages/portal/MyProjectReports.jsx](../../src/pages/portal/MyProjectReports.jsx) — 5-type chip filter, project picker, 3-step upload state machine, status pill, empty state, mobile-friendly.
- [src/pages/portal/MyCertifications.jsx](../../src/pages/portal/MyCertifications.jsx) — employee own-only list template.
- [src/lib/api.js](../../src/lib/api.js) — global fetch wrapper, 401 → AuthContext.
- [src/lib/blobUpload.js](../../src/lib/blobUpload.js) — `uploadBlob` + `BlobUploadError` (3-step upload state). **(v2 also does pre-flight magic-byte sniff.)**
- [src/contexts/AuthContext.jsx](../../src/contexts/AuthContext.jsx) — `useAuth()` (user.id, isAdmin), `setRouter` ref (audit 2026-09-04).
- [src/contexts/ToastContext.jsx](../../src/contexts/ToastContext.jsx) — `push` with R17 dedupe by reason.

---

## Multi-agent design audit trail

This plan was produced by a 3-round multi-agent design process on 2026-10-02 (v1), with a v2 review and correction pass after the user reviewed v1. The 7 specialist agents were dispatched in parallel for Round 1 (independent drafts), 2 cross-review agents for Round 2 (security + UX/feasibility), and Round 3 synthesis produced v1. The v2 pass was triggered by the user's review of v1, which identified five required fixes (audit columns on the row, undefined filename key, misdelivery purge path, magic-byte timing, partial-unique migration pattern) and answered the eight open questions. No code, migrations, schema changes, or pushes were made — this plan is the only output.

**Roster:**
- Round 1: Backend Architect, Application Security Engineer, UI Designer, Frontend Developer, Database Optimizer, Test Automation Engineer, Product Manager.
- Round 2: Application Security Engineer (cross-review), UI Designer (cross-review).
- Round 3 (v1): orchestrator synthesis.
- v2 review (this pass): orchestrator + user, applying the v1 review.

**Verification posture (per project CLAUDE.md generator-verifier rule):** every `file:line` reference was verified against the actual file before this pass. Confirmed: `Employee` has no `joinedAt`/`hireDate`/`startDate`; `no_overlap_leave` exists at the DR-031 migration with the PL/pgSQL + drift-detection pattern; `mountUploadRoutes` uses `allowedPathPrefixesPerContainer` (the right hook for `'payslips'`); `internal-upload-sweep.js` iterates `UploadIntent` rows by `(container, blobPath)`, not by prefix. Section §H (Test Plan) is the verification gate for any future implementation: 45 tests across unit, integration, and e2e, with explicit coverage targets per the security-critical paths.