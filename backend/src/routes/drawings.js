// N3 (Phase E): Drawing Revision Register.
//
// Curated register of construction drawings per project. Each drawing has a
// (drawingNumber, revision) pair; subsequent revisions are added as NEW rows
// that supersede the previous one (the `supersedesId` self-relation). DPR
// and Inspection records can link to a specific drawing revision so the
// stamp UI can render "Filed against drawing X rev Y".
//
// Endpoints:
//   GET    /api/drawings                list (cursor paginated, filters)
//   POST   /api/drawings                create (any employee) — supports supersedes
//   GET    /api/drawings/:id            detail + reference counts + supersedes chain
//   PATCH  /api/drawings/:id            update metadata (admin)
//   DELETE /api/drawings/:id            soft-delete via status=SUPERSEDED (admin)
//
// Auth model:
//   - requireAuth on every route (any employee can read the register).
//   - requireFreshAdmin on PATCH + DELETE — editing metadata / archiving a
//     drawing hides it from a future DPR's stamp picker, so that's curation
//     and stays admin-only (admin-claim TTL is 15m, so a freshly demoted
//     admin cannot mutate drawings with a stale token).
//   - [Round-31] POST loosened to requireAuth — posting a fresh PDF revision
//     is a low-curation-risk act any employee should be able to do without
//     bouncing to an admin (mirrors how DPR / Inspection / BoqItem /
//     VariationOrder creation is open to any employee today). The route
//     auto-stamps `issuedById = req.employeeId` when omitted so the new
//     drawing's audit column is meaningful for the Round-30 `?scope=assigned`
//     union (Drawing.issuedById).
//
// Supercedes contract:
//   - POST /api/drawings with `supersedesId` flips the prior row to
//     status=SUPERSEDED atomically with the new row insert. Both rows must
//     belong to the same project (cross-project supersedes is rejected
//     with 400).
//   - The reference-count endpoint lists every DPR / Inspection that links
//     to a drawing, so an admin about to supersede a drawing can warn the
//     submitter that future submissions against the old revision will still
//     resolve to the historical record.
//
// Upload reuse:
//   - pdfBlobPath is set by the client after uploading through the existing
//     /api/dpr/sas-url + /api/dpr/confirm-upload flow with container
//     'dpr-documents'. The server stores the path verbatim and the
//     download route (a follow-up round) will mint a read SAS on demand.
//     We do NOT add a new bucket here — dpr-documents is the curated
//     blob bucket for any non-photo evidence (drawing PDFs, inspection
//     PDFs, etc.).

'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth, requireFreshAdmin } = require('../middleware/auth');
const { mapPrismaError, parseStrictISODate, toDateOnly } = require('../lib/errors');
const { hashIdentifier } = require('../lib/pii');
const { randomUUID } = require('crypto');
const { encodeCursor, decodeCursor, InvalidCursorError } = require('../lib/cursor');
const { generateReadSASUrl, READ_URL_TTL_SECONDS } = require('../lib/blobStorage');

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function getPrisma(req) { return req.app.get('prisma'); }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALLOWED_STATUS = new Set(['ACTIVE', 'SUPERSEDED']);

// ─── Field-length caps ──────────────────────────────────────────────────────
const FIELD_MAX = {
  drawingNumber: 60,
  title: 200,
  revision: 20,
  pdfBlobPath: 1024,
};

function isValidUuid(s) {
  return typeof s === 'string' && UUID_RE.test(s);
}

// ─── Serialization ──────────────────────────────────────────────────────────
// Used by the list endpoint (Date → 'YYYY-MM-DD') and the detail endpoint
// (Date → ISO). Date-only is the contract for issued_date so the dashboard
// can render the column without re-parsing.
function serializeDrawing(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.projectId,
    drawingNumber: row.drawingNumber,
    title: row.title,
    revision: row.revision,
    status: row.status,
    issuedDate: toDateOnly(row.issuedDate),
    issuedById: row.issuedById,
    pdfBlobPath: row.pdfBlobPath,
    supersedesId: row.supersedesId,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
  };
}

// ─── Payload validation ────────────────────────────────────────────────────
// Used by POST (full) and PATCH (partial). Returns { ok, data } on success,
// { ok: false, error } on failure. Caps are enforced uniformly so the wire
// contract cannot drift between create and update paths.
function validateDrawingPayload(body, { partial = false } = {}) {
  const out = {};

  if (!partial || body.projectId !== undefined) {
    if (typeof body.projectId !== 'string' || !body.projectId.trim()) {
      return { ok: false, error: 'projectId is required and must be a non-empty string' };
    }
    if (!isValidUuid(body.projectId.trim())) {
      return { ok: false, error: 'projectId must be a UUID' };
    }
    out.projectId = body.projectId.trim();
  }
  if (!partial || body.drawingNumber !== undefined) {
    if (typeof body.drawingNumber !== 'string' || !body.drawingNumber.trim()) {
      return { ok: false, error: 'drawingNumber is required and must be a non-empty string' };
    }
    out.drawingNumber = body.drawingNumber.trim();
  }
  if (!partial || body.title !== undefined) {
    if (body.title == null || body.title === '') {
      out.title = null;
    } else if (typeof body.title !== 'string') {
      return { ok: false, error: 'title must be a string' };
    } else {
      out.title = body.title.trim();
    }
  }
  if (!partial || body.revision !== undefined) {
    if (body.revision == null || body.revision === '') {
      out.revision = '0';
    } else if (typeof body.revision !== 'string') {
      return { ok: false, error: 'revision must be a string' };
    } else {
      out.revision = body.revision.trim();
    }
  }
  if (!partial || body.status !== undefined) {
    if (body.status == null || body.status === '') {
      out.status = 'ACTIVE';
    } else if (typeof body.status !== 'string' || !ALLOWED_STATUS.has(body.status)) {
      return { ok: false, error: `status must be one of: ${Array.from(ALLOWED_STATUS).join(', ')}` };
    } else {
      out.status = body.status;
    }
  }
  if (!partial || body.issuedDate !== undefined) {
    if (body.issuedDate == null || body.issuedDate === '') {
      out.issuedDate = null;
    } else {
      const p = parseStrictISODate(body.issuedDate);
      if (!p.ok) return { ok: false, error: 'issuedDate must be a valid YYYY-MM-DD' };
      out.issuedDate = p.date;
    }
  }
  if (!partial || body.issuedById !== undefined) {
    if (body.issuedById == null || body.issuedById === '') {
      out.issuedById = null;
    } else if (typeof body.issuedById !== 'string') {
      return { ok: false, error: 'issuedById must be a string' };
    } else if (!isValidUuid(body.issuedById)) {
      return { ok: false, error: 'issuedById must be a UUID' };
    } else {
      out.issuedById = body.issuedById;
    }
  }
  if (!partial || body.pdfBlobPath !== undefined) {
    if (body.pdfBlobPath == null || body.pdfBlobPath === '') {
      out.pdfBlobPath = null;
    } else if (typeof body.pdfBlobPath !== 'string') {
      return { ok: false, error: 'pdfBlobPath must be a string' };
    } else {
      out.pdfBlobPath = body.pdfBlobPath;
    }
  }
  if (!partial || body.supersedesId !== undefined) {
    if (body.supersedesId == null || body.supersedesId === '') {
      out.supersedesId = null;
    } else if (typeof body.supersedesId !== 'string') {
      return { ok: false, error: 'supersedesId must be a string' };
    } else if (!isValidUuid(body.supersedesId)) {
      return { ok: false, error: 'supersedesId must be a UUID' };
    } else {
      out.supersedesId = body.supersedesId;
    }
  }

  // Length caps (run AFTER the type coercion so the trimmed/normalized
  // string is what we cap).
  for (const [k, cap] of Object.entries(FIELD_MAX)) {
    if (out[k] != null && typeof out[k] === 'string' && out[k].length > cap) {
      return { ok: false, error: `${k} exceeds ${cap} chars` };
    }
  }
  return { ok: true, data: out };
}

// All authenticated employees can read the register. Same auth gate as
// projects — the drawing picker is a regular form field on the DPR /
// Inspection submit screens.
router.use(requireAuth);

// ─── GET /api/drawings ──────────────────────────────────────────────────────
// List with optional filters. Cursor-paginated by (issuedDate DESC, id DESC)
// so the most recently issued revisions surface first — matches the typical
// PM workflow ("show me what was issued this week").
//
// Query params:
//   projectId    — required-feel: returns 400 when omitted so the register
//                  isn't accidentally walked without a project scope.
//                  Admins may pass it; employees never need a global view.
//   status       — 'ACTIVE' (default) | 'SUPERSEDED' | 'ALL'
//   limit        — default 20, max 100
//   cursor       — opaque token from a previous response's nextCursor
router.get('/', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  if (!prisma) {
    return res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });
  }

  const { projectId, status: statusFilter, limit = '20', cursor } = req.query;
  const take = Math.min(parseInt(limit) || 20, 100);

  if (!projectId || typeof projectId !== 'string' || !projectId.trim()) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      code: 'PROJECT_REQUIRED',
      message: 'projectId query parameter is required',
    });
  }
  if (!isValidUuid(projectId.trim())) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      code: 'VALIDATION_ERROR',
      message: 'projectId must be a UUID',
    });
  }

  // status filter — 'ALL' bypasses the status predicate so the admin
  // supersede-management UI can render history.
  let statusWhere = { status: 'ACTIVE' };
  if (statusFilter === 'SUPERSEDED') statusWhere = { status: 'SUPERSEDED' };
  else if (statusFilter === 'ALL') statusWhere = {};

  // Cursor decode — DR-008 codec gives us (date, id). For drawings we key
  // on issuedDate (date-only, matching the @db.Date column) and id.
  let cursorWhere = {};
  if (cursor) {
    let decoded;
    try {
      decoded = decodeCursor(cursor);
    } catch (e) {
      if (e instanceof InvalidCursorError) {
        return res.status(400).json({ error: 'INVALID_CURSOR', message: e.message });
      }
      return res.status(400).json({ error: 'INVALID_CURSOR', message: 'Cursor could not be decoded' });
    }
    // Half-open (issuedDate < decoded) OR (issuedDate = decoded AND id < decoded.id).
    cursorWhere = {
      OR: [
        { issuedDate: { lt: decoded.date } },
        { issuedDate: decoded.date, id: { lt: decoded.id } },
      ],
    };
  }

  const where = {
    projectId: projectId.trim(),
    ...statusWhere,
    ...(cursor ? cursorWhere : {}),
  };

  try {
    const rows = await prisma.drawing.findMany({
      where,
      orderBy: [{ issuedDate: 'desc' }, { id: 'desc' }],
      take: take + 1,
    });

    const hasMore = rows.length > take;
    const items = (hasMore ? rows.slice(0, -1) : rows).map(serializeDrawing);

    // Reference count: how many DPR + Inspection rows point at each drawing.
    // Done as one aggregate per drawing (cheap — these are zero-fan-out
    // counts against indexed columns). Could be done as a single grouped
    // query, but the admin list is small (<=100 rows) and N+1 here is well
    // bounded.
    const withCounts = await Promise.all(items.map(async (d) => {
      try {
        const [dprCount, inspCount] = await Promise.all([
          prisma.dPR.count({ where: { drawingId: d.id } }),
          prisma.inspectionRecord.count({ where: { drawingId: d.id } }),
        ]);
        return { ...d, referencedByCount: dprCount + inspCount };
      } catch (err) {
        // Forward-compat: if the dPR / inspectionRecord models ever throw
        // (e.g. mid-migration), fall back to zero count so the list still
        // renders. Mirrors the defensive wrapping in projects.js.
        console.warn('Drawing reference count failed', {
          drawingId: d.id,
          prismaCode: err.code,
          message: err.message?.split('\n')[0],
        });
        return { ...d, referencedByCount: 0 };
      }
    }));

    let nextCursor = null;
    const lastItem = withCounts[withCounts.length - 1];
    if (hasMore && lastItem) {
      try {
        // issuedDate is @db.Date — serialize the JS Date (UTC midnight)
        // back to its calendar day for the cursor payload.
        const dateForCursor = lastItem.issuedDate
          ? new Date(`${lastItem.issuedDate}T00:00:00.000Z`)
          : new Date(0); // issuedDate-asc fallback for legacy rows
        nextCursor = encodeCursor(dateForCursor, lastItem.id);
      } catch (e) {
        console.error('Drawing cursor encode failed', { err: e.message });
        nextCursor = null;
      }
    }

    res.setHeader('X-Total-Count', withCounts.length);
    res.setHeader('X-Has-More', hasMore ? 'true' : 'false');
    res.json({ drawings: withCounts, nextCursor });
  } catch (err) {
    console.error('Drawings list error', {
      employeeHash: hashIdentifier(req.employeeId),
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to fetch drawings' });
  }
}));

// ─── POST /api/drawings ─────────────────────────────────────────────────────
// Admin-curated create. Atomic with the supersedes flip: if `supersedesId`
// is supplied, the prior row is updated to status=SUPERSEDED inside the same
// transaction as the new-row insert, and a cross-project supersedes is
// rejected with 400 before any DB write.
//
// Auth: requireAuth (Round-31 — was requireFreshAdmin before this round).
// Auto-stamps `issuedById = req.employeeId` when omitted so the new
// drawing's audit column is meaningful for the Round-30 ?scope=assigned
// union (Drawing.issuedById) — without this, employee-uploaded drawings
// would silently not push their project into the employee's picker.
router.post('/', requireAuth, asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  if (!prisma) {
    return res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });
  }

  const v = validateDrawingPayload(req.body || {});
  if (!v.ok) {
    return res.status(400).json({ error: v.error, code: 'VALIDATION_ERROR' });
  }
  const data = v.data;

  // Verify project exists + is active. Archive policy mirrors Project: a
  // drawing cannot be created against an inactive project.
  const project = await prisma.project.findUnique({
    where: { id: data.projectId },
    select: { id: true, isActive: true },
  });
  if (!project) {
    return res.status(400).json({ error: 'PROJECT_NOT_FOUND', code: 'PROJECT_NOT_FOUND', message: 'Linked project does not exist' });
  }
  if (!project.isActive) {
    return res.status(400).json({ error: 'PROJECT_INACTIVE', code: 'PROJECT_INACTIVE', message: 'Linked project is archived (isActive=false)' });
  }

  // issuedById is optional; when omitted we auto-stamp the requesting
  // employee (Round-31 — so employee-uploaded drawings have a meaningful
  // audit column for the ?scope=assigned union). When supplied it must
  // reference an existing employee (SetNull on FK does not gate the
  // initial write, so we have to check explicitly).
  if (!data.issuedById) {
    data.issuedById = req.employeeId;
  } else if (data.issuedById !== req.employeeId) {
    // Allow admin to issue on behalf of another employee (existing admin
    // behavior) — but only if the target is a real employee. For a
    // non-admin caller the body must match their own id (defense against
    // a malicious employee forging an issuedById for someone else).
    if (!req.isAdmin) {
      return res.status(403).json({
        error: 'CANNOT_ISSUE_ON_BEHALF',
        code: 'CANNOT_ISSUE_ON_BEHALF',
        message: 'Only admins may set issuedById to a different employee',
      });
    }
    const issuer = await prisma.employee.findUnique({
      where: { id: data.issuedById },
      select: { id: true },
    });
    if (!issuer) {
      return res.status(400).json({ error: 'ISSUER_NOT_FOUND', code: 'ISSUER_NOT_FOUND', message: 'issuedById does not match any employee' });
    }
  }

  // Cross-project supersedes guard: the row we're superseding must belong
  // to the same project. Done OUTSIDE the transaction so a malformed
  // payload returns 400 before we touch any rows.
  if (data.supersedesId) {
    const predecessor = await prisma.drawing.findUnique({
      where: { id: data.supersedesId },
      select: { id: true, projectId: true, status: true },
    });
    if (!predecessor) {
      return res.status(400).json({ error: 'PREDECESSOR_NOT_FOUND', code: 'PREDECESSOR_NOT_FOUND', message: 'supersedesId does not match any drawing' });
    }
    if (predecessor.projectId !== data.projectId) {
      return res.status(400).json({
        error: 'PREDECESSOR_PROJECT_MISMATCH',
        code: 'PREDECESSOR_PROJECT_MISMATCH',
        message: 'supersedesId belongs to a different project',
      });
    }
  }

  try {
    const drawing = await prisma.$transaction(async (tx) => {
      // Flip the predecessor to SUPERSEDED inside the same transaction so
      // an admin can't end up with two ACTIVE rows for the same
      // (project, drawingNumber).
      if (data.supersedesId) {
        await tx.drawing.update({
          where: { id: data.supersedesId },
          data: { status: 'SUPERSEDED' },
        });
      }
      // Mint the id server-side so the Prisma client doesn't try to use
      // @default(uuid()) against a non-standard client config.
      return tx.drawing.create({
        data: {
          id: randomUUID(),
          projectId: data.projectId,
          drawingNumber: data.drawingNumber,
          title: data.title,
          revision: data.revision,
          status: data.status,
          issuedDate: data.issuedDate,
          issuedById: data.issuedById,
          pdfBlobPath: data.pdfBlobPath,
          supersedesId: data.supersedesId,
        },
      });
    });

    res.status(201).json(serializeDrawing(drawing));
  } catch (err) {
    console.error('Drawings create error', {
      employeeHash: hashIdentifier(req.employeeId),
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to create drawing' });
  }
}));

// ─── GET /api/drawings/:id ──────────────────────────────────────────────────
// Detail with reference counts + supersedes chain (recursively, capped at
// depth 5) + list of DPRs / Inspections that reference it (for the "stamp"
// UI that warns an admin about to supersede a drawing).
router.get('/:id', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  if (!prisma) {
    return res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });
  }

  const { id } = req.params;
  if (!isValidUuid(id)) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Drawing id must be a UUID' });
  }

  try {
    const row = await prisma.drawing.findUnique({
      where: { id },
    });
    if (!row) {
      return res.status(404).json({ error: 'DRAWING_NOT_FOUND', code: 'DRAWING_NOT_FOUND', message: 'Drawing not found' });
    }

    // Walk the supersedes chain (recursive, max depth 5 — defends against
    // a corrupted chain, e.g. a 1↔2 cycle that would otherwise infinite-
    // loop the route). We walk in JS rather than a CTE because Prisma's
    // raw SQL surface for this is awkward and the chain is short in
    // practice (<=10 revisions per drawing).
    const supersedesChain = [];
    let walkCursor = row.supersedesId;
    let depth = 0;
    while (walkCursor && depth < 5) {
      // eslint-disable-next-line no-await-in-loop
      const prev = await prisma.drawing.findUnique({
        where: { id: walkCursor },
        select: { id: true, drawingNumber: true, revision: true, status: true, issuedDate: true, supersedesId: true },
      });
      if (!prev) break;
      supersedesChain.push({
        id: prev.id,
        drawingNumber: prev.drawingNumber,
        revision: prev.revision,
        status: prev.status,
        issuedDate: toDateOnly(prev.issuedDate),
      });
      walkCursor = prev.supersedesId;
      depth++;
    }

    // Reference list — bounded for the stamp UI. The admin would never
    // need more than 50 examples on a single page; if a drawing has
    // >50 references the UI can hit a dedicated endpoint.
    const [referencedByDprs, referencedByInspections] = await Promise.all([
      prisma.dPR.findMany({
        where: { drawingId: id },
        orderBy: [{ reportDate: 'desc' }],
        take: 50,
        select: { id: true, reportDate: true, projectName: true, status: true },
      }).catch((err) => {
        console.warn('Drawing → DPR list failed', { drawingId: id, prismaCode: err.code });
        return [];
      }),
      prisma.inspectionRecord.findMany({
        where: { drawingId: id },
        orderBy: [{ reportDate: 'desc' }],
        take: 50,
        select: { id: true, reportDate: true, projectName: true, inspectionType: true, status: true },
      }).catch((err) => {
        console.warn('Drawing → inspection list failed', { drawingId: id, prismaCode: err.code });
        return [];
      }),
    ]);

    res.json({
      ...serializeDrawing(row),
      referencedByCount: referencedByDprs.length + referencedByInspections.length,
      referencedBy: {
        dprs: referencedByDprs.map((d) => ({
          id: d.id,
          reportDate: toDateOnly(d.reportDate),
          projectName: d.projectName,
          status: d.status,
        })),
        inspections: referencedByInspections.map((i) => ({
          id: i.id,
          reportDate: toDateOnly(i.reportDate),
          projectName: i.projectName,
          inspectionType: i.inspectionType,
          status: i.status,
        })),
      },
      supersedesChain,
    });
  } catch (err) {
    console.error('Drawing detail error', {
      employeeHash: hashIdentifier(req.employeeId),
      drawingId: id,
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to fetch drawing' });
  }
}));

// ─── GET /api/drawings/:id/read-sas ────────────────────────────────────────
// Mint a short-lived signed GET URL for the drawing's PDF so the admin
// DrawingDetail page can render the file in an <iframe>. Same auth gate as
// the detail endpoint (`requireAuth` is mounted earlier — every auth'd
// employee can consult the register from the DPR/Inspection submit's
// drawing picker, so they get the read-SAS too).
//
// Container is hard-coded to 'dpr-documents' because drawings share the
// curated non-photo evidence bucket that DPR/Inspection generated PDFs
// also use (see file header comment + the /api/dpr/sas-url allowlist
// set in dpr.js:347). The drawing's stored pdfBlobPath field is the
// blob name (e.g. "EMP123/01HF7X3YRAKO.pdf"); the client received it
// verbatim from /api/dpr/sas-url at upload time.
//
// 200  → { sasUrl, expiresIn }   (1-hour TTL by default — see blobStorage DR-017)
// 400  → VALIDATION_ERROR        (bad UUID, missing pdfBlobPath)
// 404  → DRAWING_NOT_FOUND
// 503  → DB_UNAVAILABLE
router.get('/:id/read-sas', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  if (!prisma) {
    return res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });
  }

  const { id } = req.params;
  if (!isValidUuid(id)) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Drawing id must be a UUID' });
  }

  try {
    const row = await prisma.drawing.findUnique({ where: { id }, select: { pdfBlobPath: true } });
    if (!row) {
      return res.status(404).json({ error: 'DRAWING_NOT_FOUND', code: 'DRAWING_NOT_FOUND', message: 'Drawing not found' });
    }
    if (!row.pdfBlobPath || typeof row.pdfBlobPath !== 'string') {
      // Caller distinguishes this state in the UI ("no-pdf") so they
      // don't render an empty iframe on a drawing that has no upload.
      return res.status(400).json({
        error: 'NO_PDF_ATTACHED',
        code: 'NO_PDF_ATTACHED',
        message: 'This drawing does not have a PDF attached yet.',
      });
    }

    const { sasUrl } = await generateReadSASUrl('dpr-documents', row.pdfBlobPath);
    res.json({ sasUrl, expiresIn: READ_URL_TTL_SECONDS });
  } catch (err) {
    console.error('Drawing read-SAS error', {
      employeeHash: hashIdentifier(req.employeeId),
      drawingId: id,
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to mint read URL' });
  }
}));

// ─── PATCH /api/drawings/:id ────────────────────────────────────────────────
// Admin-only metadata update. Cannot change projectId / drawingNumber /
// revision — those are the natural key, and changing them would silently
// orphan the references. To "rename" a drawing, supersede it with a new
// drawingNumber instead. To change the project, delete + recreate.
router.patch('/:id', requireFreshAdmin, asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  if (!prisma) {
    return res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });
  }

  const { id } = req.params;
  if (!isValidUuid(id)) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Drawing id must be a UUID' });
  }

  const v = validateDrawingPayload(req.body || {}, { partial: true });
  if (!v.ok) {
    return res.status(400).json({ error: v.error, code: 'VALIDATION_ERROR' });
  }
  const data = v.data;

  // Guardrail: the natural key + cross-table pointer are immutable. Allow
  // every other field on the model.
  const ALLOWED_PATCH_FIELDS = ['title', 'status', 'issuedDate', 'issuedById', 'pdfBlobPath'];
  const unknown = Object.keys(req.body || {}).filter(k => !ALLOWED_PATCH_FIELDS.includes(k));
  if (unknown.length) {
    return res.status(400).json({
      error: 'UNKNOWN_FIELDS',
      message: `Fields not allowed: ${unknown.join(', ')}`,
      fields: unknown,
    });
  }

  try {
    const existing = await prisma.drawing.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'DRAWING_NOT_FOUND', code: 'DRAWING_NOT_FOUND', message: 'Drawing not found' });
    }
    // If the row is already SUPERSEDED, only allow title / pdfBlobPath /
    // status updates so the admin can correct metadata without
    // resurrecting an old revision.
    if (existing.status === 'SUPERSEDED' && (data.status === 'ACTIVE' || data.issuedDate !== undefined || data.issuedById !== undefined)) {
      return res.status(409).json({
        error: 'DRAWING_SUPERSEDED',
        code: 'DRAWING_SUPERSEDED',
        message: 'Cannot resurrect a superseded drawing; create a new revision instead',
      });
    }

    const updated = await prisma.drawing.update({
      where: { id },
      data: {
        title: data.title !== undefined ? data.title : existing.title,
        status: data.status !== undefined ? data.status : existing.status,
        issuedDate: data.issuedDate !== undefined ? data.issuedDate : existing.issuedDate,
        issuedById: data.issuedById !== undefined ? data.issuedById : existing.issuedById,
        pdfBlobPath: data.pdfBlobPath !== undefined ? data.pdfBlobPath : existing.pdfBlobPath,
      },
    });
    res.json(serializeDrawing(updated));
  } catch (err) {
    console.error('Drawing update error', {
      employeeHash: hashIdentifier(req.employeeId),
      drawingId: id,
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to update drawing' });
  }
}));

// ─── DELETE /api/drawings/:id ──────────────────────────────────────────────
// Admin-only soft-delete via status=SUPERSEDED. Idempotent: a second
// DELETE on an already-SUPERSEDED drawing is a no-op success (matches the
// projects.js DELETE convention).
router.delete('/:id', requireFreshAdmin, asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  if (!prisma) {
    return res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });
  }

  const { id } = req.params;
  if (!isValidUuid(id)) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Drawing id must be a UUID' });
  }

  try {
    const existing = await prisma.drawing.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'DRAWING_NOT_FOUND', code: 'DRAWING_NOT_FOUND', message: 'Drawing not found' });
    }
    if (existing.status === 'SUPERSEDED') {
      // Idempotent
      return res.json(serializeDrawing(existing));
    }
    const updated = await prisma.drawing.update({
      where: { id },
      data: { status: 'SUPERSEDED' },
    });
    res.json(serializeDrawing(updated));
  } catch (err) {
    console.error('Drawing delete error', {
      employeeHash: hashIdentifier(req.employeeId),
      drawingId: id,
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to delete drawing' });
  }
}));

module.exports = router;
