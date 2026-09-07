// R36: Admin "Project Reports" — unscoped cross-org view.
//
// Round 35 shipped `GET /api/projects/:projectId/attachments` (per-project)
// and the My Projects accordion's ReportSection consumes it. But an admin
// has no way to see "every report uploaded across every project by every
// employee" — the registry-pattern pages (Drawings / BOQ / Variations)
// live under `/api/admin/*` and have an unscoped cursor-paginated list
// endpoint behind a `requireFreshAdmin` gate. This file adds the matching
// surface for project reports.
//
// Endpoints:
//   GET /api/admin/reports
//     Admin-only cross-project, cross-employee list of `ProjectAttachment`
//     rows. Mirrors the DrawingsAdmin wire shape (projectId + status +
//     cursor + take) so the frontend registry component is a 1-for-1
//     clone.
//
//     Query params (all optional):
//       ?projectId=<UUID or free-text name>  scope to one project
//                                             (free-text name resolves
//                                             case-insensitive via the
//                                             same helper projectAttachments
//                                             uses; unknown name → empty
//                                             result set, not 404)
//       ?uploadedById=<UUID>                 scope to one uploader
//       ?type=<enum>                         one of WEEKLY_REPORT /
//                                             MONTHLY_REPORT /
//                                             DUE_DILIGENCE_REPORT /
//                                             QUALITY_REPORT / OTHER
//       ?from=<YYYY-MM-DD>                   inclusive lower bound on
//       ?to=<YYYY-MM-DD>                     uploadedAt (DateTime column,
//                                             so 'to' includes the whole
//                                             calendar day in UTC)
//       ?limit=<n>                           page size (default 50, max 100)
//       ?cursor=<base64url JSON>             keyset cursor from previous
//                                             response's nextCursor
//
//     Returns:
//       {
//         reports: [{
//           id, projectId, type, title, filename, contentType,
//           sizeBytes, blobPath, uploadedById, uploadedAt,
//           project:    { id, name, code },
//           uploadedBy: { id, name, designation },
//         }],
//         nextCursor: <base64url JSON or null>,
//         total:      <number>,
//       }
//
// Auth model:
//   - requireAuth on every route (401 without token).
//   - requireFreshAdmin (403 if Employee.isAdmin=false in DB; this closes
//     the JWT-claim staleness hole round-20 / DR-005 flagged — a demoted
//     admin loses picker + report access on their next request).
//   - The route is read-only — there is no POST/PATCH/DELETE here.
//     Downloads go through the existing per-project read-sas helper
//     (`/api/projects/:projectId/attachments/:id/read-sas`) and deletes
//     go through the existing per-project DELETE handler, both of which
//     are already wired to the api.js helpers. No new mutation surface
//     is introduced in this round.
//
// Cursor codec:
//   The shared `backend/src/lib/cursor.js` codec is date-only (it pins
//   `YYYY-MM-DD` strings into the seek predicate because the DPR/Inspection
//   cursors are over `@db.Date` columns). ProjectAttachment.uploadedAt is
//   a `DateTime` column — full ISO timestamp, not date-only — so the
//   shared codec's date validation rejects the timestamp we want to
//   store. We use a tiny inline base64url JSON codec scoped to this
//   file instead of widening the shared helper: the wire format is
//   opaque to clients (they treat the cursor as a token), tampering
//   just produces a 400 INVALID_CURSOR, and no other consumer needs
//   the timestamp variant. If a second timestamp-cursor endpoint
//   appears, lift this into `backend/src/lib/cursor.js` and add a
//   `cursorVersion: 'datetime'` discriminator.

'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth, requireFreshAdmin } = require('../middleware/auth');
const { mapPrismaError } = require('../lib/errors');
const { hashIdentifier } = require('../lib/pii');

function getPrisma(req) { return req.app.get('prisma'); }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_TYPES = new Set([
  'WEEKLY_REPORT',
  'MONTHLY_REPORT',
  'DUE_DILIGENCE_REPORT',
  'QUALITY_REPORT',
  'OTHER',
]);

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function isValidUuid(s) {
  return typeof s === 'string' && UUID_RE.test(s);
}

// YYYY-MM-DD → UTC midnight Date. Returns null on malformed input so the
// caller can surface a 400 rather than letting an invalid Date become
// Date(NaN) and silently match nothing.
function parseDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  // JS rolls over 2026-02-30 → 2026-03-02; reject those so an admin
  // fat-fingering a date doesn't surface a misleading empty list.
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

// Cursor codec — base64url(JSON({ uploadedAt: ISO, id })). Same threat
// model as backend/src/lib/cursor.js: opaque to clients, tampering →
// 400. Not lifted to the shared helper because the shared one is pinned
// to date-only strings (DPR/Inspection columns) and we'd be loosening a
// proven contract for a one-file consumer.
function encodeCursor(uploadedAt, id) {
  const iso = uploadedAt instanceof Date ? uploadedAt.toISOString() : String(uploadedAt);
  return Buffer.from(JSON.stringify({ uploadedAt: iso, id }), 'utf8').toString('base64url');
}
function decodeCursor(cursor) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (typeof parsed.uploadedAt !== 'string' || typeof parsed.id !== 'string') return null;
  if (parsed.id.length === 0 || parsed.id.length > 128) return null;
  const ts = new Date(parsed.uploadedAt);
  if (Number.isNaN(ts.getTime())) return null;
  return { uploadedAt: ts, id: parsed.id };
}

// Serialize the row with the joined project + uploadedBy objects so the
// admin UI never has to resolve a UUID to a label. Mirrors
// projectAttachments.serializeProjectAttachment for the bare fields,
// adds two small join objects. Date → ISO so the SPA can format with its
// own timezone-aware helpers (formatShortDate / formatDateTime).
function serializeAdminReport(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.projectId,
    type: row.type,
    title: row.title,
    filename: row.filename,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    blobPath: row.blobPath,
    uploadedById: row.uploadedById,
    uploadedAt: row.uploadedAt instanceof Date ? row.uploadedAt.toISOString() : row.uploadedAt,
    deletedAt: row.deletedAt instanceof Date ? row.deletedAt.toISOString() : row.deletedAt,
    project: row.project ? {
      id: row.project.id,
      name: row.project.name,
      code: row.project.code || null,
    } : null,
    uploadedBy: row.uploadedBy ? {
      id: row.uploadedBy.id,
      name: row.uploadedBy.name,
      designation: row.uploadedBy.designation || null,
    } : null,
  };
}

// Resolve a projectId query param. Returns:
//   { kind: 'uuid', projectId }   when the param is a UUID
//   { kind: 'name', projectId }   when the param is a free-text name
//                                  that matched a registered project
//   { kind: 'name', projectId: null }  when the param is a free-text
//                                  name with no matching project
//                                  (the caller short-circuits to an
//                                  empty result set, not 404 — same
//                                  UX as the per-project GET in R35.1).
//   { kind: 'invalid' }           when the UUID doesn't match any
//                                  active project (404).
async function resolveProjectParam(prisma, projectParam) {
  if (!projectParam) return { kind: 'none' };
  if (isValidUuid(projectParam)) {
    const row = await prisma.project.findUnique({
      where: { id: projectParam },
      select: { id: true, isActive: true },
    });
    if (!row || !row.isActive) return { kind: 'invalid' };
    return { kind: 'uuid', projectId: row.id };
  }
  const freeText = decodeURIComponent(projectParam).trim();
  if (!freeText) return { kind: 'none' };
  const row = await prisma.project.findFirst({
    where: { name: { equals: freeText, mode: 'insensitive' } },
    select: { id: true, isActive: true },
  });
  if (row && row.isActive) return { kind: 'name', projectId: row.id };
  return { kind: 'name', projectId: null };
}

router.use(requireAuth);
router.use(requireFreshAdmin);

// GET /api/admin/reports
//   200 → { reports, nextCursor, total }
//   400 → VALIDATION_ERROR (bad limit / cursor / from / to / type)
//   401 → Authorization required
//   403 → ADMIN_REQUIRED (non-admin employee)
//   503 → DB unavailable
router.get('/', async (req, res) => {
  const prisma = getPrisma(req);
  if (!prisma) {
    return res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });
  }

  // ─── Validate query params ────────────────────────────────────────
  const { projectId, uploadedById, type, from, to } = req.query;

  if (type && !VALID_TYPES.has(type)) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      code: 'INVALID_TYPE',
      message: `type must be one of: ${Array.from(VALID_TYPES).join(', ')}`,
    });
  }

  let fromDate = null;
  let toDate = null;
  if (from) {
    fromDate = parseDateOnly(from);
    if (!fromDate) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        code: 'INVALID_FROM',
        message: 'from must be YYYY-MM-DD',
      });
    }
  }
  if (to) {
    const parsed = parseDateOnly(to);
    if (!parsed) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        code: 'INVALID_TO',
        message: 'to must be YYYY-MM-DD',
      });
    }
    // Inclusive upper bound: roll the date forward 1ms shy of the next day
    // so 'to=2026-09-07' includes every record uploaded at 23:59:59 UTC
    // on 7 Sept. (matches the "date-only admin filters" expectation.)
    toDate = new Date(parsed.getTime() + 24 * 60 * 60 * 1000 - 1);
  }
  if (fromDate && toDate && fromDate > toDate) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      code: 'INVALID_RANGE',
      message: 'from must be ≤ to',
    });
  }

  if (uploadedById && !isValidUuid(uploadedById)) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      code: 'INVALID_UPLOADER',
      message: 'uploadedById must be a UUID',
    });
  }

  const limitRaw = parseInt(req.query.limit, 10);
  const take = Math.min(
    Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : DEFAULT_LIMIT,
    MAX_LIMIT,
  );

  // Resolve free-text projectId → UUID early. An unknown name returns
  // an empty result set rather than 404 — matches the per-project R35.1
  // behaviour.
  const projectScope = await resolveProjectParam(prisma, projectId);
  if (projectScope.kind === 'invalid') {
    return res.status(404).json({
      error: 'PROJECT_NOT_FOUND',
      code: 'PROJECT_NOT_FOUND',
      message: 'Linked project does not exist or is archived',
    });
  }
  if (projectScope.kind === 'name' && projectScope.projectId === null) {
    // Free-text name with no matching project row → empty list. Same UX
    // as the per-project GET so the SPA doesn't have to special-case 404.
    return res.json({ reports: [], nextCursor: null, total: 0 });
  }

  // Decode the keyset cursor. A bad cursor is a 400 INVALID_CURSOR —
  // tampering with the JSON just makes the next page fail loudly.
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
    // Keyset seek: rows after (cursor.uploadedAt, cursor.id) in the
    // (uploadedAt DESC, id DESC) ordering. Prisma's standard `cursor` is
    // too strict (it requires a unique field); the OR-of-compound-
    // comparisons form is what Prisma's docs recommend for non-unique
    // orderBy tails.
    cursorPredicate = {
      OR: [
        { uploadedAt: { lt: decoded.uploadedAt } },
        { uploadedAt: decoded.uploadedAt, id: { lt: decoded.id } },
      ],
    };
  }

  // ─── Build where + fetch ──────────────────────────────────────────
  const where = {
    deletedAt: null,
    ...(projectScope.projectId ? { projectId: projectScope.projectId } : {}),
    ...(uploadedById ? { uploadedById } : {}),
    ...(type ? { type } : {}),
    ...(fromDate || toDate ? {
      uploadedAt: {
        ...(fromDate ? { gte: fromDate } : {}),
        ...(toDate ? { lte: toDate } : {}),
      },
    } : {}),
    ...(cursorPredicate || {}),
  };

  try {
    // Fetch `take + 1` so we can tell whether another page exists without
    // a separate `count > offset` round-trip. count() runs in parallel
    // — Postgres can satisfy both from the same snapshot when no other
    // transaction is mutating the table.
    const [rows, total] = await Promise.all([
      prisma.projectAttachment.findMany({
        where,
        take: take + 1,
        orderBy: [{ uploadedAt: 'desc' }, { id: 'desc' }],
        include: {
          project:    { select: { id: true, name: true, code: true } },
          uploadedBy: { select: { id: true, name: true, designation: true } },
        },
      }),
      prisma.projectAttachment.count({ where }),
    ]);

    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;
    const last = page[page.length - 1];
    return res.json({
      reports: page.map(serializeAdminReport),
      nextCursor: hasMore && last ? encodeCursor(last.uploadedAt, last.id) : null,
      total,
    });
  } catch (err) {
    console.error('[admin/reports] list failed', {
      employeeHash: hashIdentifier(req.employeeId),
      errCode: err?.code,
      errMessage: err?.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to load reports' });
  }
});

module.exports = router;
