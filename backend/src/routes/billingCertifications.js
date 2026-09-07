// R37: COP / Billing Certification Register — backend route.
//
// Internal-only ledger that records the certification result of contractor
// RA-bill (COP) submissions per project. Engineers compute the bill offline
// (Excel-based) and enter the result here so we have a single in-portal
// history of "what was certified for whom, on what date, against which PO".
// See schema.prisma#model BillingCertification for the field rationale
// (validated against the actual ACS RA-bill email archive).
//
// Endpoints (mounted at /api/billing-certifications):
//   GET    /                                   admin cross-project list with
//                                              filters + cursor pagination.
//                                              Mirrors /api/admin/reports
//                                              shape (R36).
//   GET    /aggregates                         per-project totals: rows + sum
//                                              of certifiedAmount + count
//                                              of disputes. Powers the
//                                              "by-project" summary tile.
//   GET    /:id                                detail row + joined project
//                                              + recordedBy + certifiedBy.
//   POST   /                                   create. Body carries the
//                                              blobPath returned from the
//                                              pre-uploaded R2 PUT (same
//                                              pattern as Drawing + Report
//                                              upload — see 4-step pipeline
//                                              comment below).
//   PATCH  /:id                                admin metadata update. Cannot
//                                              change (projectId, billNumber,
//                                              contractorName) once certified
//                                              — those are the audit key.
//   POST   /:id/certify                        DRAFT → CERTIFIED. Stamps
//                                              certifiedById + certifiedAt.
//   POST   /:id/dispute                        CERTIFIED → DISPUTED. Requires
//                                              reason.
//   POST   /:id/undispute                      DISPUTED → CERTIFIED. Clears
//                                              disputeReason.
//   DELETE /:id                                soft-delete via deletedAt.
//                                              Idempotent (already-deleted
//                                              returns 404 — matches
//                                              ProjectAttachment contract).
//   GET    /:id/read-sas                       mint 1h read SAS for the
//                                              attached COP PDF.
//
// 4-step upload pipeline (mirrors Drawing + Project Report):
//   1. POST /api/dpr/sas-url
//      body: { filename: 'billing/<original>', contentType, container: 'dpr-documents' }
//      → { sasUrl, ulid, blobPath, expiresAt }
//   2. PUT  <sasUrl>     direct-to-R2 (XHR with progress + timeout)
//   3. POST /api/dpr/confirm-upload  { ulid, container, filename, contentType, sizeBytes }
//      → { blobPath }                  (consumes the upload intent)
//   4. POST /api/billing-certifications   { ...body, blobPath, filename, contentType, sizeBytes }
//      → 201 + serialized row
//
// Auth model:
//   - requireAuth + requireFreshAdmin on EVERY route. The COP register is
//     admin-curated only — employees don't see this surface. Mounting
//     requireFreshAdmin at the router level closes the JWT-claim staleness
//     hole (a demoted admin keeps powers for up to 15m with a stale JWT).
//   - requireFreshAdmin also re-reads Employee.isAdmin from the DB on
//     every mutation; a freshly-demoted admin gets 403 on their next
//     call. Same envelope as /api/admin/reports (R36).
//   - All routes return JSON. POST returns 201; GET/PATCH return 200;
//     DELETE returns 200 with the soft-deleted row for audit. 401/403/404
//     surfaced through the standard error mapper (lib/errors.js).
//
// Cursor codec:
//   - Same DateTime-shape codec as adminReports.js (R36). Date-only
//     columns use the shared lib/cursor.js; this column (billDate) is
//     @db.Date so the shared codec is fine after all — but we keep the
//     inline timestamp codec to avoid coupling this round to a future
//     change in the shared helper. Single-file consumer; pinned here.

'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth, requireFreshAdmin } = require('../middleware/auth');
const { mapPrismaError, parseStrictISODate, toDateOnly } = require('../lib/errors');
const { hashIdentifier } = require('../lib/pii');
const { randomUUID } = require('crypto');
const { generateReadSASUrl, READ_URL_TTL_SECONDS } = require('../lib/blobStorage');

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function getPrisma(req) { return req.app.get('prisma'); }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_STATUS = new Set(['DRAFT', 'CERTIFIED', 'DISPUTED']);

// Per-container MIME allowlist mirror for the dpr-documents bucket.
// Must stay in sync with backend/src/routes/projectAttachments.js
// (VALID_REPORT_CONTENT_TYPES) and src/lib/constants.js (ACCEPTED_REPORT_TYPES).
// Defence-in-depth: the SAS endpoint already gates uploads, but a
// malicious or bug-ridden client could craft a POST that bypasses /sas-url.
const VALID_BILLING_CONTENT_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/heic',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain', 'text/csv',
]);

// Field-length caps (post-coercion).
const FIELD_MAX = {
  contractorName: 160,
  billNumber: 60,
  invoiceNo: 60,
  poContractRef: 120,
  remarks: 2000,
  disputeReason: 1000,
  filename: 512,
  contentType: 120,
  blobPath: 1024,
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_BYTES = 25 * 1024 * 1024; // matches dpr-documents per-container cap

function isValidUuid(s) {
  return typeof s === 'string' && UUID_RE.test(s);
}

// Decimal columns come back from Prisma as strings (to preserve precision
// across JSON boundaries). Accept either number or string on input so the
// client can post either. Reject anything that isn't a finite non-negative
// number, with a 400 if NaN/Infinity sneaks in.
function parseAmount(value, { required, defaultValue }) {
  if (value == null || value === '') {
    if (required) return { ok: false, error: 'amount is required' };
    return { ok: true, value: defaultValue };
  }
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
    return { ok: false, error: 'amount must be a non-negative finite number' };
  }
  // Round to 2 decimals so the stored Decimal(15,2) column doesn't reject.
  return { ok: true, value: Math.round(n * 100) / 100 };
}

// ─── Cursor codec ─────────────────────────────────────────────────────────
// Same base64url(JSON({ billDate: ISO, id })) shape as adminReports.js
// (R36). billDate is @db.Date so the shared lib/cursor.js codec also
// works, but keeping an inline codec here pins the contract to a single
// file and avoids cross-module coupling.
function encodeCursor(billDate, id) {
  const iso = billDate instanceof Date ? billDate.toISOString() : String(billDate);
  return Buffer.from(JSON.stringify({ billDate: iso, id }), 'utf8').toString('base64url');
}
function decodeCursor(cursor) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (typeof parsed.billDate !== 'string' || typeof parsed.id !== 'string') return null;
  const d = new Date(parsed.billDate);
  if (Number.isNaN(d.getTime())) return null;
  return { billDate: d, id: parsed.id };
}

// ─── Serialization ───────────────────────────────────────────────────────
// Date → ISO (or 'YYYY-MM-DD' for billDate) so the frontend can format
// with its own timezone-aware helpers. Decimal → number (the row's
// claimedAmount / certifiedAmount are bounded at 1e13 with 2-decimal
// precision so a JSON number never loses precision for any realistic
// construction-services RA-bill value).
function serializeBillingCertification(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.projectId,
    contractorName: row.contractorName,
    billNumber: row.billNumber,
    billDate: toDateOnly(row.billDate),
    invoiceNo: row.invoiceNo,
    poContractRef: row.poContractRef,
    claimedAmount: row.claimedAmount == null ? null : Number(row.claimedAmount),
    deductedAmount: row.deductedAmount == null ? null : Number(row.deductedAmount),
    certifiedAmount: row.certifiedAmount == null ? null : Number(row.certifiedAmount),
    gstAmount: row.gstAmount == null ? null : Number(row.gstAmount),
    poValue: row.poValue == null ? null : Number(row.poValue),
    balanceValue: row.balanceValue == null ? null : Number(row.balanceValue),
    remarks: row.remarks,
    status: row.status,
    recordedById: row.recordedById,
    certifiedById: row.certifiedById,
    certifiedAt: row.certifiedAt instanceof Date ? row.certifiedAt.toISOString() : row.certifiedAt,
    disputedAt: row.disputedAt instanceof Date ? row.disputedAt.toISOString() : row.disputedAt,
    disputeReason: row.disputeReason,
    filename: row.filename,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    blobPath: row.blobPath,
    uploadedAt: row.uploadedAt instanceof Date ? row.uploadedAt.toISOString() : row.uploadedAt,
    deletedAt: row.deletedAt instanceof Date ? row.deletedAt.toISOString() : row.deletedAt,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
    project: row.project ? {
      id: row.project.id,
      name: row.project.name,
      code: row.project.code || null,
    } : null,
    recordedBy: row.recordedBy ? {
      id: row.recordedBy.id,
      name: row.recordedBy.name,
      designation: row.recordedBy.designation || null,
    } : null,
    certifiedBy: row.certifiedBy ? {
      id: row.certifiedBy.id,
      name: row.certifiedBy.name,
      designation: row.certifiedBy.designation || null,
    } : null,
  };
}

// All routes are admin-only. requireFreshAdmin re-reads Employee.isAdmin
// from the DB on every request so a stale JWT can't carry a revoked
// admin claim forward (round-20 / DR-005).
router.use(requireAuth);
router.use(requireFreshAdmin);

// ─── GET /api/billing-certifications ────────────────────────────────────────
// Admin cross-project list with filters + cursor pagination.
//
// Query params (all optional):
//   ?projectId=<UUID>          scope to one project
//   ?contractorName=<string>   case-insensitive exact match
//   ?status=<DRAFT|CERTIFIED|DISPUTED>
//   ?from=<YYYY-MM-DD>         inclusive lower bound on billDate
//   ?to=<YYYY-MM-DD>           inclusive upper bound
//   ?limit=<n>                 default 50, max 100
//   ?cursor=<base64url JSON>   keyset cursor from previous response
//
// Returns:
//   { certifications: [...], nextCursor, total }
router.get('/', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  if (!prisma) {
    return res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });
  }

  const { projectId, contractorName, status, from, to } = req.query;

  if (projectId && !isValidUuid(projectId)) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      code: 'INVALID_PROJECT',
      message: 'projectId must be a UUID',
    });
  }
  if (status && !VALID_STATUS.has(status)) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      code: 'INVALID_STATUS',
      message: `status must be one of: ${Array.from(VALID_STATUS).join(', ')}`,
    });
  }

  let fromDate = null;
  let toDate = null;
  if (from) {
    const p = parseStrictISODate(from);
    if (!p.ok) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', code: 'INVALID_FROM', message: 'from must be YYYY-MM-DD' });
    }
    fromDate = p.date;
  }
  if (to) {
    const p = parseStrictISODate(to);
    if (!p.ok) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', code: 'INVALID_TO', message: 'to must be YYYY-MM-DD' });
    }
    toDate = p.date;
  }
  if (fromDate && toDate && fromDate > toDate) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      code: 'INVALID_RANGE',
      message: 'from must be ≤ to',
    });
  }

  const limitRaw = parseInt(req.query.limit, 10);
  const take = Math.min(
    Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : DEFAULT_LIMIT,
    MAX_LIMIT,
  );

  let cursorPredicate = null;
  if (req.query.cursor) {
    const decoded = decodeCursor(req.query.cursor);
    if (!decoded) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        code: 'INVALID_CURSOR',
        message: 'cursor is malformed',
      });
    }
    cursorPredicate = {
      OR: [
        { billDate: { lt: decoded.billDate } },
        { billDate: decoded.billDate, id: { lt: decoded.id } },
      ],
    };
  }

  const where = {
    deletedAt: null,
    ...(projectId ? { projectId } : {}),
    ...(status ? { status } : {}),
    ...(contractorName && typeof contractorName === 'string' && contractorName.trim()
      ? { contractorName: { equals: contractorName.trim(), mode: 'insensitive' } }
      : {}),
    ...(fromDate || toDate ? {
      billDate: {
        ...(fromDate ? { gte: fromDate } : {}),
        ...(toDate ? { lte: toDate } : {}),
      },
    } : {}),
    ...(cursorPredicate || {}),
  };

  try {
    const [rows, total, totalsByStatus] = await Promise.all([
      prisma.billingCertification.findMany({
        where,
        take: take + 1,
        orderBy: [{ billDate: 'desc' }, { id: 'desc' }],
        include: {
          project: { select: { id: true, name: true, code: true } },
          recordedBy: { select: { id: true, name: true, designation: true } },
          certifiedBy: { select: { id: true, name: true, designation: true } },
        },
      }),
      prisma.billingCertification.count({ where }),
      prisma.billingCertification.groupBy({
        where: { deletedAt: null },
        by: ['status'],
        _count: { _all: true },
        _sum: { certifiedAmount: true, claimedAmount: true, deductedAmount: true },
      }),
    ]);

    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;
    const last = page[page.length - 1];
    const summary = { DRAFT: 0, CERTIFIED: 0, DISPUTED: 0 };
    const sums = { DRAFT: 0, CERTIFIED: 0, DISPUTED: 0 };
    const claimSums = { DRAFT: 0, CERTIFIED: 0, DISPUTED: 0 };
    const deductSums = { DRAFT: 0, CERTIFIED: 0, DISPUTED: 0 };
    for (const row of totalsByStatus) {
      summary[row.status] = row._count?._all || 0;
      sums[row.status] = row._sum?.certifiedAmount ? Number(row._sum.certifiedAmount) : 0;
      claimSums[row.status] = row._sum?.claimedAmount ? Number(row._sum.claimedAmount) : 0;
      deductSums[row.status] = row._sum?.deductedAmount ? Number(row._sum.deductedAmount) : 0;
    }
    return res.json({
      certifications: page.map(serializeBillingCertification),
      nextCursor: hasMore && last ? encodeCursor(last.billDate, last.id) : null,
      total,
      summary: {
        byStatus: {
          DRAFT: { count: summary.DRAFT, totalCertified: sums.DRAFT, totalClaimed: claimSums.DRAFT, totalDeducted: deductSums.DRAFT },
          CERTIFIED: { count: summary.CERTIFIED, totalCertified: sums.CERTIFIED, totalClaimed: claimSums.CERTIFIED, totalDeducted: deductSums.CERTIFIED },
          DISPUTED: { count: summary.DISPUTED, totalCertified: sums.DISPUTED, totalClaimed: claimSums.DISPUTED, totalDeducted: deductSums.DISPUTED },
        },
      },
    });
  } catch (err) {
    console.error('[billing-certifications] list failed', {
      employeeHash: hashIdentifier(req.employeeId),
      errCode: err?.code,
      errMessage: err?.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to load billing certifications' });
  }
}));

// ─── GET /api/billing-certifications/aggregates ────────────────────────────
// Per-project rolled-up totals. Same shape as the list's summary tile but
// keyed by projectId. Mirrors the dashboard use-case "show me what each
// project has been billed vs certified so far".
//
// Query params (all optional):
//   ?projectId=<UUID>  scope to one project
//   ?from=<YYYY-MM-DD>
//   ?to=<YYYY-MM-DD>
//
// Returns:
//   { projects: [{ projectId, projectName, projectCode, byStatus: {...}, totals: {...} }] }
router.get('/aggregates', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  if (!prisma) {
    return res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });
  }

  const { projectId } = req.query;
  if (projectId && !isValidUuid(projectId)) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      code: 'INVALID_PROJECT',
      message: 'projectId must be a UUID',
    });
  }

  let fromDate = null;
  let toDate = null;
  if (req.query.from) {
    const p = parseStrictISODate(req.query.from);
    if (!p.ok) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', code: 'INVALID_FROM', message: 'from must be YYYY-MM-DD' });
    }
    fromDate = p.date;
  }
  if (req.query.to) {
    const p = parseStrictISODate(req.query.to);
    if (!p.ok) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', code: 'INVALID_TO', message: 'to must be YYYY-MM-DD' });
    }
    toDate = p.date;
  }
  if (fromDate && toDate && fromDate > toDate) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      code: 'INVALID_RANGE',
      message: 'from must be ≤ to',
    });
  }

  const where = {
    deletedAt: null,
    ...(projectId ? { projectId } : {}),
    ...(fromDate || toDate ? {
      billDate: {
        ...(fromDate ? { gte: fromDate } : {}),
        ...(toDate ? { lte: toDate } : {}),
      },
    } : {}),
  };

  try {
    // Single groupBy across (projectId, status). Postgres can satisfy
    // this from the (projectId, status, deletedAt) index. We then fold
    // the per-(project, status) rows into a per-project shape client-side
    // so the UI doesn't have to do the join.
    const grouped = await prisma.billingCertification.groupBy({
      where,
      by: ['projectId', 'status'],
      _count: { _all: true },
      _sum: { certifiedAmount: true, claimedAmount: true, deductedAmount: true },
    });

    // Resolve project rows in one round trip so the response carries
    // projectName + projectCode without N+1.
    const projectIds = Array.from(new Set(grouped.map((g) => g.projectId)));
    const projects = projectIds.length
      ? await prisma.project.findMany({
          where: { id: { in: projectIds } },
          select: { id: true, name: true, code: true },
        })
      : [];
    const projectById = new Map(projects.map((p) => [p.id, p]));

    // Fold the per-(project, status) rows into a per-project shape.
    const byProjectId = new Map();
    for (const row of grouped) {
      const bucket = byProjectId.get(row.projectId) || {
        projectId: row.projectId,
        byStatus: {
          DRAFT: { count: 0, totalCertified: 0, totalClaimed: 0, totalDeducted: 0 },
          CERTIFIED: { count: 0, totalCertified: 0, totalClaimed: 0, totalDeducted: 0 },
          DISPUTED: { count: 0, totalCertified: 0, totalClaimed: 0, totalDeducted: 0 },
        },
        totals: { count: 0, totalCertified: 0, totalClaimed: 0, totalDeducted: 0 },
      };
      bucket.byStatus[row.status] = {
        count: row._count?._all || 0,
        totalCertified: row._sum?.certifiedAmount ? Number(row._sum.certifiedAmount) : 0,
        totalClaimed: row._sum?.claimedAmount ? Number(row._sum.claimedAmount) : 0,
        totalDeducted: row._sum?.deductedAmount ? Number(row._sum.deductedAmount) : 0,
      };
      bucket.totals.count += row._count?._all || 0;
      bucket.totals.totalCertified += row._sum?.certifiedAmount ? Number(row._sum.certifiedAmount) : 0;
      bucket.totals.totalClaimed += row._sum?.claimedAmount ? Number(row._sum.claimedAmount) : 0;
      bucket.totals.totalDeducted += row._sum?.deductedAmount ? Number(row._sum.deductedAmount) : 0;
      byProjectId.set(row.projectId, bucket);
    }

    const out = Array.from(byProjectId.values()).map((b) => {
      const p = projectById.get(b.projectId);
      return {
        projectId: b.projectId,
        projectName: p ? p.name : 'Unknown project',
        projectCode: p && p.code ? p.code : null,
        byStatus: b.byStatus,
        totals: b.totals,
      };
    });
    // Stable sort: by totalCertified desc so the dashboard highlights
    // the highest-billed project first.
    out.sort((a, b) => b.totals.totalCertified - a.totals.totalCertified);
    return res.json({ projects: out });
  } catch (err) {
    console.error('[billing-certifications] aggregates failed', {
      employeeHash: hashIdentifier(req.employeeId),
      errCode: err?.code,
      errMessage: err?.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to load aggregates' });
  }
}));

// ─── GET /api/billing-certifications/:id ────────────────────────────────────
// Detail row with joined project + recordedBy + certifiedBy.
router.get('/:id', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  if (!prisma) {
    return res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });
  }
  const { id } = req.params;
  if (!isValidUuid(id)) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'id must be a UUID' });
  }
  try {
    const row = await prisma.billingCertification.findUnique({
      where: { id },
      include: {
        project: { select: { id: true, name: true, code: true } },
        recordedBy: { select: { id: true, name: true, designation: true } },
        certifiedBy: { select: { id: true, name: true, designation: true } },
      },
    });
    if (!row || row.deletedAt) {
      return res.status(404).json({ error: 'CERTIFICATION_NOT_FOUND', code: 'CERTIFICATION_NOT_FOUND', message: 'Billing certification not found' });
    }
    res.json(serializeBillingCertification(row));
  } catch (err) {
    console.error('[billing-certifications] detail failed', {
      employeeHash: hashIdentifier(req.employeeId),
      certificationId: id,
      errCode: err?.code,
      errMessage: err?.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to load billing certification' });
  }
}));

// ─── POST /api/billing-certifications ───────────────────────────────────────
// Create row. The body carries the (already-uploaded) blob metadata from
// the 4-step SAS pipeline. The blobPath is required IF any of the
// attachment fields are present; all four must agree (filename,
// contentType, sizeBytes, blobPath) — partial attachments are 400'd so the
// row can never carry a half-attached blob.
//
// Auth: requireFreshAdmin (admin-only). No "on-behalf" semantics —
// recordedById is auto-stamped to req.employeeId.
router.post('/', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  if (!prisma) {
    return res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });
  }

  const body = req.body || {};
  const { projectId } = body;
  if (!projectId || !isValidUuid(projectId)) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', code: 'INVALID_PROJECT', message: 'projectId is required and must be a UUID' });
  }
  if (!body.contractorName || typeof body.contractorName !== 'string' || !body.contractorName.trim()) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'contractorName is required' });
  }
  if (!body.billNumber || typeof body.billNumber !== 'string' || !body.billNumber.trim()) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'billNumber is required' });
  }
  const billDateParsed = parseStrictISODate(body.billDate);
  if (!billDateParsed.ok) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', code: 'INVALID_BILL_DATE', message: 'billDate must be a valid YYYY-MM-DD date' });
  }
  const claimed = parseAmount(body.claimedAmount, { required: true });
  if (!claimed.ok) return res.status(400).json({ error: 'VALIDATION_ERROR', code: 'INVALID_CLAIMED', message: claimed.error });
  const certified = parseAmount(body.certifiedAmount, { required: true });
  if (!certified.ok) return res.status(400).json({ error: 'VALIDATION_ERROR', code: 'INVALID_CERTIFIED', message: certified.error });
  const deducted = parseAmount(body.deductedAmount, { required: false, defaultValue: 0 });
  if (!deducted.ok) return res.status(400).json({ error: 'VALIDATION_ERROR', code: 'INVALID_DEDUCTED', message: deducted.error });
  const gst = parseAmount(body.gstAmount, { required: false, defaultValue: null });
  if (!gst.ok) return res.status(400).json({ error: 'VALIDATION_ERROR', code: 'INVALID_GST', message: gst.error });
  const po = parseAmount(body.poValue, { required: false, defaultValue: null });
  if (!po.ok) return res.status(400).json({ error: 'VALIDATION_ERROR', code: 'INVALID_PO_VALUE', message: po.error });
  const bal = parseAmount(body.balanceValue, { required: false, defaultValue: null });
  if (!bal.ok) return res.status(400).json({ error: 'VALIDATION_ERROR', code: 'INVALID_BALANCE', message: bal.error });

  if (body.status != null && body.status !== '' && !VALID_STATUS.has(body.status)) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      code: 'INVALID_STATUS',
      message: `status must be one of: ${Array.from(VALID_STATUS).join(', ')}`,
    });
  }

  // Length caps (post-coercion).
  for (const [k, cap] of Object.entries(FIELD_MAX)) {
    const v = body[k];
    if (v != null && typeof v === 'string' && v.length > cap) {
      return res.status(400).json({ error: `${k} exceeds ${cap} chars`, code: 'VALIDATION_ERROR' });
    }
  }

  // Attachment fields must be all-or-nothing. The server stores the
  // blobPath verbatim from /sas-url — it must start with `billing/` so
  // a bucket-wide listing can still distinguish billing-cert objects
  // from drawings / reports that share the dpr-documents bucket.
  const attachFields = ['filename', 'contentType', 'blobPath'];
  const anyAttach = attachFields.some((k) => body[k] != null && body[k] !== '');
  if (anyAttach) {
    for (const k of attachFields) {
      if (!body[k] || typeof body[k] !== 'string') {
        return res.status(400).json({
          error: 'VALIDATION_ERROR',
          code: 'INCOMPLETE_ATTACHMENT',
          message: `All of ${attachFields.join(', ')} are required when an attachment is present`,
        });
      }
    }
    if (!VALID_BILLING_CONTENT_TYPES.has(body.contentType)) {
      return res.status(400).json({
        error: 'INVALID_CONTENT_TYPE',
        code: 'INVALID_CONTENT_TYPE',
        message: `contentType must be one of: ${Array.from(VALID_BILLING_CONTENT_TYPES).join(', ')}`,
      });
    }
    if (typeof body.sizeBytes !== 'number' || !Number.isFinite(body.sizeBytes) || body.sizeBytes <= 0) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'sizeBytes must be a positive number' });
    }
    if (body.sizeBytes > MAX_BYTES) {
      return res.status(413).json({
        error: 'ATTACHMENT_TOO_LARGE',
        code: 'ATTACHMENT_TOO_LARGE',
        message: 'Attachment must be 1 byte – 26214400 bytes',
      });
    }
    if (!body.blobPath.startsWith('billing/')) {
      return res.status(400).json({
        error: 'INVALID_BLOB_PATH',
        code: 'INVALID_BLOB_PATH',
        message: 'blobPath must be under the billing/ prefix (server-enforced namespace)',
      });
    }
  }

  // Project must exist + be active. Mirrors drawing.js#POST.
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, isActive: true },
  });
  if (!project || !project.isActive) {
    return res.status(400).json({
      error: 'PROJECT_NOT_FOUND',
      code: 'PROJECT_NOT_FOUND',
      message: 'Linked project does not exist or is archived',
    });
  }

  // Optional optimistic DRAFT/CERTIFIED transition: when the client POSTs
  // with status='CERTIFIED', stamp the audit fields the same way the
  // /:id/certify endpoint does, so the wire contract doesn't force a
  // second round-trip for a "create + immediately certify" flow.
  const initialStatus = body.status && VALID_STATUS.has(body.status) ? body.status : 'DRAFT';
  const now = new Date();
  const data = {
    id: randomUUID(),
    projectId,
    contractorName: body.contractorName.trim(),
    billNumber: body.billNumber.trim(),
    billDate: billDateParsed.date,
    invoiceNo: body.invoiceNo ? body.invoiceNo.trim() : null,
    poContractRef: body.poContractRef ? body.poContractRef.trim() : null,
    claimedAmount: claimed.value,
    deductedAmount: deducted.value,
    certifiedAmount: certified.value,
    gstAmount: gst.value,
    poValue: po.value,
    balanceValue: bal.value,
    remarks: body.remarks ? body.remarks.trim() : null,
    status: initialStatus,
    recordedById: req.employeeId,
    filename: body.filename ? body.filename.trim() : null,
    contentType: body.contentType || null,
    sizeBytes: body.sizeBytes || null,
    blobPath: body.blobPath || null,
    uploadedAt: body.blobPath ? now : null,
  };
  if (initialStatus === 'CERTIFIED') {
    data.certifiedById = req.employeeId;
    data.certifiedAt = now;
  }

  try {
    const row = await prisma.billingCertification.create({ data });
    const full = await prisma.billingCertification.findUnique({
      where: { id: row.id },
      include: {
        project: { select: { id: true, name: true, code: true } },
        recordedBy: { select: { id: true, name: true, designation: true } },
        certifiedBy: { select: { id: true, name: true, designation: true } },
      },
    });
    res.status(201).json(serializeBillingCertification(full));
  } catch (err) {
    console.error('[billing-certifications] create failed', {
      employeeHash: hashIdentifier(req.employeeId),
      projectId,
      errCode: err?.code,
      errMessage: err?.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to create billing certification' });
  }
}));

// ─── PATCH /api/billing-certifications/:id ─────────────────────────────────
// Admin metadata update. Allows editing amounts, GST, PO ref, invoice no,
// remarks, disputeReason. The audit key (projectId, contractorName,
// billNumber) is immutable once the row exists — to "rename" a bill, soft-
// delete the row and create a new one. Status transitions route through
// /certify /dispute /undispute.
router.patch('/:id', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  if (!prisma) {
    return res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });
  }
  const { id } = req.params;
  if (!isValidUuid(id)) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'id must be a UUID' });
  }

  const body = req.body || {};
  const ALLOWED_PATCH_FIELDS = [
    'invoiceNo', 'poContractRef',
    'claimedAmount', 'deductedAmount', 'certifiedAmount',
    'gstAmount', 'poValue', 'balanceValue',
    'remarks', 'disputeReason',
    'filename', 'contentType', 'blobPath', 'sizeBytes',
  ];
  const unknown = Object.keys(body).filter((k) => !ALLOWED_PATCH_FIELDS.includes(k));
  if (unknown.length) {
    return res.status(400).json({
      error: 'UNKNOWN_FIELDS',
      message: `Fields not allowed: ${unknown.join(', ')}`,
      fields: unknown,
    });
  }

  const data = {};
  if (body.invoiceNo !== undefined) {
    if (body.invoiceNo != null && body.invoiceNo !== '' && typeof body.invoiceNo !== 'string') {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'invoiceNo must be a string' });
    }
    data.invoiceNo = body.invoiceNo ? body.invoiceNo.trim() : null;
  }
  if (body.poContractRef !== undefined) {
    if (body.poContractRef != null && body.poContractRef !== '' && typeof body.poContractRef !== 'string') {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'poContractRef must be a string' });
    }
    data.poContractRef = body.poContractRef ? body.poContractRef.trim() : null;
  }
  if (body.claimedAmount !== undefined) {
    const v = parseAmount(body.claimedAmount, { required: true });
    if (!v.ok) return res.status(400).json({ error: 'VALIDATION_ERROR', code: 'INVALID_CLAIMED', message: v.error });
    data.claimedAmount = v.value;
  }
  if (body.deductedAmount !== undefined) {
    const v = parseAmount(body.deductedAmount, { required: false, defaultValue: 0 });
    if (!v.ok) return res.status(400).json({ error: 'VALIDATION_ERROR', code: 'INVALID_DEDUCTED', message: v.error });
    data.deductedAmount = v.value;
  }
  if (body.certifiedAmount !== undefined) {
    const v = parseAmount(body.certifiedAmount, { required: true });
    if (!v.ok) return res.status(400).json({ error: 'VALIDATION_ERROR', code: 'INVALID_CERTIFIED', message: v.error });
    data.certifiedAmount = v.value;
  }
  if (body.gstAmount !== undefined) {
    const v = parseAmount(body.gstAmount, { required: false, defaultValue: null });
    if (!v.ok) return res.status(400).json({ error: 'VALIDATION_ERROR', code: 'INVALID_GST', message: v.error });
    data.gstAmount = v.value;
  }
  if (body.poValue !== undefined) {
    const v = parseAmount(body.poValue, { required: false, defaultValue: null });
    if (!v.ok) return res.status(400).json({ error: 'VALIDATION_ERROR', code: 'INVALID_PO_VALUE', message: v.error });
    data.poValue = v.value;
  }
  if (body.balanceValue !== undefined) {
    const v = parseAmount(body.balanceValue, { required: false, defaultValue: null });
    if (!v.ok) return res.status(400).json({ error: 'VALIDATION_ERROR', code: 'INVALID_BALANCE', message: v.error });
    data.balanceValue = v.value;
  }
  if (body.remarks !== undefined) {
    if (body.remarks != null && body.remarks !== '' && typeof body.remarks !== 'string') {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'remarks must be a string' });
    }
    data.remarks = body.remarks ? body.remarks.trim() : null;
  }
  if (body.disputeReason !== undefined) {
    if (body.disputeReason != null && body.disputeReason !== '' && typeof body.disputeReason !== 'string') {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'disputeReason must be a string' });
    }
    data.disputeReason = body.disputeReason ? body.disputeReason.trim() : null;
  }
  // Attachment-field swaps. Same all-or-nothing check as POST.
  const attachFields = ['filename', 'contentType', 'blobPath'];
  const attachTouched = ['filename', 'contentType', 'blobPath', 'sizeBytes'].some((k) => body[k] !== undefined);
  if (attachTouched) {
    const anyAttach = attachFields.some((k) => body[k] != null && body[k] !== '');
    if (anyAttach) {
      for (const k of attachFields) {
        if (!body[k] || typeof body[k] !== 'string') {
          return res.status(400).json({
            error: 'VALIDATION_ERROR',
            code: 'INCOMPLETE_ATTACHMENT',
            message: `All of ${attachFields.join(', ')} are required when an attachment is present`,
          });
        }
      }
      if (!VALID_BILLING_CONTENT_TYPES.has(body.contentType)) {
        return res.status(400).json({
          error: 'INVALID_CONTENT_TYPE',
          code: 'INVALID_CONTENT_TYPE',
          message: `contentType must be one of: ${Array.from(VALID_BILLING_CONTENT_TYPES).join(', ')}`,
        });
      }
      if (typeof body.sizeBytes !== 'number' || !Number.isFinite(body.sizeBytes) || body.sizeBytes <= 0) {
        return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'sizeBytes must be a positive number' });
      }
      if (body.sizeBytes > MAX_BYTES) {
        return res.status(413).json({
          error: 'ATTACHMENT_TOO_LARGE',
          code: 'ATTACHMENT_TOO_LARGE',
          message: 'Attachment must be 1 byte – 26214400 bytes',
        });
      }
      if (!body.blobPath.startsWith('billing/')) {
        return res.status(400).json({
          error: 'INVALID_BLOB_PATH',
          code: 'INVALID_BLOB_PATH',
          message: 'blobPath must be under the billing/ prefix (server-enforced namespace)',
        });
      }
      data.filename = body.filename;
      data.contentType = body.contentType;
      data.blobPath = body.blobPath;
      data.sizeBytes = body.sizeBytes;
      data.uploadedAt = new Date();
    } else {
      data.filename = null;
      data.contentType = null;
      data.blobPath = null;
      data.sizeBytes = null;
      data.uploadedAt = null;
    }
  }

  // Length caps.
  for (const [k, cap] of Object.entries(FIELD_MAX)) {
    if (data[k] != null && typeof data[k] === 'string' && data[k].length > cap) {
      return res.status(400).json({ error: `${k} exceeds ${cap} chars`, code: 'VALIDATION_ERROR' });
    }
  }

  if (Object.keys(data).length === 0) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'No updatable fields provided' });
  }

  try {
    const existing = await prisma.billingCertification.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) {
      return res.status(404).json({ error: 'CERTIFICATION_NOT_FOUND', code: 'CERTIFICATION_NOT_FOUND', message: 'Billing certification not found' });
    }
    const updated = await prisma.billingCertification.update({ where: { id }, data });
    const full = await prisma.billingCertification.findUnique({
      where: { id },
      include: {
        project: { select: { id: true, name: true, code: true } },
        recordedBy: { select: { id: true, name: true, designation: true } },
        certifiedBy: { select: { id: true, name: true, designation: true } },
      },
    });
    res.json(serializeBillingCertification(full));
  } catch (err) {
    console.error('[billing-certifications] update failed', {
      employeeHash: hashIdentifier(req.employeeId),
      certificationId: id,
      errCode: err?.code,
      errMessage: err?.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to update billing certification' });
  }
}));

// ─── POST /api/billing-certifications/:id/certify ──────────────────────────
// DRAFT | DISPUTED → CERTIFIED. Stamps certifiedById + certifiedAt.
router.post('/:id/certify', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  if (!prisma) {
    return res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });
  }
  const { id } = req.params;
  if (!isValidUuid(id)) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'id must be a UUID' });
  }
  try {
    const existing = await prisma.billingCertification.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) {
      return res.status(404).json({ error: 'CERTIFICATION_NOT_FOUND', code: 'CERTIFICATION_NOT_FOUND', message: 'Billing certification not found' });
    }
    if (existing.status === 'CERTIFIED') {
      // Idempotent — already certified. Return current state.
      const full = await prisma.billingCertification.findUnique({
        where: { id },
        include: {
          project: { select: { id: true, name: true, code: true } },
          recordedBy: { select: { id: true, name: true, designation: true } },
          certifiedBy: { select: { id: true, name: true, designation: true } },
        },
      });
      return res.json(serializeBillingCertification(full));
    }
    const now = new Date();
    await prisma.billingCertification.update({
      where: { id },
      data: {
        status: 'CERTIFIED',
        certifiedById: req.employeeId,
        certifiedAt: now,
        // Re-certifying clears any prior dispute metadata. The audit
        // trail (disputedAt + disputeReason) is intentionally retained
        // so admins can see "this row was disputed and then re-certified"
        // in the history; the status flip + cleared disputeReason is
        // the live signal.
        disputeReason: null,
      },
    });
    const full = await prisma.billingCertification.findUnique({
      where: { id },
      include: {
        project: { select: { id: true, name: true, code: true } },
        recordedBy: { select: { id: true, name: true, designation: true } },
        certifiedBy: { select: { id: true, name: true, designation: true } },
      },
    });
    res.json(serializeBillingCertification(full));
  } catch (err) {
    console.error('[billing-certifications] certify failed', {
      employeeHash: hashIdentifier(req.employeeId),
      certificationId: id,
      errCode: err?.code,
      errMessage: err?.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to certify billing certification' });
  }
}));

// ─── POST /api/billing-certifications/:id/dispute ──────────────────────────
// CERTIFIED → DISPUTED. Requires reason.
router.post('/:id/dispute', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  if (!prisma) {
    return res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });
  }
  const { id } = req.params;
  if (!isValidUuid(id)) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'id must be a UUID' });
  }
  const reason = (req.body && typeof req.body.reason === 'string') ? req.body.reason.trim() : '';
  if (!reason) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      code: 'REASON_REQUIRED',
      message: 'reason is required to dispute a certification',
    });
  }
  if (reason.length > FIELD_MAX.disputeReason) {
    return res.status(400).json({ error: 'disputeReason exceeds 1000 chars', code: 'VALIDATION_ERROR' });
  }
  try {
    const existing = await prisma.billingCertification.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) {
      return res.status(404).json({ error: 'CERTIFICATION_NOT_FOUND', code: 'CERTIFICATION_NOT_FOUND', message: 'Billing certification not found' });
    }
    if (existing.status === 'DISPUTED') {
      return res.status(409).json({
        error: 'ALREADY_DISPUTED',
        code: 'ALREADY_DISPUTED',
        message: 'Certification is already disputed',
      });
    }
    if (existing.status === 'DRAFT') {
      return res.status(409).json({
        error: 'INVALID_TRANSITION',
        code: 'INVALID_TRANSITION',
        message: 'Cannot dispute a DRAFT certification. Edit the amounts or delete and recreate.',
      });
    }
    await prisma.billingCertification.update({
      where: { id },
      data: {
        status: 'DISPUTED',
        disputedAt: new Date(),
        disputeReason: reason,
      },
    });
    const full = await prisma.billingCertification.findUnique({
      where: { id },
      include: {
        project: { select: { id: true, name: true, code: true } },
        recordedBy: { select: { id: true, name: true, designation: true } },
        certifiedBy: { select: { id: true, name: true, designation: true } },
      },
    });
    res.json(serializeBillingCertification(full));
  } catch (err) {
    console.error('[billing-certifications] dispute failed', {
      employeeHash: hashIdentifier(req.employeeId),
      certificationId: id,
      errCode: err?.code,
      errMessage: err?.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to dispute billing certification' });
  }
}));

// ─── DELETE /api/billing-certifications/:id ───────────────────────────────
// Soft-delete via deletedAt. Idempotent on already-deleted rows — 200 with
// the row as-is (mirrors drawings.js DELETE idempotency on already-
// SUPERSEDED rows; soft-delete matches ProjectAttachment's contract).
router.delete('/:id', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  if (!prisma) {
    return res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });
  }
  const { id } = req.params;
  if (!isValidUuid(id)) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'id must be a UUID' });
  }
  try {
    const existing = await prisma.billingCertification.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) {
      return res.status(404).json({
        error: 'CERTIFICATION_NOT_FOUND',
        code: 'CERTIFICATION_NOT_FOUND',
        message: 'Billing certification not found',
      });
    }
    const updated = await prisma.billingCertification.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    res.json(serializeBillingCertification(updated));
  } catch (err) {
    console.error('[billing-certifications] delete failed', {
      employeeHash: hashIdentifier(req.employeeId),
      certificationId: id,
      errCode: err?.code,
      errMessage: err?.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to delete billing certification' });
  }
}));

// ─── GET /api/billing-certifications/:id/read-sas ──────────────────────────
// Mint 1h read SAS for the attached COP PDF. Same auth gate (admin) +
// container='dpr-documents' convention used by Drawing + Project Report.
// 400 NO_BLOB_ATTACHED if the row has no blob (the COP wasn't uploaded).
router.get('/:id/read-sas', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  if (!prisma) {
    return res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });
  }
  const { id } = req.params;
  if (!isValidUuid(id)) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'id must be a UUID' });
  }
  try {
    const row = await prisma.billingCertification.findUnique({
      where: { id },
      select: { blobPath: true, deletedAt: true },
    });
    if (!row || row.deletedAt) {
      return res.status(404).json({
        error: 'CERTIFICATION_NOT_FOUND',
        code: 'CERTIFICATION_NOT_FOUND',
        message: 'Billing certification not found',
      });
    }
    if (!row.blobPath) {
      return res.status(400).json({
        error: 'NO_BLOB_ATTACHED',
        code: 'NO_BLOB_ATTACHED',
        message: 'This certification has no attached COP PDF',
      });
    }
    const { sasUrl } = await generateReadSASUrl('dpr-documents', row.blobPath);
    res.json({ sasUrl, expiresIn: READ_URL_TTL_SECONDS });
  } catch (err) {
    console.error('[billing-certifications] read-sas failed', {
      employeeHash: hashIdentifier(req.employeeId),
      certificationId: id,
      errCode: err?.code,
      errMessage: err?.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to mint read URL' });
  }
}));

module.exports = router;
