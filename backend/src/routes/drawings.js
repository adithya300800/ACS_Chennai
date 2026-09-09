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
//   POST   /api/drawings/:id/supersede  explicit supersede (admin) — DR-002
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
//     with 400) and the predecessor must be in ACTIVE state (otherwise
//     409 PREDECESSOR_NOT_ACTIVE — DR-002).
//   - POST /api/drawings/:id/supersede is the explicit, admin-only
//     supersede command the Drawing Detail page's "Supersede" button
//     calls (DR-002). It reads the predecessor inside the transaction so
//     the ACTIVE check is atomic with the flip + successor insert; the
//     successor inherits (projectId, drawingNumber, issuedById) from the
//     predecessor and accepts optional title/issuedDate/pdfBlobPath
//     overrides; revision is required. Returns { successor, predecessor }
//     in their post-commit state.
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
// [DR-001] Reuse the S3-7 + DR-006 binding primitives — they are about
// upload intents, not literally photos, even though the function names
// carry the photo terminology. The single `pdfBlobPath` field is wrapped
// as a one-element `photos` array at the call site so the helpers' array
// shape doesn't need a parallel "single" API.
const {
  validatePhotoIntents,
  assertPhotoIntentsBindable,
  bindPhotoIntentsTx,
  withRecordTransaction,
  photoBindingLostResponse,
} = require('../lib/uploadIntentBinding');

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
  // [DR-001] Crockford base32 ULIDs are 26 chars; 30 leaves headroom for
  // any future prefix scheme without forcing a schema change.
  uploadIntentUlid: 30,
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
    // [DR-001] Internal: ulid of the UploadIntent row that vouched for
    // `pdfBlobPath`. Echoed back to the client so the round-trip is
    // traceable end-to-end; not used by the React UI yet.
    uploadIntentUlid: row.uploadIntentUlid,
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
  // [DR-001] Optional — ulid of the UploadIntent row that vouched for
  // `pdfBlobPath`. Only meaningful when pdfBlobPath is supplied; rejected
  // otherwise so the column never carries a stale reference to a
  // blob that no longer exists on this row.
  if (!partial || body.uploadIntentUlid !== undefined) {
    if (body.uploadIntentUlid == null || body.uploadIntentUlid === '') {
      out.uploadIntentUlid = null;
    } else if (typeof body.uploadIntentUlid !== 'string') {
      return { ok: false, error: 'uploadIntentUlid must be a string' };
    } else {
      out.uploadIntentUlid = body.uploadIntentUlid;
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
  //
  // [DR-022] The codec now carries null dates (Drawing.issuedDate is a
  // nullable `@db.Date` column). With NULLS LAST in the ordering, a
  // null-cursor means "previous page ended in the null tail"; the seek
  // predicate for that case narrows to `(issuedDate IS NULL AND id <
  // cursor.id)`. For non-null cursors the seek stays the classic two-
  // branch keyset form.
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
    if (decoded.date === null) {
      cursorWhere = { issuedDate: null, id: { lt: decoded.id } };
    } else {
      // [DR-019] Include the trailing null bucket in the seek from any
      // non-null cursor. With NULLS LAST ordering, every null row sits
      // after the last non-null row; without this third branch a full
      // dated page (e.g. 20 rows for 2026-09-08) leaves the null tail
      // unreachable because `null < non-null-date` is FALSE in SQL.
      // The previous seek only fired the first two branches, so a
      // project with N dated rows + M null rows had its M null rows
      // permanently stuck at the bottom of page 1.
      cursorWhere = {
        OR: [
          { issuedDate: null },
          { issuedDate: { lt: decoded.date } },
          { issuedDate: decoded.date, id: { lt: decoded.id } },
        ],
      };
    }
  }

  const where = {
    projectId: projectId.trim(),
    ...statusWhere,
    ...(cursor ? cursorWhere : {}),
  };

  try {
    const rows = await prisma.drawing.findMany({
      where,
      // [DR-022] NULLS LAST — legacy rows whose `issuedDate` was never
      // stamped still surface, but at the END of the list rather than
      // silently first. Without `nulls: 'last'`, Postgres sorts nulls
      // first under DESC and the first 20 rows of every list are nulls;
      // the cursor then encodes Date(0) and the seek predicate
      // (`issuedDate < Date(0)`) matches nothing on the next page —
      // null rows were unreachable. With NULLS LAST, the cursor can
      // carry `date: null` into the seek and the null tail stays
      // scrollable.
      orderBy: [{ issuedDate: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
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
        // [DR-022] Carry `null` through to the codec so the next page's
        // seek predicate can stay in the null bucket. The previous
        // fallback coerced null to `Date(0)` which broke the seek
        // (Postgres never matches `issuedDate < 1970-01-01`).
        nextCursor = encodeCursor(lastItem.issuedDate || null, lastItem.id);
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
  // to the same project and be in ACTIVE state. Done OUTSIDE the
  // transaction so a malformed payload returns 400/409 before we touch
  // any rows. The ACTIVE-state check (DR-002) is what stops a stale or
  // already-superseded predecessor from being silently bundled into a
  // fresh issuance.
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
    if (predecessor.status !== 'ACTIVE') {
      return res.status(409).json({
        error: 'PREDECESSOR_NOT_ACTIVE',
        code: 'PREDECESSOR_NOT_ACTIVE',
        message: `Cannot supersede a drawing in status ${predecessor.status}`,
        currentStatus: predecessor.status,
      });
    }
  }

  // [DR-001] Validate the upload intent BEFORE we touch any rows. The
  // helper takes a `photos` array but only reads `p.ulid` from each
  // entry, so a single-element array is the right adapter shape — no
  // parallel "single-ulid" helper needed.
  //
  // Skip when no pdfBlobPath was supplied: a drawing without an
  // attachment never needs an intent claim. Also skip when the client
  // omitted uploadIntentUlid (legacy clients uploading through the old
  // 4-step pipeline don't know about the column yet — they POST with a
  // bare blobPath; the sweep's referenced-blobPath defence covers them
  // until they upgrade).
  let intentWrapper = null;
  if (data.pdfBlobPath && data.uploadIntentUlid) {
    intentWrapper = [{ ulid: data.uploadIntentUlid }];
    // [DR-001] Path/container equality check — drawings always upload
    // to `dpr-documents` (see blobStorage.js#91), so the intent MUST
    // claim that same bucket AND that exact blobPath. Without this,
    // an admin could reuse another intent that happens to belong to
    // them but lives in a different bucket/key.
    const intentErr = await validatePhotoIntents({
      prisma,
      employeeId: req.employeeId,
      photos: intentWrapper,
      context: 'drawing.create',
      expectedContainer: 'dpr-documents',
      expectedBlobPath: data.pdfBlobPath,
    });
    if (intentErr) return res.status(intentErr.status).json(intentErr.body);
  }

  try {
    // [DR-001] Use the same `withRecordTransaction` driver as dpr.js so
    // the create + intent claim are one tx. If the sweep retired the
    // intent between validate and here, `assertPhotoIntentsBindable`
    // re-asserts the CONFIRMED predicate under the tx snapshot and the
    // bind updateMany hits 0 rows → we throw `PhotoBindingLostError` →
    // the whole tx rolls back, no half-saved drawing.
    const drawing = await withRecordTransaction(prisma, 'drawing', async (db) => {
      if (intentWrapper) {
        await assertPhotoIntentsBindable({
          tx: db,
          employeeId: req.employeeId,
          photos: intentWrapper,
          expectedContainer: 'dpr-documents',
          expectedBlobPath: data.pdfBlobPath,
        });
      }

      // [DR-009] Claim the predecessor with a conditional update so two
      // concurrent supersedes cannot both succeed. The `where` requires
      // id + projectId + status='ACTIVE' — Prisma's `update` does not
      // accept extra keys in its `where`, so we use `updateMany` (returns
      // a count, not the row) and require count==1. On a lost race we
      // throw so the whole tx rolls back, including the successor
      // create/bind below — the predecessor stays ACTIVE for whichever
      // sibling tx actually won the claim.
      if (data.supersedesId) {
        const claim = await db.drawing.updateMany({
          where: {
            id: data.supersedesId,
            projectId: data.projectId,
            status: 'ACTIVE',
          },
          data: { status: 'SUPERSEDED' },
        });
        if (claim.count !== 1) {
          throw Object.assign(new Error('Predecessor claim lost'), {
            code: 'PREDECESSOR_CLAIM_LOST',
            predecessorId: data.supersedesId,
          });
        }
      }
      // Mint the id server-side so the Prisma client doesn't try to use
      // @default(uuid()) against a non-standard client config.
      const created = await db.drawing.create({
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
          // [DR-001] Stamp the ulid verbatim so the sweep's
          // referenced-ulid defence can find this row. NULL for
          // uploads that bypassed /sas-url (legacy clients).
          uploadIntentUlid: data.uploadIntentUlid || null,
          supersedesId: data.supersedesId,
        },
      });

      if (intentWrapper) {
        await bindPhotoIntentsTx({
          tx: db,
          employeeId: req.employeeId,
          photos: intentWrapper,
          boundType: 'drawing',
          recordId: created.id,
          expectedContainer: 'dpr-documents',
          expectedBlobPath: data.pdfBlobPath,
        });
      }

      return created;
    });

    res.status(201).json(serializeDrawing(drawing));
  } catch (err) {
    // [DR-001] Lost upload claim → 409, never 500. Mirrors the dpr.js
    // contract — the client knows what to do (re-upload) and the audit
    // gets a clean signal that the upload pipeline raced the sweep.
    const bindingLost = photoBindingLostResponse(err);
    if (bindingLost) {
      console.warn('Drawing create rolled back — upload binding lost', {
        employeeHash: hashIdentifier(req.employeeId),
        expected: err.expected,
        bound: err.bound,
      });
      return res.status(bindingLost.status).json(bindingLost.body);
    }
    // [DR-009] Concurrent supersede lost the race — another sibling tx
    // already claimed the predecessor's ACTIVE status. Translate to
    // 409 PREDECESSOR_NOT_ACTIVE so the client gets the same error it
    // would have seen from the pre-transaction guard.
    if (err && err.code === 'PREDECESSOR_CLAIM_LOST') {
      console.warn('Drawing create rolled back — predecessor claim lost', {
        employeeHash: hashIdentifier(req.employeeId),
        predecessorId: err.predecessorId,
      });
      return res.status(409).json({
        error: 'PREDECESSOR_NOT_ACTIVE',
        code: 'PREDECESSOR_NOT_ACTIVE',
        message: 'Predecessor was superseded by a concurrent request',
      });
    }
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
  const ALLOWED_PATCH_FIELDS = ['title', 'status', 'issuedDate', 'issuedById', 'pdfBlobPath', 'uploadIntentUlid'];
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

    // [DR-009] When PATCH tries to restore ACTIVE, do a conditional
    // claim so a stale PATCH cannot resurrect a row that was
    // superseded between our read and our write. Also reject when
    // another ACTIVE row already exists for the same drawingNumber in
    // the same project — the natural-key uniqueness on
    // (projectId, drawingNumber, revision) does not catch this
    // because different revisions can both be ACTIVE for the same
    // drawingNumber. Without this guard, two ACTIVE successors from a
    // concurrent race would persist.
    if (data.status === 'ACTIVE') {
      const guarded = await prisma.$transaction(async (tx) => {
        // No other ACTIVE row for the same drawingNumber in this project.
        const siblingActive = await tx.drawing.findFirst({
          where: {
            projectId: existing.projectId,
            drawingNumber: existing.drawingNumber,
            status: 'ACTIVE',
            id: { not: existing.id },
          },
          select: { id: true },
        });
        if (siblingActive) {
          return { error: {
            status: 409,
            body: {
              error: 'ANOTHER_ACTIVE_REVISION',
              code: 'ANOTHER_ACTIVE_REVISION',
              message: `Drawing ${existing.drawingNumber} already has an active revision`,
              currentActiveId: siblingActive.id,
            },
          } };
        }
        // Conditional update — require the row to still NOT be
        // SUPERSEDED. If a concurrent supersede flipped it after our
        // read, count=0 and we refuse the restore.
        const claim = await tx.drawing.updateMany({
          where: {
            id: existing.id,
            projectId: existing.projectId,
            status: { not: 'SUPERSEDED' },
          },
          data: {
            title: data.title !== undefined ? data.title : existing.title,
            status: 'ACTIVE',
            issuedDate: data.issuedDate !== undefined ? data.issuedDate : existing.issuedDate,
            issuedById: data.issuedById !== undefined ? data.issuedById : existing.issuedById,
            pdfBlobPath: data.pdfBlobPath !== undefined ? data.pdfBlobPath : existing.pdfBlobPath,
            uploadIntentUlid: data.uploadIntentUlid !== undefined ? data.uploadIntentUlid : existing.uploadIntentUlid,
          },
        });
        if (claim.count !== 1) {
          return { error: {
            status: 409,
            body: {
              error: 'DRAWING_SUPERSEDED',
              code: 'DRAWING_SUPERSEDED',
              message: 'Cannot resurrect a superseded drawing; create a new revision instead',
            },
          } };
        }
        const reloaded = await tx.drawing.findUnique({ where: { id: existing.id } });
        return { drawing: reloaded };
      });
      if (guarded.error) {
        return res.status(guarded.error.status).json(guarded.error.body);
      }
      return res.json(serializeDrawing(guarded.drawing));
    }

    const updated = await prisma.drawing.update({
      where: { id },
      data: {
        title: data.title !== undefined ? data.title : existing.title,
        status: data.status !== undefined ? data.status : existing.status,
        issuedDate: data.issuedDate !== undefined ? data.issuedDate : existing.issuedDate,
        issuedById: data.issuedById !== undefined ? data.issuedById : existing.issuedById,
        pdfBlobPath: data.pdfBlobPath !== undefined ? data.pdfBlobPath : existing.pdfBlobPath,
        // [DR-001] PATCH-time intent swap: when pdfBlobPath is being
        // replaced, the new uploadIntentUlid (if supplied) is stamped
        // verbatim. The create-time intent is left alone — the blob
        // behind it is now orphaned by the PDF swap, and the sweep's
        // CONFIRMED-orphan pass will reclaim it after its grace window.
        // We do NOT claim the new intent inside this PATCH transaction:
        // the row already exists and binding failures must not turn
        // into 500s. The intent is still CONFIRMED + boundAt=NULL; the
        // sweep retires it gracefully on its next fire.
        uploadIntentUlid: data.uploadIntentUlid !== undefined ? data.uploadIntentUlid : existing.uploadIntentUlid,
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

// ─── POST /api/drawings/:id/supersede ───────────────────────────────────────
//
// DR-002 — explicit supersede command. Creates a NEW drawing row that
// supersedes the predecessor identified in the URL, atomically flipping
// the predecessor to status=SUPERSEDED. The previous POST /api/drawings
// path with `supersedesId` is a side-effect of fresh issuance (any
// employee can hit it, Round-31) and remains in place for that flow;
// this endpoint is the curation path that the admin Drawing Detail
// page's "Supersede" button calls — and it is the only path that
// guarantees the predecessor is in ACTIVE state before flipping it
// (a stale or wrong-state predecessor is rejected with 409).
//
// Body:
//   revision    — required, non-empty string (≤20 chars)
//   title       — optional override (defaults to predecessor's title)
//   issuedDate  — optional override (defaults to predecessor's issuedDate)
//   pdfBlobPath — optional override (defaults to predecessor's pdfBlobPath)
//
// Inherited (NOT accepted in body — natural-key + audit columns):
//   projectId, drawingNumber  →  carried forward from predecessor
//   issuedById                →  carried forward (the issuer of record is
//                                 the original author, not the admin who
//                                 pressed the button; PATCH /:id if you
//                                 need to reissue on behalf of someone else)
//
// 201 → { successor, predecessor }   both rows in their post-commit state
// 400 → VALIDATION_ERROR             bad UUID / missing revision / caps
// 404 → DRAWING_NOT_FOUND            unknown predecessor
// 409 → PREDECESSOR_NOT_ACTIVE       predecessor in status != ACTIVE
// 409 → DUPLICATE_REVISION           (project, drawingNumber, revision)
//                                    collision — the natural-key constraint
router.post('/:id/supersede', requireFreshAdmin, asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  if (!prisma) {
    return res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });
  }

  const { id } = req.params;
  if (!isValidUuid(id)) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Drawing id must be a UUID' });
  }

  const body = req.body || {};

  // revision is required (and bounded). title / issuedDate / pdfBlobPath
  // are optional overrides — each is validated to the same caps the
  // regular POST/PATCH enforce.
  if (typeof body.revision !== 'string' || !body.revision.trim()) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      code: 'REVISION_REQUIRED',
      message: 'revision is required and must be a non-empty string',
    });
  }
  const revision = body.revision.trim();
  if (revision.length > FIELD_MAX.revision) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: `revision exceeds ${FIELD_MAX.revision} chars`,
    });
  }

  let titleOverride;
  if (body.title !== undefined) {
    if (body.title === null || body.title === '') {
      titleOverride = null;
    } else if (typeof body.title !== 'string') {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'title must be a string' });
    } else if (body.title.length > FIELD_MAX.title) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: `title exceeds ${FIELD_MAX.title} chars` });
    } else {
      titleOverride = body.title.trim();
    }
  }

  let issuedDateValue;
  if (body.issuedDate !== undefined) {
    if (body.issuedDate === null || body.issuedDate === '') {
      issuedDateValue = null;
    } else {
      const p = parseStrictISODate(body.issuedDate);
      if (!p.ok) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'issuedDate must be a valid YYYY-MM-DD' });
      issuedDateValue = p.date;
    }
  }

  let pdfBlobPathOverride;
  if (body.pdfBlobPath !== undefined) {
    if (body.pdfBlobPath === null || body.pdfBlobPath === '') {
      pdfBlobPathOverride = null;
    } else if (typeof body.pdfBlobPath !== 'string') {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'pdfBlobPath must be a string' });
    } else if (body.pdfBlobPath.length > FIELD_MAX.pdfBlobPath) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: `pdfBlobPath exceeds ${FIELD_MAX.pdfBlobPath} chars` });
    } else {
      pdfBlobPathOverride = body.pdfBlobPath;
    }
  }

  try {
    // Read the predecessor INSIDE the transaction so the ACTIVE check is
    // atomic with the flip — no TOCTOU window between the status read
    // and the update.
    const result = await prisma.$transaction(async (tx) => {
      const predecessor = await tx.drawing.findUnique({ where: { id } });
      if (!predecessor) {
        return { error: { status: 404, body: { error: 'DRAWING_NOT_FOUND', code: 'DRAWING_NOT_FOUND', message: 'Predecessor drawing not found' } } };
      }
      if (predecessor.status !== 'ACTIVE') {
        return {
          error: {
            status: 409,
            body: {
              error: 'PREDECESSOR_NOT_ACTIVE',
              code: 'PREDECESSOR_NOT_ACTIVE',
              message: `Cannot supersede a drawing in status ${predecessor.status}`,
              currentStatus: predecessor.status,
            },
          },
        };
      }

      // Mint the new id server-side (matches the POST convention so the
      // Prisma client doesn't try to use @default(uuid()) against a
      // non-standard client config).
      const successor = await tx.drawing.create({
        data: {
          id: randomUUID(),
          projectId: predecessor.projectId,
          drawingNumber: predecessor.drawingNumber,
          title: titleOverride !== undefined ? titleOverride : predecessor.title,
          revision,
          status: 'ACTIVE',
          issuedDate: issuedDateValue !== undefined ? issuedDateValue : predecessor.issuedDate,
          issuedById: predecessor.issuedById,
          pdfBlobPath: pdfBlobPathOverride !== undefined ? pdfBlobPathOverride : predecessor.pdfBlobPath,
          supersedesId: predecessor.id,
        },
      });

      // [DR-009] Conditional ACTIVE claim — the predecessor's status
      // check is folded into the `where` so two concurrent supersedes
      // can't both succeed. `update` only accepts `id` in `where`, so
      // we use `updateMany` (returns count, not row) and require
      // count==1. On a lost race the whole tx — successor create
      // included — rolls back and the client gets the same 409
      // PREDECESSOR_NOT_ACTIVE it would have seen from the in-tx
      // status read above.
      const claim = await tx.drawing.updateMany({
        where: {
          id: predecessor.id,
          projectId: predecessor.projectId,
          status: 'ACTIVE',
        },
        data: { status: 'SUPERSEDED' },
      });
      if (claim.count !== 1) {
        return {
          error: {
            status: 409,
            body: {
              error: 'PREDECESSOR_NOT_ACTIVE',
              code: 'PREDECESSOR_NOT_ACTIVE',
              message: `Cannot supersede a drawing in status ${predecessor.status}`,
              currentStatus: predecessor.status,
            },
          },
        };
      }
      const updatedPredecessor = { ...predecessor, status: 'SUPERSEDED' };

      return { successor, predecessor: updatedPredecessor };
    });

    if (result.error) {
      return res.status(result.error.status).json(result.error.body);
    }
    res.status(201).json({
      successor: serializeDrawing(result.successor),
      predecessor: serializeDrawing(result.predecessor),
    });
  } catch (err) {
    console.error('Drawing supersede error', {
      employeeHash: hashIdentifier(req.employeeId),
      drawingId: id,
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to supersede drawing' });
  }
}));

module.exports = router;
