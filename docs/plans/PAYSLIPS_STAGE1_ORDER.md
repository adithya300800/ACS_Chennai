# Payslips Stage 1 — Implementation Order

**Source plan:** `docs/plans/PAYSLIPS_PLAN.md` v2 (2026-10-02)
**Stage:** Stage 1 only
**Branch:** `feat/payslips-stage1` (NEW, off `add-react-website`)
**Push / merge / deploy / production-migration:** **NOT** in scope. Stop and wait at the end of this order.

This file records (1) the agent-to-role map, (2) the commit sequence, (3) every file that gets created or modified, (4) the verification gates, (5) plan-vs-prompt drift, (6) what remains unverified at the end. Read this together with the plan.

**Checkpoints (per user instruction, 2026-10-02):**
- **CHECKPOINT 1** — after commit 2 (DB schema + migrations). Lead stops and shows the full migration SQL + the throwaway-DB verification output. Waits for OK.
- **CHECKPOINT 2** — after commit 5 (security review of backend). Lead stops and shows the authz matrix, the IDOR mutation check result, and the security findings. Waits for OK.
- After CHECKPOINT 2, lead proceeds through the final report and stops. **No merge, push, or deploy.**

---

## 0. Agent-to-role map

Available agents (verified from the live agent list at the time of this order):

| Plan role | Agent | Notes |
|---|---|---|
| Lead / integrator | **(me — orchestrator)** | Coordinates, dispatches, never edits implementation files |
| Database engineer | `Database Optimizer` | Owns `schema.prisma`, raw-SQL migration, RLS migration, `internal-upload-sweep.js` protect-list updates, `REQUIRED_BUCKETS` update |
| Backend engineer | `Backend Architect` | Owns `blobStorage.verifyBlobMagicBytes`, `notify.sendPayslipEmail`, all routes, rate limiters, purge script, env docs, runbook |
| Security engineer | `Application Security Engineer` | **VETO.** Adversarial review of every backend and frontend change. Writes the authz matrix. Independent reviewer for the final diff. |
| UI/UX designer | `UI Designer` | Wireframes + state copy + interaction polish (low-touch in this stage) |
| Frontend engineer | `Frontend Developer` | Owns `src/pages/portal/MyPayslips.jsx`, `src/pages/admin/AdminPayslips.jsx`, 4 new components, `api.js` wrappers, sidebar entries, route mounts |
| QA engineer | `Test Automation Engineer` | Owns 45 new tests per plan §H + mutation check + dummy PDF fixture |
| Independent reviewer | `Code Reviewer` | Fresh agent that did not write the code reviews the final diff vs the plan and this order; reports deviations only |

No role is unfilled. The "lead" is me; I do not edit implementation files, only this order and the report.

---

## 1. Repository recon (DONE in Phase 1 of plan mode)

Three Explore agents reported on: backend plan references, frontend plan references, and test/build/env. Key drift and risks already mapped in §6 below. The pre-existing branch is `add-react-website` at `ecb024a`, working tree clean. Throwaway Postgres is `docker run --rm -d -p 5432:5432 -e POSTGRES_PASSWORD=test postgres:16-alpine`.

---

## 2. Safety preflight (before any agent runs)

This step runs once, at the very top of every agent's instructions, regardless of what the agent does. The lead (me) verifies it before dispatching.

- **Print `DATABASE_URL` host.** Every shell command that touches a DB MUST prepend a `print_db_host.sh` guard that exits non-zero if the URL host is `tqmmspqvqtajbijbbsii.supabase.*` or `db.tqmmspqvqtajbijbbsii.supabase.co`. The only allowed hosts are `localhost`, `127.0.0.1`, and `postgres` (Docker container hostname). The guard script lives at the repo root and is referenced by every agent.
- **No push.** No git push, no `gh pr create`, no `gh workflow run`, no workflow dispatch. The branch is local-only.
- **No production touch.** No `prisma db push` against any non-local DB. No `R2` writes to the production `dpr-documents` bucket (only the local mock in tests).
- **No source-text pin tests.** All new tests assert behavior, not source text.
- **No salary figures anywhere.** Schema, emails, logs, error messages, test snapshots: zero.

---

## 3. Commit sequence (one commit per concern; small, clean messages)

### Commit 1 — Branch + safety guard
- `git checkout -b feat/payslips-stage1` off `add-react-website`.
- New file: `scripts/db-host-guard.sh` (the print-and-exit guard from §2).
- New file: `docs/runbooks/PAYSLIP_MISDELIVERY.md` — placeholder stub; full content in commit 7.
- No production-touching code.

### Commit 2 — Database (Prisma schema + raw-SQL partial unique + RLS) + sweep protect-list + bucket allowlist
**Agent:** `Database Optimizer`.

**Creates:**
- `backend/prisma/migrations/20261002010000_payslip_create_table/migration.sql` — `CREATE TABLE payslip (…)` mirroring the plan's §C.1 with the user-prompt amendments:
  - Audit columns: `uploadedById` (NOT NULL), `publishedById?`, `publishedAt?`, `revokedById?`, `revokedAt?`, `revokedReason?`, `purgedById?`, `purgedAt?`, `purgedReason?` (new per user prompt).
  - Confirm-time recording: `etag` (TEXT), `sizeBytes` (BIGINT) (new per user prompt — ETag/size re-check at publish).
  - FK relations: `uploadedBy` (Restrict), `publishedBy` (SetNull), `revokedBy` (SetNull), `purgedBy` (SetNull).
  - Indexes per plan §C.2: `(employee_id, year DESC, month DESC)`, `(year, month, deleted_at)`, `(uploaded_by_id)`, `(published_at)`, plus a UNIQUE on `upload_intent_ulid` and a UNIQUE on `(employee_id, year, month) WHERE deleted_at IS NULL` (the partial unique, in the next migration).
- `backend/prisma/migrations/20261002010001_payslip_partial_unique/migration.sql` — the drift-detection block, mirroring `20260908150000_dr031_leave_constraint_correct_bound`. Final sanity check `RAISE EXCEPTION`s on out-of-band drift. **Test: deliberately ALTER the index out-of-band before the next migration, expect raise.**
- `backend/prisma/migrations/20261002010002_payslip_rls/migration.sql` — RLS enabled, `payslip_deny_anon TO anon USING(false) WITH CHECK(false)`, same for `authenticated`. No `FORCE ROW LEVEL SECURITY`. Mirror `20260910000000_rls_lockdown_s1`.
- `backend/__tests__/fixtures/throwaway-db.sh` — the Docker run / drop / migrate-deploy script the QA agent reuses.

**Modifies:**
- `backend/prisma/schema.prisma` — adds `model Payslip { … }` matching the columns above, plus 6 back-relations on `Employee` (`payslips`, `payslipsUploaded`, `payslipsPublished`, `payslipsRevoked`, `payslipsPurged`, `payslipConfirmIntent` — the last one for the `uploadIntentUlid` link). Adds the same `ulid` to the `Employee` back-relation set.
- `backend/src/routes/internal-upload-sweep.js` — adds `payslip.ulid` to `collectReferencedUlids` and `payslip.blobPath` to `collectReferencedBlobPaths` (HIGH-IMPACT FINDING from the backend recon: without this, the 15-min cron will retire payslip bytes).
- `backend/src/lib/blobStorage.js` — appends `'payslips'` to `REQUIRED_BUCKETS` (so `/ready` probes it).
- `backend/src/lib/uploadRoutes.js` — appends `'payslips'` to `allowedPathPrefixesPerContainer['dpr-documents']` (the line 143 entry). Confirms the 15-min sweep still covers the new prefix.

**Verification:**
- `docker run --rm -d -p 5432:5432 -e POSTGRES_PASSWORD=test postgres:17-alpine` (per Q1).
- `DATABASE_URL=postgresql://postgres:test@localhost:5432/postgres?schema=payslip_test npx prisma migrate deploy` → all 3 new migrations apply cleanly.
- Re-run on a copy of the current schema (e.g. the test schema with all prior migrations applied) → also applies cleanly.
- Out-of-band `ALTER INDEX payslip_active_per_month_uidx RENAME TO something_else` → next migration raises (verified by a one-off script, NOT shipped as a test).
- `npx prisma generate` → no errors.

**Tests (per user prompt, 2026-10-02):**
- `backend/__tests__/payslip-sweep-safety.test.js` — **proves the internal-upload-sweep NEVER deletes a payslip blob.** The test:
  1. Mocks the sweep's `collectReferencedUlids` and `collectReferencedBlobPaths` to confirm `payslip.ulid` and `payslip.blobPath` are both included in the protect lists.
  2. Calls the sweep with a `Payslip` row whose `ulid` matches a would-be-orphan `UploadIntent`.
  3. Asserts the sweep does NOT mark the `UploadIntent` for retirement.
  4. Asserts the `Payslip.blobPath` is in the protect list.
  5. The test reads `backend/src/routes/internal-upload-sweep.js` to find the protect-list lines and asserts they contain `payslip`. This is a **behavior test** (not a source-text pin — it asserts the function-level contract, not the exact line text).
- `backend/__tests__/payslip-partial-unique-drift.test.js` — confirms the partial-unique migration's drift check would raise on an out-of-band `ALTER INDEX` (the test seeds a fake drift via a helper SQL block, then re-runs the migration, expects raise).

**CHECKPOINT 1 (per user instruction, 2026-10-02):**
After this commit, lead STOPS. Shows the user:
1. The full SQL of the 3 new migrations (cat'd output).
2. The throwaway-DB verification output (`prisma migrate deploy` log on empty DB + on a copy of the current schema).
3. The drift-check raise output.
4. The new sweep protect-list diff.
5. The result of `npm run lint:enums` and `npx prisma generate`.
6. The schema diff (`prisma migrate diff` between add-react-website head and the new branch).
Waits for user OK before dispatching commit 3.

### Commit 3 — Backend: `verifyBlobMagicBytes` + `sendPayslipEmail` + rate limiter
**Agent:** `Backend Architect`.

**Creates:**
- (none)

**Modifies:**
- `backend/src/lib/blobStorage.js` — adds `verifyBlobMagicBytes(container, blobPath, magic = Buffer.from('%PDF-'))`. Uses `GetObjectCommand` with `Range: bytes=0-3`. 3-state return `{ok: true, ok: false, ok: null}` (mirrors `verifyBlobExists`'s shape). 100% line/branch coverage required.
- `backend/src/lib/notify.js` — adds `sendPayslipEmail(prisma, context, { employee, payslip, period })` outside the `shouldSkipSend` gate. Throttled externally (caller controls `BULK_PUBLISH_EMAIL_DELAY_MS`). Body is the neutral template from plan §B.5. **No** add to `CRITICAL_TYPES` — direct-call bypass per the v2 design (B.5 + I.2).
- `backend/src/middleware/rateLimit.js` — adds `payslipWriteLimiter` (20/h per admin, key on `req.employeeId`), `payslipListLimiter` (30/min per employee, key on `req.employeeId`), `payslipDownloadLimiter` (10/min + 50/day per employee, key on `req.employeeId`).

**Tests (in commit 3, written by backend engineer):**
- `backend/__tests__/blobStorage-verify-magic-bytes.test.js` — 6 tests: PDF (happy), non-PDF, R2 unreadable, wrong-range response, missing bytes-0-3, custom magic param. 100% line/branch.
- `backend/__tests__/notify-send-payslip-email.test.js` — 4 tests: body redaction (no name, no id, no amount, no filename), bypass of `emailEnabled: false`, bypass of `typeMutes`, throttle helper signature.
- `backend/__tests__/rate-limit-payslip.test.js` — 3 tests: 21st publish returns 429, 11th list returns 429, 51st download returns 429 (the day-cap is harder — 50/day means a 51st request on the same day returns 429; covered with a `MockDate`-style helper or by directly calling the limiter factory).

### Commit 4 — Backend: 9 routes + `index.js` mount
**Agent:** `Backend Architect` (continues).

**Creates:**
- `backend/src/routes/payslips.js` — single file, two sub-routers:
  - **Employee sub-router** mounted at `/api/payslips`:
    - `GET /my` — own-only list, `publishedAt NOT NULL AND deletedAt IS NULL AND purgedAt IS NULL`, ORDER BY year DESC, month DESC, hard cap 50, no cursor.
    - `GET /my/:id/download` — proxy through origin. Verifies ownership, HEAD-verifies via `verifyBlobExists`, fetches via 15-min internal SAS, returns PDF with `Content-Disposition: attachment; filename="Payslip-{Month}-{Year}.pdf"` + `Content-Type: application/pdf` + `X-Frame-Options: DENY` + `Cache-Control: no-store`. 410 on BLOB_GONE, 404 on cross-employee (not 403, to avoid existence disclosure).
    - `GET /:id` — own-only or admin. 404 on cross-employee.
  - **Admin sub-router** mounted at `/api/admin/payslips`:
    - `POST /upload-intents` — admin-only, `requireFreshAdmin`, `Idempotency-Key` optional here (NOT required on intent mint — only on confirm). Returns `{ items: [{ulid, intentId, putUrl, expiresIn}], batchId }`. 15-min PUT URL via `mountUploadRoutes`'s `payslips` path-prefix entry.
    - `POST /confirm-uploads` — admin-only, **`Idempotency-Key` REQUIRED** (`payslip-confirm-{adminId}-{batchId}`). Calls `verifyBlobMagicBytes` for each item; on `{ok: false}` returns 415 `NOT_PDF` for the failing item without binding; on `{ok: null}` returns 503; on `{ok: true}` records `etag` + `sizeBytes` at confirm, calls `bindPhotoIntentsTx` with `expectedContainer='dpr-documents'`, `expectedBlobPath='payslips/{year}/{month}/{employeeId}/{ulid}.pdf'`. Returns `{ confirmed: [{payslipId, ulid}], failed: [{ulid, reason}] }`.
    - `POST /publish?year=&month=` — bulk publish. `requireFreshAdmin`. **Async fan-out per Q4:**
      1. Inside a transaction: `publishedAt IS NULL AND deletedAt IS NULL AND purgedAt IS NULL` → set `publishedAt` + `publishedById`. Re-publish is a no-op. **At publish, re-HEAD the blob and re-check `etag` + `sizeBytes` against the values recorded at confirm; refuse with `BLOB_DRIFTED` (409) if they differ.** Re-check is per-row; the first drift halts the publish and returns 409 with the offending `payslipId`.
      2. Commit. **Return 200 immediately** with `{published, skipped, fanOutStarted: true, fanOutId}`. The HTTP request is NOT held open.
      3. **After commit**, kick off `fanOutPayslipEmails(prisma, year, month, fanOutId, adminId)` via `setImmediate` (or a fire-and-forget promise that is not awaited). The function loops through the just-published rows and:
         - Sends the email via `sendPayslipEmail` with `BULK_PUBLISH_EMAIL_DELAY_MS` (default 600 ms) between sends.
         - Records per-recipient success/failure in `EmailLog` (the existing model, not `AppLog`). `entityType: 'payslip'`, `entityId: payslipId`.
         - Does NOT roll back the publish on email failure (the transaction is committed).
         - Catches all exceptions in the loop; logs to `AppLog` with `event: 'payslip.publish.fanout.error'`.
         - Writes a final `AppLog` row `event: 'payslip.publish.fanout.complete'` with `{fanOutId, year, month, sent, failed, durationMs}`.
    - `POST /:id/publish` — single-row publish, same publish-time ETag/size check, same async fan-out pattern. Idempotent.
    - `GET /email-status?year=&month=` — admin reads per-recipient email status from `EmailLog`. Returns `{rows: [{payslipId, employeeId, emailStatus, sentAt, errorMessage?}], summary: {sent, failed, pending}}`. Used by the admin to see which emails succeeded and which need manual follow-up.
    - `GET /?year=&month=` — admin list, may paginate (cursor not required for v1, hard cap 200). Includes `purged` rows (admin can see tombstones).
    - `GET /coverage?year=&month=` — admin coverage roster. Filters employees to `createdAt <= first day of {year}-{month}` (the v1 proxy per plan §C.7 / §J.4). Returns `{ employees: [{id, name, email, status, payslipId?, publishedAt?, uploadedAt?, purgedAt?}] }`.
    - `PATCH /:id/revoke` — admin. Soft-delete: `deletedAt = NOW()`, `revokedById = admin`, `revokedAt = NOW()`, optional `revokedReason` from body. Refuses already-purged or already-deleted rows (idempotent / 409).
    - `POST /:id/replace` — admin. Soft-deletes the existing row (revoke, not purge), creates a new draft row. Returns new intent ULID + PUT URL.

- `backend/__tests__/payslip-fixtures.js` — exports `payslipFactory`, `payslipCoverageTestHelper`, `mockVerifyBlobMagicBytes` (3-state), `dummyPdfBuffer` (the `%PDF-1.4\n…\n%%EOF\n` 1-line buffer). Single source of test data.
- `backend/__tests__/payslips-routes.test.js` — 18 integration tests per plan §H.3, organized by endpoint.
- `backend/__tests__/payslips-authz-matrix.test.js` — the security engineer's authorization matrix (separate file so the security engineer owns it; see Commit 5).

**Modifies:**
- `backend/src/index.js` — mounts `/api/payslips` (next to `/api/training` at line 420) and `/api/admin/payslips` (next to `/api/admin/reports` at line 457). CORS methods list unchanged (PATCH already in `GET, POST, PUT, PATCH, DELETE, OPTIONS`).
- `backend/.env.example` — adds `PAYSLIP_LINK_BASE_URL` (default `https://acs-portal-spa.onrender.com`), `BULK_PUBLISH_EMAIL_DELAY_MS` (default `100`).
- `render.yaml` — adds the two env vars to the `ACS_Chennai` service only, both `sync: false`. **No** value keys (env vars without values are placeholders; the operator sets them in the Render dashboard).
- `backend/src/lib/uploadIntentBinding.js` — **no code change**. The existing `bindPhotoIntentsTx` is container-agnostic; the route passes `expectedContainer='dpr-documents'` + `expectedBlobPath='payslips/{year}/{month}/{employeeId}/{ulid}.pdf'`. The plan-referenced `kind: 'payslip'` is a mental-model mismatch (backend recon §6 item C); the route code documents this.

**Coverage floors (enforced in this commit's tests):**
- New route file: 85% line, 80% branch.
- Unique-constraint (P2002 → silent retry → success) path: 100% line, 100% branch.
- Download proxy (cross-employee 404, BLOB_GONE 410, revoked 401, magic-byte 415, rate limit 429): 100% line, 100% branch.

### Commit 5 — Security review (VETO gate)
**Agent:** `Application Security Engineer`. Reads commits 2, 3, 4 as a diff. Writes its own additions to:

- `backend/__tests__/payslips-authz-matrix.test.js` — the full authorization matrix from plan §G.2 (10 rows × 2 cases × 10 repeats for IDOR = 200 supertest invocations). **Required**: a mutation check (per user prompt) — temporarily `git stash` the ownership filter, run the IDOR test, assert it fails, restore. Records the green → red → green cycle as a single test in the file with a comment block documenting the mutation.
- `backend/__tests__/payslips-idor.mutation.test.js` — the standalone mutation check (the "deliberately break" test). Catches accidental weakening of the ownership filter.

**VETO check:**
- Any IDOR (employee A reads B's data) → BLOCK.
- Any privilege escalation (employee writes admin route) → BLOCK.
- Any SAS URL leakage in logs → BLOCK.
- Any salary figure in any log / email / error → BLOCK.
- Any magic-byte bypass (non-PDF accepted) → BLOCK.
- Any ETag/size drift accepted at publish → BLOCK.
- Any revoked / draft / purged row returned to an employee → BLOCK.
- Any R2 backup write to production bucket from a test → BLOCK.

**If VETO fires:** the backend engineer fixes and the security engineer re-reviews. Loop continues until VETO clears.

**CHECKPOINT 2 (per user instruction, 2026-10-02):**
After this commit, lead STOPS. Shows the user:
1. The full authz matrix (table: actor × endpoint × expected status × asserted status × 10-repeat pass/fail).
2. The IDOR mutation check result (green → red → green cycle output).
3. All VETO findings raised and their resolution.
4. The async-fan-out test output (proves the publish endpoint does not hold the HTTP request open while sending emails).
5. The EmailLog redaction test (proves no name, no id, no amount, no filename in the sent email body).
6. The `lib/log` redaction test (proves no PII in `AppLog` rows for payslip routes).
7. The dummy-PDF test (proves the magic-byte check accepts valid PDF, rejects non-PDF).
Waits for user OK before dispatching commit 6 (frontend).

### Commit 6 — Frontend
**Agent:** `Frontend Developer` (with `UI Designer` review on wireframes before code).

**Creates:**
- `src/pages/portal/MyPayslips.jsx` — employee list, ~150 lines. Reuses `Breadcrumb`, inline empty state, `StatusBadge` for the "Downloaded" / "Available" pill (or local pill — the `StatusBadge` DEFAULT_STATUS_MAP doesn't fit). Newest first, 50-row cap, no cursor, no year filter.
- `src/pages/admin/AdminPayslips.jsx` — admin unified page, ~300 lines. Two view modes (Drafts / Published) selected by `coverage.counts.draft > 0 && coverage.counts.published === 0`. Drag-and-drop dropzone, per-row `EmployeePicker`, per-row Replace / Revoke / Publish buttons, top-of-page **Publish {Month}** button.
- `src/components/PayslipRow.jsx` — presentational row for employee list.
- `src/components/CoverageRow.jsx` — presentational row for admin coverage.
- `src/components/BulkDropzone.jsx` — `input[type=file][accept=application/pdf][multiple]` with HTML5 drag events. Renders queued files as `{file, assignedEmployeeId}` rows.
- `src/components/EmployeePicker.jsx` — autocomplete bound to `GET /api/admin/employees`. ~40 lines.
- `src/lib/constants.js` (or extend existing) — `PAYSLIP_ICON = (svg…)`, `MAX_PAYSLIP_BYTES = 5 * 1024 * 1024`, `ACCEPTED_PAYSLIP_TYPES = ['application/pdf']`.
- `src/__tests__/payslip-my-list.test.jsx` — e2e-journey 1 (employee download), e2e-journey 3 (cross-employee attempt).
- `src/__tests__/payslip-admin-upload.test.jsx` — e2e-journey 2 (admin monthly ritual), e2e-journey 4 (replace creates draft + publish), e2e-journey 7 (draft not visible).
- `src/__tests__/payslip-privacy.test.jsx` — e2e-journey 5 (BLOB_GONE → "Contact HR"), e2e-journey 6 (employee cannot see admin page).
- `src/__tests__/payslip-svg-icon.test.jsx` — one-liner that `PAYSLIP_ICON` renders without throwing + uses the same viewBox as the other 10 sidebar icons.

**Modifies:**
- `src/lib/api.js` — adds 10 methods per plan §E.5, following the existing convention (token is last positional arg, idempotencyKey is 4th positional arg on `post/put/patch/delete`):
  - `api.listMyPayslips(token)`, `api.getMyPayslipDownloadUrl(payslipId, token)`,
  - `api.listPayslipsForMonth({year, month}, token)`, `api.getPayslipCoverage({year, month}, token)`,
  - `api.createPayslipUploadIntents(items, token)`, `api.confirmPayslipUploads(items, batchId, token, idempotencyKey)`,
  - `api.createPayslipReplaceIntent(payslipId, payload, token, idempotencyKey)`, `api.confirmPayslipReplace(payslipId, ulid, token, idempotencyKey)`,
  - `api.revokePayslip(payslipId, reason, token)`, `api.publishPayslipsForMonth({year, month}, token)`, `api.publishPayslip(payslipId, token)`.
- `src/lib/blobUpload.js` — adds pre-flight magic-byte sniff (`%PDF-`) on the browser's `File` object before the network call. Throws `BlobUploadError({code: 'NOT_PDF'})` on mismatch.
- `src/components/PortalLayout.jsx` — adds `PAYSLIP_ICON` constant (inline SVG, 18×18 / 24-viewBox, matching the existing 10 icons). Adds two sidebar entries:
  - **Employee** "My Payslips" in the `My Reports` group (line 288-330), after `/portal/certifications`. NOTE: the plan's reference to "Records" was wrong; the employee group is `My Reports`.
  - **Admin** "Payslips" in the `Records` group (line 346-382), after `Billing Certifications`. NOTE: the plan's reference to "Admin" was wrong; the admin group is `Records`.
- `src/App.jsx` — adds two routes inside the existing protected `/portal/*` tree:
  - `<Route path="payslips" element={<ProtectedRoute><MyPayslips /></ProtectedRoute>} />`
  - `<Route path="admin/payslips" element={<ProtectedRoute requireAdmin><AdminPayslips /></ProtectedRoute>} />` (mirroring the existing `admin/billing-certifications` pattern at lines 245-252).

**Frontend coverage:**
- New pages and components: 85% line, 80% branch (matching the plan's coverage floor).
- E2E journeys 1-7 (per plan §H.4): all pass.

### Commit 7 — Security review of frontend + final integration
**Agent:** `Application Security Engineer`.

- Re-reads the full diff. Specifically looks for:
  - SAS URLs in any log call.
  - Original filenames in any log call.
  - Salary figures in any log call.
  - Cross-employee data flowing through the React tree (any chance a parent's `payslips` prop leaks into another employee's row).
  - `api.listMyPayslips` token argument: confirm `token` is the LAST positional arg (the convention; an early `token` arg would be a critical bug).
  - The magic-byte pre-flight is a defense-in-depth only; server is authoritative.
  - `Idempotency-Key` auto-generated client-side for confirm-uploads (per DR-012).
  - Sidebar entries use the right group names.

### Commit 8 — Documentation: runbook + readme delta
**Agent:** `Backend Architect`.

**Replaces placeholder** at `docs/runbooks/PAYSLIP_MISDELIVERY.md`:
- "What this is" — payslip misdelivery: admin uploaded the wrong file, or noticed the wrong employee got a published payslip.
- "Triage" — confirm with HR by phone (the published wrong file has been seen by the wrong employee; this is a privacy incident, not a "just click Revoke" incident).
- "Step 1: Revoke" — `PATCH /api/admin/payslips/:id/revoke` with a reason. Marks the row soft-deleted.
- "Step 2: Purge" — `node backend/scripts/purge-payslip-misdelivery.js --payslipId=… --admin=… --reason=…`. The script is `--dry-run` by default; pass `--apply` to actually run. The script refuses non-revoked rows, deletes the R2 blob, stamps `purgedAt/purgedById/purgedReason` on the tombstone, writes an AppLog row. Idempotent.
- "What the script does NOT do" — does NOT email the wrong recipient (we don't know who saw what); does NOT change the recipient's bell row (out of v1 scope).
- "What the admin must do after" — call the wrong recipient (Priya's job, not the script's).

**Creates:**
- `backend/scripts/purge-payslip-misdelivery.js` — per the prompt: `--dry-run` default, requires `--admin` + `--reason`, refuses non-revoked rows, deletes R2 blob, **keeps** tombstone (stamps `purgedAt/purgedById/purgedReason`), writes AppLog audit. Idempotent.
- `backend/scripts/__tests__/purge-payslip-misdelivery.test.js` — 6 tests: dry-run does nothing; refused-when-not-revoked; refused-when-already-purged; refused-without-admin-or-reason; happy-path soft-stamps + deletes blob + writes AppLog; idempotent re-run.

### Commit 9 — Independent review
**Agent:** `Code Reviewer` (fresh, did not write the code).

- Reads the full diff against `add-react-website`.
- Reads the plan + this order + the user's prompt.
- Reports deviations only (positive findings go to the lead, not the report).
- Specifically checks:
  - Every file in the §3 inventory exists.
  - Every modification actually applied.
  - The RLS migration has the deny-anon + deny-authenticated policies.
  - The partial-unique drift check `RAISE EXCEPTION`s on bad drift.
  - The sweep protect lists include `payslip.ulid` + `payslip.blobPath`.
  - The verify-magic-bytes helper has the 3-state return.
  - The email body has no name, no id, no filename, no amount, no attachment, no direct link.
  - The download proxy has `Cache-Control: no-store`.
  - The purge script has `--dry-run` default + refuses non-revoked rows.
  - The mutation test exists and is itself a passing test.

### Commit 10 — Fix findings
- Lead + the responsible agent fix the independent review's findings.
- Re-run the full test suite after each fix.
- Update this order file with the resolution of each finding.

### Commit 11 — Final report
- Lead writes `docs/plans/PAYSLIPS_STAGE1_REPORT.md` (per user's "Deliverables" → "Report" requirement). Stops and waits.

---

## 4. Verification gates (run at the end, in this order)

1. **Backend test suite.** `cd backend && npm test`. Must pass with **no skipped, no `.only`**. The `pretest` `no-skipped-tests.js` guard enforces this. Expected count: 89 existing + 32 new (commit 3: 13, commit 4: 18, commit 8: 6) - overlap = **~120 backend test files**, ~3,000+ assertions.
2. **Frontend test suite.** `npm test` from repo root. Must pass. Expected count: 89 existing in `src/__tests__/` + 4 new = **~93 src/__tests__/ files** + 12 unchanged in `frontend/__tests__/`.
3. **Coverage floors.** `cd backend && npx jest --coverage --collectCoverageFrom='src/routes/payslips.js' --collectCoverageFrom='src/lib/blobStorage.js' --collectCoverageFrom='src/lib/notify.js' --collectCoverageFrom='src/middleware/rateLimit.js'`. Floors enforced per plan §H.8.
4. **Build.** `npm run build` from repo root. Must succeed.
5. **Backend boot against throwaway DB.** `DATABASE_URL=postgresql://postgres:test@localhost:5432/postgres node backend/src/index.js` → must boot without error and respond 200 on `/ready` (verifies the new `payslips` R2 bucket probe would work — mocked in this run).
6. **Migration verification (throwaway DB).**
   - `docker run --rm -d -p 5432:5432 -e POSTGRES_PASSWORD=test postgres:16-alpine`
   - `DATABASE_URL=… npx prisma migrate deploy` → 3 new migrations apply.
   - Out-of-band `ALTER INDEX` → re-run `prisma migrate deploy` → expect raise.
   - `docker stop` + `docker rm`.
7. **YAML / lint checks.** `npm run lint:enums` from repo root (the only lint script in the repo). `node scripts/checkEnumDrift.js` reads `schema.prisma`; will pass since the new model uses Prisma-native enums (none).
8. **Mutation check.** `cd backend && npx jest payslips-idor.mutation --runInBand`. The test temporarily breaks the ownership filter, asserts the IDOR test fails, restores, asserts it passes. This is the "I didn't accidentally weaken the auth" gate.
9. **Independent review report.** Lead reads the report, applies findings, re-runs gates 1-4.

Any failure → fix and re-run. Any unverifiable item → listed in §8 of the report.

---

## 5. Plan ↔ prompt ↔ code drift (every place the order deviates from the plan)

| Source | Plan says | Code says | Order does |
|---|---|---|---|
| Recon | `allowedPathPrefixesPerContainer` at line 139 | line 143 | line 143 |
| Recon | `REQUIRED_R2_BUCKETS` | `REQUIRED_BUCKETS` | `REQUIRED_BUCKETS` |
| Recon | `kind: 'payslip'` on bind | container-agnostic; pass `expectedContainer='dpr-documents'` | documented; no `kind` arg |
| Recon | Routes `/admin/payslips` | convention is `/portal/admin/payslips` wrapped in `ProtectedRoute requireAdmin` | `/portal/admin/payslips` |
| Recon | Sidebar "Records" for employee | employee group is "My Reports" | "My Reports" |
| Recon | Sidebar "Admin" for admin | admin group is "Records" | "Records" |
| Recon | `lucide-react` `Receipt` icon | no `lucide-react` dep; inline SVG only | inline SVG `PAYSLIP_ICON` constant |
| Recon | `EmptyState` shared component | not a shared component | inline JSX (matches existing pattern) |
| Recon | 3-step upload state | 4-step `idle → sas → uploading → confirming → idle` | 4-step |
| Recon | Toast dedupe window 500ms | 50ms (keyed on `${type}:${message}`) | 50ms, type+message key |
| Recon | Backend `verifyBlobMagicBytes` exists | does not exist | new helper in commit 3 |
| Recon | `internal-upload-sweep` auto-protects | hard-coded `collectReferencedUlids` + `collectReferencedBlobPaths` | updated to include `payslip.ulid` + `payslip.blobPath` |
| Recon | `CRITICAL_TYPES.PAYSLIP_PUBLISHED` | does not exist; v2 plan uses direct `sendPayslipEmail()` bypass | new helper outside `shouldSkipSend` (no `CRITICAL_TYPES` add) |
| Recon | `payslipWriteLimiter` exists | does not exist | new limiter in commit 3 |
| Prompt | `purgedById/purgedAt/purgedReason` columns | not in v2 plan | added in commit 2 (additive) |
| Prompt | `etag` + `sizeBytes` recorded at confirm + re-checked at publish | not in v2 plan | added in commit 2 (additive) + re-check in commit 4 |
| Prompt | Purge script keeps tombstone (does NOT hard-delete row) | v2 plan said hard-delete the row | amended: keep tombstone; refuse non-revoked |
| Prompt | Purge script `--dry-run` default + requires `--admin` + `--reason` | v2 plan had `--admin` + `--reason` but no `--dry-run` | added `--dry-run` default + `--apply` to opt in |
| Prompt | Email link base from `PAYSLIP_LINK_BASE_URL` env, defaulting to Render SPA host | v2 plan said "acs-portal-spa.onrender.com" hard-coded | env var with default |
| Prompt | Mutation check: deliberately break the ownership check, confirm IDOR fails, revert | not in v2 plan | added as a test in commit 5 |
| Prompt | No salary figures, filenames, SAS URLs, or tokens in any log/error/email/test | v2 plan §G.3 covered this | re-asserted; QA test suite includes log-redaction tests |

---

## 6. What's deferred (explicitly out of v1)

Per the plan §A.2 and the prompt's "Explicitly OUT of scope" list, and the prompt's amendment on the purge script: filename-pattern matching, `payrollId` column, ZIP/combined-PDF splitting, cursor pagination, year filter, NEW pill, sidebar badge, replace modal, magic links, retention/delete cron, bulk export, `contentHash`, admin-audit table, any new scheduled workflow, hard-delete of the row in the purge script.

---

## 7. Open questions — ANSWERED 2026-10-02 (lead incorporated into the order)

1. **Postgres version for the throwaway DB** → **`postgres:17-alpine`** (matches production Supabase).
2. **`Payslip.etag`** → **`@db.Text`**.
3. **`Payslip.sizeBytes`** → **`BigInt @db.BigInt`**, matching `UploadIntent.contentLength`. **In every JSON response that includes the column, convert to `Number(contentLength)` (BigInt does not serialize) and add a test that asserts the JSON shape is a number, not a stringified BigInt.**
4. **`BULK_PUBLISH_EMAIL_DELAY_MS`** → **default 600 ms**, env-configurable. **Publish endpoint MUST NOT hold the HTTP request open while sending emails.** The endpoint:
   - Inside the transaction: flip draft → published, return success.
   - **Return 200 immediately** with `{published, skipped, fanOutStarted: true}`.
   - After commit, **kick off the email fan-out asynchronously** (`setImmediate` or fire-and-forget promise) that sends per-recipient emails sequentially with the throttle delay.
   - Per-recipient success/failure recorded in **`EmailLog`** (the existing table at `backend/prisma/schema.prisma`, not in `AppLog`).
   - The admin can see per-recipient failures via `GET /api/admin/payslips/email-status?year=&month=` (new endpoint in commit 4) which returns `{rows: [{employeeId, payslipId, emailStatus, sentAt, errorMessage?}]}` from `EmailLog`.
   - A failed email **must not** undo the publish (transaction is already committed by the time the fan-out runs).
   - Reported in §6 of the final report: lead notes that 600 ms is an assumption; lead must check the provider's actual burst limit and report the source. If the provider allows a higher rate, the env can be lowered.
5. **`PAYSLIP_LINK_BASE_URL`** → env-configurable, **default `https://acs-portal-spa.onrender.com`**.
6. **Admin list cap** → **hard cap 200, no cursor in v1**.
7. **`Payslip.id`** → follow the majority convention: **`id String @id @default(uuid()) @db.Uuid`** (matching `Employee.id`), **with a separate `ulid String @unique` column** (matching `UploadIntent.ulid`, used as the R2 path component). This deviates from the v2 plan's "id is the ULID" design — the plan was wrong; the convention is `uuid` for PKs and `ulid` for R2 path components.
8. **Publish-time drift check** → **ETag + ContentLength only** (no `Last-Modified`).
9. **Tombstone visibility for admin** → **admin CAN see purged rows** in the admin list, with `purgedAt?` + `purgedReason?` + `purgedById?` populated. **Employee never sees them** (filter `purgedAt IS NULL` on the employee list). **Tombstones are never downloadable** — the `GET /api/payslips/my/:id/download` route rejects any row with `purgedAt IS NOT NULL` with 410 + `code: 'PURGED'`.
10. **Runbook's "HR phones the wrong recipient"** → **phone or in-person, NOT email.** The script does not try to email the wrong recipient. The incident is recorded in the `AppLog` row written by the purge script and noted in the runbook.

---

## 8. What remains unverified at the end (to be filled in the report)

This is a checklist the report will fill in. Pre-filled placeholders:

- Local Postgres boots and migrations apply (verified by gate 6).
- Frontend build succeeds (verified by gate 4).
- Backend boots against throwaway DB (verified by gate 5).
- Backend test suite passes (verified by gate 1; exact count TBD).
- Frontend test suite passes (verified by gate 2; exact count TBD).
- Mutation check passes (verified by gate 8).
- Independent review completed (verified by gate 9).
- Coverage floors met (verified by gate 3; exact percentages TBD).
- ETag/size drift at publish raises (verified by hand-rolled test in commit 4).
- Out-of-band index alteration raises (verified by hand-rolled script in commit 2).
- Magic-byte mismatch returns 415 (verified by integration test in commit 4).

NOT verified (in this order):
- Real Resend email delivery. The tests use a fake queue; production email is tested in the manual pre-release checklist.
- Real R2 upload/download against the live `dpr-documents` bucket. The tests use a mocked S3 client; real R2 is tested in the manual pre-release checklist.
- Mobile Safari / iOS PDF download UX. The plan §B.6 calls out mobile-first; manual checklist covers this.
- Performance at 50 employees × 60 rows. The plan §C.2 says sub-millisecond; the test suite doesn't measure this.
- Multi-admin race at publish. The plan §G.1 PAY-14 covers this in design; the integration test for re-publish covers the assertion, not the timing.

---

## 9. Manual pre-release checklist (to be run by the user, not the agents)

In the order the report will hand it over:

1. Provision a real R2 path prefix `payslips/` against the live `dpr-documents` bucket (operator-only; out of agent scope).
2. Apply migration on a Supabase branch database (NOT production): create branch, `prisma migrate deploy`, verify RLS enabled.
3. Set `PAYSLIP_LINK_BASE_URL` to the SPA host. Verify env var is `sync: false` in `render.yaml`.
4. Set `BULK_PUBLISH_EMAIL_DELAY_MS=100` in the backend env.
5. Log in as Priya (HR). Upload 5 dummy PDFs for 5 employees for one month. Click **Publish {Month}**. Verify:
   - 5 employees receive the bell on next page load.
   - 5 emails land in the test mailbox.
   - Email body has no name, no id, no amount, no filename, only "October 2026".
   - Email link resolves to the SPA host.
6. Log in as Aarav (employee). Verify:
   - "My Payslips" shows October 2026 only.
   - Tap Download → file is `Payslip-October-2026.pdf`, opens in Preview.
   - Bell counter decrements.
7. Re-upload a PDF for Aarav, this time for September (which is empty). Verify:
   - Coverage shows Aarav with "Missing" for September, "Published" for October.
   - Re-upload creates a draft. Click Publish on Aarav's row. Verify email + bell.
8. Revoke Aarav's October payslip with reason "test revoke". Verify:
   - Aarav's "My Payslips" no longer shows October.
   - The admin list shows the row with a Revoked state.
9. Run the purge script: `node backend/scripts/purge-payslip-misdelivery.js --payslipId=<ulid> --admin=admin@acschennai.com --reason="manual test"`. Verify:
   - Dry-run says "would delete" and exits 0.
   - With `--apply`: blob gone (HEAD returns 404), tombstone row has `purgedAt/purgedById/purgedReason` populated, AppLog has a `payslip.purged` row.
   - Aarav's "My Payslips" still does NOT show the row.
10. Run the mutation check live: temporarily `git stash` the `where: { employeeId: req.employeeId }` filter, run the test, watch it fail, restore.
11. `npm run build` from a clean checkout, with the new env vars set, against the live API. Open the SPA in mobile Safari and Chrome DevTools mobile emulation. Verify:
    - 44 px touch targets.
    - Tab order is correct.
    - Reduced motion preference respected.
12. Confirm `render.yaml` has the new env vars documented (operator-visible, not secret).
13. Confirm the runbook `docs/runbooks/PAYSLIP_MISDELIVERY.md` is linked from the team wiki / onboarding doc.

---

## 10. Total file count (rough)

| Category | New | Modified |
|---|---|---|
| Backend migrations | 3 | 0 |
| Backend lib | 0 | 3 (`blobStorage.js`, `notify.js`, `rateLimit.js`) |
| Backend routes | 1 (`payslips.js`) | 1 (`index.js`) |
| Backend scripts | 1 (`purge-payslip-misdelivery.js`) | 0 |
| Backend tests | ~8 files, ~32 tests | 0 |
| Backend fixtures | 1 (`payslip-fixtures.js`) | 0 |
| Backend env | 0 | 2 (`.env.example`, `render.yaml`) |
| Backend sweep | 0 | 1 (`internal-upload-sweep.js`) |
| Backend schema | 0 | 1 (`schema.prisma`) |
| Frontend pages | 2 | 0 |
| Frontend components | 4 + 1 (icon constant) | 1 (`PortalLayout.jsx`) |
| Frontend lib | 0 | 2 (`api.js`, `blobUpload.js`) |
| Frontend routes | 0 | 1 (`App.jsx`) |
| Frontend tests | 4 | 0 |
| Frontend env | 0 | 0 |
| Docs | 1 runbook | 0 |
| Repo scripts | 1 (db-host-guard) | 0 |
| **Total** | **~26 new** | **~12 modified** |

End of order. Lead will STOP after writing this and wait for the user's review.
