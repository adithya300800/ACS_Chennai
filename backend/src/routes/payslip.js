// [Payslips Stage 1 / commit 3] Payslip HTTP surface.
//
// Three sub-routers, mounted in src/index.js under three different prefixes
// so the admin/upload/employee boundaries are explicit at the URL layer:
//
//   /api/admin/payslips/upload   →  mountUploadRoutes (admin only).
//     Mints `payslips/<employeeId>/<ulid>.pdf` SAS URLs and confirms
//     uploads. Owner of the `payslips/` path-prefix allowlist (per
//     __tests__/payslip-upload-intent-prefix.test.js). requireFreshAdmin —
//     a demoted admin's next mutating request stops here.
//
//   /api/admin/payslips          →  requireFreshAdmin mutation surface.
//     Bind / Publish / Revoke / Resend / Coverage. Mutates the payslip
//     table directly. The DR-018 durable row is the source of truth —
//     no in-process Map.
//
//   /api/portal/payslips         →  employee-facing read surface.
//     MyPayslips list + Download streamer. requireAuth; the server
//     streams the PDF through itself (NO storage URL to the browser —
//     the user explicitly required it). IDOR-guarded by row ownership.
//
// Privacy invariants (cross-cutting, mirrors plan §C.4):
//   * No salary figures anywhere — not in JSON, not in logs, not in
//     email bodies, not in test snapshots.
//   * No recipient emails in logs. hashIdentifier for any id.
//
// Threat model (cross-cutting):
//   * IDOR: every employee-facing endpoint reads `WHERE employeeId =
//     req.employeeId AND deletedAt IS NULL`. A future bug that drops
//     the predicate is caught by __tests__/payslip-routes.test.js.
//   * Authz escalation: admin-only mutations are requireFreshAdmin.
//     Stale-claim demotion (round-20) applies.
//   * Email-stamp drift: stampEmailStatus uses the row's primary key,
//     not the request body, so a forged body cannot retarget the stamp.

'use strict';

const express = require('express');
const crypto = require('crypto');
const { requireAuth, requireFreshAdmin } = require('../middleware/auth');
const { mountUploadRoutes } = require('../lib/uploadRoutes');
const { getClient: getS3Client } = require('../lib/blobStorage');
const { mapPrismaError } = require('../lib/errors');
const { hashIdentifier } = require('../lib/pii');
const {
  serializePayslipForWire,
  bindPayslipToIntent,
  publishPayslip,
  revokePayslip,
  sendPayslipEmail,
  resendStuckPendingPayslips,
  EMAIL_STATUS,
  PAYSLIP_BLOB_PREFIX,
  PAYSLIP_MAX_BYTES,
} = require('../lib/payslip');
const {
  payslipUploadLimiter,
  payslipAdminLimiter,
  payslipDownloadLimiter,
} = require('../middleware/rateLimit');

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function getPrisma(req) { return req.app.get('prisma'); }

// Crockford base32 ULID — same shape the upload routes enforce.
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Validate integer year/month on the bind body. Mirrors the DB CHECK
// constraints (`year BETWEEN 2000 AND 2100`, `month BETWEEN 1 AND 12`)
// so a future typo fails loud at the route layer, not at Prisma.
function validateYearMonth(year, month) {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return 'year must be an integer in 2000..2100';
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return 'month must be an integer in 1..12';
  }
  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// Admin upload sub-router — /api/admin/payslips/upload
// ════════════════════════════════════════════════════════════════════════════
//
// Mounts the shared `mountUploadRoutes` so /sas-url + /confirm-upload follow
// the same contract every other upload in the app uses. The only contract
// difference: `allowedPathPrefixesPerContainer: { 'dpr-documents': ['payslips'] }`
// — the prefix split is the security boundary.
//
// requireFreshAdmin is wired BEFORE the mount so every uploaded blob is
// minted by a live-admin session. The mount itself does not check
// authz — that's the wrapper's job.

const adminUploadRouter = express.Router();
adminUploadRouter.use(requireAuth);
adminUploadRouter.use(requireFreshAdmin);
adminUploadRouter.use(payslipUploadLimiter);

mountUploadRoutes(adminUploadRouter, {
  allowedContainers: ['dpr-documents'],
  allowedTypesPerContainer: {
    'dpr-documents': ['application/pdf'],
  },
  // Single shared cap (see lib/payslip.js PAYSLIP_MAX_BYTES).
  // A payslip PDF is 1-2 pages of text + numbers, well under 1 MB; 2 MB
  // is a generous ceiling that matches the download route's
  // MAX_DOWNLOAD_BYTES invariant so a row can never reach a size that
  // download refuses. Lowered from 5 MB in the fixup commit per the
  // pre-AppSec-review requirement that upload ≤ download cap.
  maxSizeBytesPerContainer: {
    'dpr-documents': PAYSLIP_MAX_BYTES,
  },
  // Owns the `payslips/` prefix EXCLUSIVELY. The DPR mount at
  // routes/dpr.js does not list `payslips` — that split is pinned by
  // __tests__/payslip-upload-intent-prefix.test.js. Adding a second
  // path-prefix here would also need to be re-added to the bind-step's
  // blobPath validator in lib/payslip.js — see PAYSLIP_BLOB_PREFIX.
  allowedPathPrefixesPerContainer: {
    'dpr-documents': ['payslips'],
  },
});

// ════════════════════════════════════════════════════════════════════════════
// Admin mutation sub-router — /api/admin/payslips
// ════════════════════════════════════════════════════════════════════════════

const adminRouter = express.Router();
adminRouter.use(requireAuth);
adminRouter.use(requireFreshAdmin);
adminRouter.use(payslipAdminLimiter);

// POST /api/admin/payslips/bind
//
// Bind an UploadIntent (status=CONFIRMED) to a new Payslip row. The
// bind is atomic — Payslip.create + UploadIntent.update run in ONE
// transaction. The route accepts:
//   * ulid          - 26-char Crockford base32
//   * employeeId    - the recipient's employee id
//   * year, month   - coverage window
//
// Auth: requireFreshAdmin (mounted).
// Errors:
//   * 400 VALIDATION_ERROR for bad ulid/year/month
//   * 404 UPLOAD_NOT_CONFIRMED for missing/unconfirmed intent
//   * 409 PAYSLIP_DUPLICATE for `(employee, year, month)` collision
//     (the partial-unique migration
//     `20261002010001_payslip_partial_unique` enforces this at the
//     SQL boundary)
//   * 422 NOT_PDF / 503 VERIFY_UNAVAILABLE on the magic-bytes check
adminRouter.post('/bind', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const { ulid, employeeId, year, month } = req.body || {};
  if (typeof ulid !== 'string' || !ULID_RE.test(ulid)) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', code: 'INVALID_ULID', message: 'ulid must be 26-char Crockford base32' });
  }
  if (typeof employeeId !== 'string' || !employeeId) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', code: 'INVALID_EMPLOYEE_ID' });
  }
  const ymError = validateYearMonth(Number(year), Number(month));
  if (ymError) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', code: 'INVALID_YEAR_MONTH', message: ymError });
  }
  try {
    // The employee must exist. The FK on `employeeId` enforces this
    // at SQL, but a fast pre-check gives a clearer 404.
    const employee = await prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, name: true, isAdmin: true },
    });
    if (!employee) {
      return res.status(404).json({ error: 'EMPLOYEE_NOT_FOUND', code: 'EMPLOYEE_NOT_FOUND' });
    }
    // Test seam: if the test process has stashed a magic-bytes
    // override on the module (the test sets a single key on the
    // `payslipTestOverrides` Symbol the route imports), use it.
    // Production NEVER sets NODE_ENV=test, so the route never consults
    // the stash. The stash is read fresh on every bind so a test can
    // swap the override between cases without rebuilding the app.
    const isTestEnv = process.env.NODE_ENV === 'test';
    const verifyMagicBytes = isTestEnv
      ? (require('../lib/payslip').payslipTestOverrides?.verifyMagicBytes || undefined)
      : undefined;
    const result = await bindPayslipToIntent(prisma, {
      ulid,
      employeeId,
      uploadedById: req.employeeId,
      year: Number(year),
      month: Number(month),
      ...(verifyMagicBytes ? { verifyMagicBytes } : {}),
    });
    // Re-fetch with the include the admin UI needs.
    const payslip = await prisma.payslip.findUnique({
      where: { id: result.payslip.id },
      include: { employee: { select: { id: true, name: true, email: true } } },
    });
    return res.status(201).json(serializePayslipForWire(payslip));
  } catch (err) {
    if (err && err.code === 'PIM_NO_INTENT') {
      return res.status(404).json({ error: 'UPLOAD_NOT_CONFIRMED', code: 'UPLOAD_NOT_CONFIRMED' });
    }
    if (err && err.code === 'PIM_INTENT_NOT_CONFIRMED') {
      return res.status(404).json({ error: 'UPLOAD_NOT_CONFIRMED', code: 'UPLOAD_NOT_CONFIRMED', message: 'Intent is not in CONFIRMED status' });
    }
    if (err && err.code === 'PIM_INVALID_BLOB_PATH') {
      return res.status(400).json({ error: 'INVALID_BLOB_PATH', code: 'INVALID_BLOB_PATH', message: err.message });
    }
    if (err && err.code === 'PIM_NOT_PDF') {
      return res.status(422).json({ error: 'NOT_PDF', code: 'NOT_PDF', magicReason: err.magicReason });
    }
    if (err && err.code === 'PIM_VERIFY_UNAVAILABLE') {
      return res.status(503).json({ error: 'VERIFY_UNAVAILABLE', code: 'VERIFY_UNAVAILABLE', magicReason: err.magicReason });
    }
    if (err && err.code === 'P2002') {
      return res.status(409).json({ error: 'PAYSLIP_DUPLICATE', code: 'PAYSLIP_DUPLICATE', message: 'A payslip already exists for this employee and year/month' });
    }
    if (err && err.code === 'P2025') {
      return res.status(404).json({ error: 'NOT_FOUND', code: 'NOT_FOUND' });
    }
    console.error('[payslip] bind error', {
      adminHash: hashIdentifier(req.employeeId),
      employeeHash: hashIdentifier(employeeId),
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to bind payslip', code: 'PAYSLIP_BIND_FAILED' });
  }
}));

// POST /api/admin/payslips/publish
//
// Per-row late publish. Stamps publishedAt / publishedById in their own
// transaction per row, then queues the recipient email via setImmediate
// (publish response returns immediately). Body:
//   { payslipIds: [string, ...] }
adminRouter.post('/publish', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const { payslipIds } = req.body || {};
  if (!Array.isArray(payslipIds) || payslipIds.length === 0) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', code: 'INVALID_PAYSLIP_IDS', message: 'payslipIds must be a non-empty array' });
  }
  if (payslipIds.length > 200) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', code: 'TOO_MANY_IDS', message: 'payslipIds cannot exceed 200' });
  }
  // Filter to ULID/UUID shapes — same regex the upload intent validates.
  for (const id of payslipIds) {
    if (typeof id !== 'string' || (!UUID_RE.test(id) && !ULID_RE.test(id))) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', code: 'INVALID_PAYSLIP_ID', message: `invalid payslip id: ${id}` });
    }
  }
  const result = await publishPayslip(prisma, {
    payslipIds,
    publishedById: req.employeeId,
  });
  res.status(200).json({
    published: result.published,
    failed: result.failed,
    note: 'Emails are sent in the background; status is reflected on each payslip.emailStatus column.',
  });
}));

// POST /api/admin/payslips/:id/revoke
//
// Soft-delete. Body: { reason?: string }
adminRouter.post('/:id/revoke', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;
  const { reason } = req.body || {};
  if (!UUID_RE.test(id) && !ULID_RE.test(id)) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', code: 'INVALID_ID' });
  }
  // Validate the reason BEFORE the row lookup so the admin gets the
  // 400 immediately — no DB round-trip for an obviously-bad payload.
  // sanitizeAuditReason throws PIM_AUDIT_REASON_REJECTED with the
  // offending word attached; the catch below maps it to 400.
  if (typeof reason === 'string' && reason.length > 0) {
    try {
      // Pure-validate: catch the throw so the row work doesn't run.
      require('../lib/payslip').sanitizeAuditReason(reason);
    } catch (validationErr) {
      if (validationErr && validationErr.code === 'PIM_AUDIT_REASON_REJECTED') {
        return res.status(400).json({
          error: 'AUDIT_REASON_REJECTED',
          code: 'AUDIT_REASON_REJECTED',
          message: validationErr.message,
          rejectedWord: validationErr.rejectedWord,
        });
      }
      throw validationErr;
    }
  }
  try {
    // Re-read the row to avoid an admin trying to revoke a row that's
    // already revoked (idempotent soft-delete would silently no-op,
    // which is fine but we want the response shape to mirror the row).
    const existing = await prisma.payslip.findUnique({ where: { id }, select: { id: true, deletedAt: true } });
    if (!existing) {
      return res.status(404).json({ error: 'NOT_FOUND', code: 'NOT_FOUND' });
    }
    if (existing.deletedAt) {
      return res.status(200).json({ ok: true, id, alreadyRevoked: true });
    }
    const row = await revokePayslip(prisma, { payslipId: id, revokedById: req.employeeId, reason });
    const full = await prisma.payslip.findUnique({
      where: { id: row.id },
      include: { employee: { select: { id: true, name: true, email: true } } },
    });
    res.status(200).json(serializePayslipForWire(full));
  } catch (err) {
    if (err && err.code === 'P2025') {
      return res.status(404).json({ error: 'NOT_FOUND', code: 'NOT_FOUND' });
    }
    console.error('[payslip] revoke error', {
      adminHash: hashIdentifier(req.employeeId),
      payslipHash: hashIdentifier(id),
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to revoke payslip', code: 'PAYSLIP_REVOKE_FAILED' });
  }
}));

// POST /api/admin/payslips/:id/resend-email
//
// Re-queue the recipient email if the row's emailStatus is FAILED.
// Returns the new status without blocking on the send (setImmediate).
adminRouter.post('/:id/resend-email', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;
  if (!UUID_RE.test(id) && !ULID_RE.test(id)) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', code: 'INVALID_ID' });
  }
  try {
    const payslip = await prisma.payslip.findUnique({
      where: { id },
      include: { employee: { select: { id: true, email: true, name: true } } },
    });
    if (!payslip || payslip.deletedAt) {
      return res.status(404).json({ error: 'NOT_FOUND', code: 'NOT_FOUND' });
    }
    if (!payslip.publishedAt) {
      return res.status(409).json({ error: 'NOT_PUBLISHED', code: 'NOT_PUBLISHED', message: 'Cannot resend for an unpublished payslip' });
    }
    if (payslip.emailStatus !== EMAIL_STATUS.FAILED && payslip.emailStatus !== EMAIL_STATUS.SKIPPED_NO_ADDRESS && payslip.emailStatus !== EMAIL_STATUS.SKIPPED_OPT_OUT && payslip.emailStatus !== EMAIL_STATUS.SKIPPED_TYPE_MUTED) {
      return res.status(409).json({
        error: 'NOT_RESENDABLE',
        code: 'NOT_RESENDABLE',
        currentStatus: payslip.emailStatus,
        message: 'Resend is only allowed for FAILED / SKIPPED_* statuses',
      });
    }
    // Reset to PENDING so the dispatcher knows this is a fresh attempt.
    await prisma.payslip.update({
      where: { id },
      data: { emailStatus: EMAIL_STATUS.PENDING, emailFailedReason: null },
    });
    // Fire-and-forget — same setImmediate contract as publishPayslip.
    setImmediate(() => {
      sendPayslipEmail(prisma, id).catch(() => { /* row already stamped */ });
    });
    res.status(202).json({ ok: true, id, queued: true });
  } catch (err) {
    console.error('[payslip] resend error', {
      adminHash: hashIdentifier(req.employeeId),
      payslipHash: hashIdentifier(id),
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to resend payslip email', code: 'PAYSLIP_RESEND_FAILED' });
  }
}));

// POST /api/admin/payslips/resend-stuck
//
// Manual recovery for rows stuck in emailStatus='PENDING' for longer
// than PAYSLIP_PENDING_STUCK_AGE_MS (5 minutes — likely a process
// crash mid-drain or a Resend transient 5xx). The user explicitly
// required this to be an ADMIN-TRIGGERED ENDPOINT — NOT a scheduled
// job. The Prisma filter inside resendStuckPendingPayslips requires:
//
//   emailStatus   = 'PENDING'
//   publishedAt  IS NOT NULL
//   deletedAt    IS NULL
//   purgedAt     IS NULL
//   updatedAt    <  (now - PAYSLIP_PENDING_STUCK_AGE_MS)
//
// so drafts (publishedAt IS NULL), revoked (deletedAt IS NOT NULL),
// and purged (purgedAt IS NOT NULL) rows are NEVER emailed by this
// sweep. The fixup commit also dropped the schema's `@default("PENDING")`
// so freshly-created rows have emailStatus=NULL and cannot match the
// sweep at all.
//
// The helper returns { scanned, sent, failed } — we surface those to the
// admin so the UI can show "X retried, Y still failing". Returns 200 with
// the breakdown even when scanned=0 (the admin may have hit the endpoint
// by mistake).
adminRouter.post('/resend-stuck', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  try {
    const result = await resendStuckPendingPayslips(prisma);
    console.log('[payslip] resend-stuck admin triggered', {
      adminHash: hashIdentifier(req.employeeId),
      scanned: result.scanned,
      sent: result.sent,
      failed: result.failed,
    });
    res.json({
      ok: true,
      scanned: result.scanned,
      sent: result.sent,
      failed: result.failed,
    });
  } catch (err) {
    console.error('[payslip] resend-stuck error', {
      adminHash: hashIdentifier(req.employeeId),
      prismaCode: err && err.code,
      message: err && err.message ? err.message.split('\n')[0] : 'unknown',
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to resend stuck pending payslips', code: 'PAYSLIP_RESEND_STUCK_FAILED' });
  }
}));

// GET /api/admin/payslips — admin's cross-org coverage list. ?year&month
// filter, default to the latest (year, month) seen in the table so the
// admin dashboard loads the most recent coverage view by default.
adminRouter.get('/', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const { year, month, employeeId, status, take = '50', cursor } = req.query;
  const takeN = Math.min(parseInt(take) || 50, 200);
  const where = {
    ...(employeeId ? { employeeId } : {}),
    ...(year && month ? { year: Number(year), month: Number(month) } : {}),
    ...(status === 'revoked' ? { deletedAt: { not: null } } : {}),
    ...(status === 'active' ? { deletedAt: null } : {}),
    ...(status === 'published' ? { publishedAt: { not: null }, deletedAt: null } : {}),
    ...(status === 'unpublished' ? { publishedAt: null, deletedAt: null } : {}),
  };
  try {
    const rows = await prisma.payslip.findMany({
      where,
      include: { employee: { select: { id: true, name: true, email: true } } },
      orderBy: [{ year: 'desc' }, { month: 'desc' }, { createdAt: 'desc' }],
      take: takeN + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > takeN;
    const items = hasMore ? rows.slice(0, -1) : rows;
    res.json({
      payslips: items.map(serializePayslipForWire),
      nextCursor: hasMore ? items[items.length - 1].id : null,
    });
  } catch (err) {
    console.error('[payslip] list error', {
      adminHash: hashIdentifier(req.employeeId),
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to list payslips' });
  }
}));

// GET /api/admin/payslips/coverage?year&month — for each active employee,
// report whether a (non-revoked) payslip exists for the month. Used by the
// admin's "who's missing for {year, month}" view.
adminRouter.get('/coverage', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const yearN = Number(req.query.year);
  const monthN = Number(req.query.month);
  const ymError = validateYearMonth(yearN, monthN);
  if (ymError) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', code: 'INVALID_YEAR_MONTH', message: ymError });
  }
  try {
    const [employees, payslips] = await Promise.all([
      prisma.employee.findMany({
        where: { isActive: true },
        select: { id: true, name: true, email: true },
        orderBy: { name: 'asc' },
      }),
      prisma.payslip.findMany({
        where: { year: yearN, month: monthN, deletedAt: null },
        select: { id: true, employeeId: true, publishedAt: true, publishedById: true, emailStatus: true, emailSentAt: true, createdAt: true },
      }),
    ]);
    const byEmployee = new Map(payslips.map((p) => [p.employeeId, p]));
    const coverage = employees.map((emp) => {
      const p = byEmployee.get(emp.id) || null;
      return {
        employeeId: emp.id,
        employeeName: emp.name,
        employeeEmail: emp.email,
        payslip: p
          ? {
              id: p.id,
              published: !!p.publishedAt,
              emailStatus: p.emailStatus,
              emailSentAt: p.emailSentAt instanceof Date ? p.emailSentAt.toISOString() : p.emailSentAt,
              createdAt: p.createdAt instanceof Date ? p.createdAt.toISOString() : p.createdAt,
            }
          : null,
      };
    });
    const covered = coverage.filter((c) => c.payslip && c.payslip.published).length;
    const missing = coverage.length - covered;
    res.json({
      year: yearN,
      month: monthN,
      totalEmployees: coverage.length,
      coveredCount: covered,
      missingCount: missing,
      coverage,
    });
  } catch (err) {
    console.error('[payslip] coverage error', {
      adminHash: hashIdentifier(req.employeeId),
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to compute coverage' });
  }
}));

// ════════════════════════════════════════════════════════════════════════════
// Employee sub-router — /api/portal/payslips
// ════════════════════════════════════════════════════════════════════════════

const portalRouter = express.Router();
portalRouter.use(requireAuth);
portalRouter.use(payslipDownloadLimiter);

// GET /api/portal/payslips — the employee sees ONLY their own payslips.
// Rows where deletedAt IS NOT NULL are filtered out (revoked).
portalRouter.get('/', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const { year, status, take = '24', cursor } = req.query;
  const takeN = Math.min(parseInt(take) || 24, 100);
  const where = {
    employeeId: req.employeeId,
    deletedAt: null,
    ...(year ? { year: Number(year) } : {}),
    ...(status === 'published' ? { publishedAt: { not: null } } : {}),
    ...(status === 'unpublished' ? { publishedAt: null } : {}),
  };
  try {
    const rows = await prisma.payslip.findMany({
      where,
      orderBy: [{ year: 'desc' }, { month: 'desc' }, { createdAt: 'desc' }],
      take: takeN + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > takeN;
    const items = hasMore ? rows.slice(0, -1) : rows;
    res.json({
      payslips: items.map((row) => serializePayslipForWire({ ...row, employee: undefined })),
      nextCursor: hasMore ? items[items.length - 1].id : null,
    });
  } catch (err) {
    console.error('[payslip] portal list error', {
      employeeHash: hashIdentifier(req.employeeId),
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to list payslips' });
  }
}));

// GET /api/portal/payslips/:id/download
//
// Stream the PDF from R2 through the backend to the employee. NO SAS
// URL ever leaves the server — the user explicitly required this. The
// route is IDOR-guarded by `WHERE employeeId = req.employeeId` and a
// `deletedAt IS NULL` check; a forged id or a revoked row 404s.
//
// Auth: requireAuth + row-ownership predicate. No admin gate — the
// admin's "download someone else's payslip" path is an admin-only
// mutation (NOT YET SHIPPED; tracked in plan §C.6 as future work).
//
// Streaming approach:
//   * S3 GetObject returns a Node Readable on Body.
//   * v1 hard cap = 5 MB. Anything larger is a misdelivery or a
//     data-drift bug; we refuse it (413 PAYSLIP_TOO_LARGE) so the
//     browser never sees a partial PDF. A future "streamed" variant
//     can pipe chunk-by-chunk without the 5 MB cap.
//   * ?download=1 forces Content-Disposition: attachment with the
//     canonical `Payslip-YYYY-MM.pdf` filename. Default is inline.
portalRouter.get('/:id/download', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;
  if (!UUID_RE.test(id) && !ULID_RE.test(id)) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', code: 'INVALID_ID' });
  }
  let row;
  try {
    // IDOR guard — predicate pinned to req.employeeId + active state.
    // The four guards match the plan's "employee can only download a
    // published, not-revoked, not-purged payslip that belongs to them"
    // invariant:
    //   * publishedAt  IS NOT NULL  — drafts are admin-only
    //   * deletedAt    IS NULL      — soft-deleted (revoked) rows
    //   * purgedAt     IS NULL      — tombstoned (purged) rows
    //   * employeeId   = session    — IDOR
    // Each guard is testable (D-series tests); breaking any one is
    // caught by payslip-routes.test.js.
    row = await prisma.payslip.findFirst({
      where: {
        id,
        employeeId: req.employeeId,
        publishedAt: { not: null },
        deletedAt: null,
        purgedAt: null,
      },
      select: { id: true, blobPath: true, contentType: true, sizeBytes: true, year: true, month: true },
    });
  } catch (err) {
    console.error('[payslip] portal download query error', {
      employeeHash: hashIdentifier(req.employeeId),
      payslipHash: hashIdentifier(id),
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    res.status(500).json({ error: 'Failed to fetch payslip' });
    return;
  }
  if (!row) {
    return res.status(404).json({ error: 'NOT_FOUND', code: 'NOT_FOUND' });
  }
  if (!row.blobPath || !row.blobPath.startsWith(`${PAYSLIP_BLOB_PREFIX}/`)) {
    // Defence in depth — the row's blobPath must be in the payslips/
    // namespace. A row with a foreign blobPath (data drift, manual
    // seed) MUST NOT stream from a non-payslips prefix.
    return res.status(404).json({ error: 'NOT_FOUND', code: 'NOT_FOUND' });
  }
  // The blobPath on the row is the canonical full key the upload minted
  // (`payslips/<employeeId>/<ulid>.pdf`). The container for payslip
  // uploads is `dpr-documents` (per the admin upload mount's
  // allowedContainers allowlist). Hardcoded here — never accept a
  // container from the URL or body.
  const CONTAINER = 'dpr-documents';
  // v1 hard cap on buffered download. Anything larger is rejected so
  // a misdelivery or future drift can't OOM the server. The cap is
  // pulled from lib/payslip.js PAYSLIP_MAX_BYTES — single source of
  // truth shared with the upload mount. A payslip is 1-2 pages with
  // text + numbers, well under 1 MB. Mirrored by the upload mount's
  // `maxSizeBytesPerContainer: { 'dpr-documents': PAYSLIP_MAX_BYTES }`
  // so the row can never reach a size that download refuses.
  const MAX_DOWNLOAD_BYTES = PAYSLIP_MAX_BYTES;
  try {
    const client = getS3Client();
    if (!client) {
      return res.status(503).json({ error: 'STORAGE_UNAVAILABLE', code: 'STORAGE_UNAVAILABLE' });
    }
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const cmd = new GetObjectCommand({ Bucket: CONTAINER, Key: row.blobPath });
    const obj = await client.send(cmd);
    const chunks = [];
    let total = 0;
    let oversized = false;
    for await (const chunk of obj.Body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > MAX_DOWNLOAD_BYTES) {
        oversized = true;
        break;
      }
      chunks.push(buf);
    }
    if (oversized) {
      // Mirror the BLOB_GONE shape: a clear, distinct error code so
      // the front-end can render "this payslip is unavailable" rather
      // than a generic 500. The R2 object stays — the size drift
      // is a server-side invariant, not a missing blob.
      return res.status(413).json({
        error: `Payslip exceeds the ${PAYSLIP_MAX_BYTES} byte cap`,
        code: 'PAYSLIP_TOO_LARGE',
      });
    }
    const body = Buffer.concat(chunks);
    res.setHeader('Content-Type', row.contentType || 'application/pdf');
    if (row.sizeBytes) res.setHeader('Content-Length', String(row.sizeBytes));
    // Filename is `Payslip-YYYY-MM.pdf` — never the ulid or any
    // recipient identifier. ?download=1 switches the disposition to
    // `attachment` (browser saves to disk); default is `inline`
    // (browser opens the PDF in a tab).
    const monthName = MONTH_NAMES[(row.month || 1) - 1] || String(row.month);
    const safeName = `Payslip-${row.year}-${String(row.month).padStart(2, '0')}.pdf`;
    const wantAttachment = req.query.download === '1';
    const disposition = wantAttachment
      ? `attachment; filename="${safeName}"`
      : `inline; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(`ACS Chennai ${monthName} ${row.year}`)}.pdf`;
    res.setHeader('Content-Disposition', disposition);
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).end(body);
  } catch (err) {
    const status = err && err.$metadata && err.$metadata.httpStatusCode;
    if (status === 404) {
      // BLOB_GONE — the R2 object is missing. Mirror the projectAttachment
      // contract (round-35): return 410 so the front-end can render
      // "this payslip is no longer available" rather than a 404 page
      // that's indistinguishable from a wrong-id 404.
      return res.status(410).json({ error: 'GONE', code: 'PAYSLIP_BLOB_GONE' });
    }
    console.error('[payslip] portal download stream error', {
      employeeHash: hashIdentifier(req.employeeId),
      payslipHash: hashIdentifier(id),
      httpStatus: status,
      errCode: err && err.code,
      message: err?.message?.split('\n')[0],
    });
    res.status(500).json({ error: 'Failed to stream payslip', code: 'PAYSLIP_DOWNLOAD_FAILED' });
  }
}));

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

module.exports = {
  adminUploadRouter,
  adminRouter,
  portalRouter,
  // Exported for unit tests that build their own mounts.
  validateYearMonth,
};