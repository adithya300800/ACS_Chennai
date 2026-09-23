// R35: Project Reports — file attachments per project.
//
// The My Projects accordion (Round-33) renders a 6th "Reports" sub-section
// alongside DPR / Inspection / Drawing / BOQ. Engineers and admins attach
// weekly / monthly / due-diligence / quality / other documents to a
// project so there's an in-portal trail of "what was filed against this
// project when" — replaces the prior workflow of emailing PDFs around
// and forgetting which version was final.
//
// Endpoints (mounted at /api/projects/:projectId/attachments in
// src/index.js; mergeParams: true so :projectId is visible to every route
// here without an explicit prefix-parse):
//   GET    /                                 list (active only — excludes
//                                             soft-deleted). ?type= filter.
//   POST   /                                 create row. Body carries the
//                                             blob path the client got from
//                                             /api/dpr/sas-url + /confirm-
//                                             upload (same upload pipeline
//                                             drawings use).
//   GET    /:attachmentId/read-sas           mint a 1-hour signed GET URL
//                                             for the stored blob.
//   PATCH  /:attachmentId                    admin-only state-machine review.
//                                             Stamps status + reviewed_by_id +
//                                             reviewed_at + review_notes.
//   DELETE /:attachmentId                    soft-delete via deletedAt.
//                                             Auth-gated to (admin OR
//                                             uploader) — matches the Boq
//                                             item deletion policy.
//
// Auth model:
//   - requireAuth on every route.
//   - `requireProjectScope` middleware (private to this module) resolves
//     the project — the URL :projectId param can be EITHER a UUID (a
//     registered project) OR a free-text project name (an unregistered
//     "discovered" project that the employee typed into a DPR / a
//     Drawing search box). For names, the helper looks the project up
//     case-insensitive and, if no row exists, AUTO-CREATES one with
//     minimal fields + isActive=true. The resolved UUID is rewritten
//     onto req.params.projectId so the rest of the handlers stay
//     UUID-only. This is the round-35.1 behaviour — the gate "Register
//     this project first" was removed per user feedback.
//   - DELETE additionally requires (req.isAdmin || row.uploadedById ===
//     req.employeeId). Non-admin / non-uploader gets 403
//     NOT_ATTACHMENT_OWNER. Admin can delete any report.
//
// Storage:
//   - Files live in the existing `dpr-documents` R2 bucket (no new
//     bucket needed — the per-container allowlist + CONTENT_TYPE_EXT
//     map was widened in routes/dpr.js + lib/blobStorage.js). The blob
//     path is stored verbatim and re-minted on read-sas.
//   - First `deletedAt` column in the schema — appropriate for a new
//     audit-relevant model (the existing status: ACTIVE|SUPERSEDED
//     pattern is revision-semantic for Drawing and not a fit for a
//     record whose lifecycle is just exists/deleted).
//
// Soft-delete idempotency:
//   - DELETE on an already-deleted row returns 200 with the row as-is
//     (deletedAt is preserved). Mirrors drawings.js#DELETE /api/drawings
//     which returns 200 for an already-SUPERSEDED row.

'use strict';

const express = require('express');
// mergeParams: true is required so the parent /api/projects/:projectId
// prefix makes `req.params.projectId` visible to every route below. The
// default Express Router does NOT inherit parent params — without this
// flag, :projectId would be undefined and every route would 404.
const router = express.Router({ mergeParams: true });
const { requireAuth, requireFreshAdmin } = require('../middleware/auth');
const { mapPrismaError } = require('../lib/errors');
const { hashIdentifier } = require('../lib/pii');
const { randomUUID } = require('crypto');
const { generateReadSASUrl, READ_URL_TTL_SECONDS, verifyBlobExists, isAbsent } = require('../lib/blobStorage');
// [DR-001] Mirror the drawings.js binding — the single `blobPath` field
// is wrapped as a one-element `photos` array at the call site so the
// helper's array shape doesn't need a parallel "single" API.
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
const VALID_REPORT_TYPES = new Set([
  'WEEKLY_REPORT',
  'MONTHLY_REPORT',
  'DUE_DILIGENCE_REPORT',
  'QUALITY_REPORT',
  'OTHER',
]);

// [DocumentCategory] Subject-matter classifier — orthogonal to `type`.
// 8 values mirror the Prisma `DocumentCategory` enum (schema.prisma).
// A row's `category` is null unless the uploader picked one of these —
// legacy Weekly / Monthly / Due Diligence / Quality uploads leave it
// null and the existing review state machine (ProjectAttachmentStatus)
// keeps working untouched.
const VALID_DOCUMENT_CATEGORIES = new Set([
  'CLIENT_APPROVALS_DELIVERABLES',
  'DESIGN_DRAWINGS',
  'COST_BOQ',
  'PROCUREMENT_VENDOR',
  'SITE_PROGRESS_INSPECTIONS',
  'QUALITY_SAFETY',
  'CONTRACTS_CHANGE_ORDERS',
  'HANDOVER_CLOSEOUT',
]);

// Mirror of the dpr-documents per-container allowlist in
// routes/dpr.js. The upload pipeline gates /sas-url against this list;
// this is the same gate re-applied to the POST body so a malicious or
// bug-ridden client cannot skip /sas-url and POST a row directly with a
// bogus MIME type. Keep these two lists in sync.
const VALID_REPORT_CONTENT_TYPES = new Set([
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

// ─── Field-length caps ──────────────────────────────────────────────────────
const FIELD_MAX = {
  title: 200,
  filename: 512,
  contentType: 100,
  blobPath: 1024,
  // [DR-001] Crockford base32 ULIDs are 26 chars; 30 leaves headroom for
  // any future prefix scheme without forcing a schema change.
  uploadIntentUlid: 30,
  // [S7/MyReports] Review notes cap — admin-supplied reason for
  // REVISION_REQUESTED + REJECTED. 2000 chars covers a detailed
  // technical critique without bloating the audit column.
  reviewNotes: 2000,
};

function isValidUuid(s) {
  return typeof s === 'string' && UUID_RE.test(s);
}

// ─── Serialization ──────────────────────────────────────────────────────────
// Date → ISO so the frontend can do its own relative-time formatting.
function serializeProjectAttachment(row) {
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
    // [DR-001] Internal: ulid of the UploadIntent row that vouched for
    // `blobPath`. Echoed for traceability; not consumed by the React UI.
    uploadIntentUlid: row.uploadIntentUlid,
    uploadedById: row.uploadedById,
    uploadedAt: row.uploadedAt instanceof Date ? row.uploadedAt.toISOString() : row.uploadedAt,
    deletedAt: row.deletedAt instanceof Date ? row.deletedAt.toISOString() : row.deletedAt,
    // [S7/MyReports] Admin review state — stamped atomically by
    // PATCH /:attachmentId. Echoed for the admin action bar so the UI
    // can hide/show Approve / Request Revision / Reject buttons based
    // on the current state without a second GET.
    status: row.status,
    reviewedById: row.reviewedById,
    reviewedAt: row.reviewedAt instanceof Date ? row.reviewedAt.toISOString() : row.reviewedAt,
    reviewNotes: row.reviewNotes,
    // [DR-037] Monotonic content counter — the SPA echoes this back as
    // `expectedVersion` on review / replace / delete PATCH calls. A
    // mismatch returns 409 STALE_REVIEW_VERSION. Default 0 keeps
    // pre-migration rows readable until the migration runs.
    contentVersion: row.contentVersion ?? 0,
    // [DocumentCategory] Subject-matter classifier. NULL on every row
    // uploaded via the legacy report flow (Weekly / Monthly / Due
    // Diligence / Quality / Other). New-category uploads set this
    // explicitly; the value drives the employee group's "by category"
    // view and the admin ?category= chip filter.
    category: row.category || null,
  };
}

// ─── requireProjectScope ────────────────────────────────────────────────────
// All routes except DELETE go through this gate — resolves the project
// the URL refers to. The :projectId URL param accepts either a UUID OR a
// free-text project name. Names that don't yet exist as Project rows are
// AUTO-CREATED with minimal fields + isActive=true so the upload flow
// works without an explicit "register this project" step — round-35.1
// removed the gating copy. DELETE also gates per-attachment ownership
// below.
//
// 404 PROJECT_NOT_FOUND is only returned for an explicitly-typed UUID
// that resolves to no row (or a soft-deleted project). A name that
// auto-creates successfully is treated as if the project existed all
// along — the row materialises on first attachment.
async function requireProjectScope(req, res, next) {
  const prisma = getPrisma(req);
  if (!prisma) {
    return res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });
  }
  const raw = req.params.projectId;
  if (!raw || !raw.trim()) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', code: 'PROJECT_KEY_REQUIRED', message: 'projectId is required' });
  }
  const key = decodeURIComponent(raw).trim();
  // Auto-create (round-35.1) only on writes. A read against a name that
  // doesn't exist yet should return 200 with an empty list (the GET
  // handler filters by `where: { projectId, deletedAt: null }`), NOT
  // materialise a project row from a passive list call. Writes (POST)
  // are the only path that surface a discovered project to the user
  // via the upload form.
  const isWrite = req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE';
  try {
    let resolvedId;
    if (isValidUuid(key)) {
      const project = await prisma.project.findUnique({
        where: { id: key },
        select: { id: true, isActive: true },
      });
      if (!project || !project.isActive) {
        return res.status(404).json({
          error: 'PROJECT_NOT_FOUND',
          code: 'PROJECT_NOT_FOUND',
          message: 'Linked project does not exist or is archived',
        });
      }
      resolvedId = project.id;
    } else {
      // Free-text name. Try case-insensitive match first so a name that
      // already exists under a different casing doesn't materialise a
      // duplicate row (Project.name has a unique constraint).
      const existing = await prisma.project.findFirst({
        where: { name: { equals: key, mode: 'insensitive' } },
        select: { id: true, isActive: true },
      });
      if (existing) {
        if (!existing.isActive) {
          return res.status(404).json({
            error: 'PROJECT_NOT_FOUND',
            code: 'PROJECT_NOT_FOUND',
            message: 'Linked project is archived',
          });
        }
        resolvedId = existing.id;
      } else if (!isWrite) {
        // Read against a name that has no project row yet — return 200
        // with an empty list rather than 404. A discovered card the
        // user is browsing hasn't materialised a Project row yet, but
        // it should still be readable (the GET handler treats it as an
        // empty attachments set). The empty list is what the frontend
        // wants to render the upload form + "No reports yet…" copy.
        // We synthesise a sentinel projectId of `null` so the GET
        // handler's `where: { projectId }` filter returns no rows.
        req.resolvedProjectId = null;
        return next();
      } else {
        // Auto-create (round-35.1). Mirror the legacy DPR "discovered
        // project" pattern: a free-text name in a write context is
        // treated as a project to track. The new row is isActive=true,
        // name=key, no code/parties/contract — admins can curate later.
        // P2002 (race against a concurrent insert with the same name) is
        // caught and we re-resolve the winner.
        let created;
        try {
          created = await prisma.project.create({
            data: {
              name: key,
              isActive: true,
              createdById: req.employeeId,
            },
            select: { id: true, isActive: true },
          });
        } catch (err) {
          if (err?.code === 'P2002') {
            const winner = await prisma.project.findFirst({
              where: { name: { equals: key, mode: 'insensitive' } },
              select: { id: true, isActive: true },
            });
            if (winner && winner.isActive) {
              resolvedId = winner.id;
              return nextWithResolved(req, res, next, resolvedId);
            }
            return res.status(409).json({
              error: 'PROJECT_NAME_CONFLICT',
              code: 'PROJECT_NAME_CONFLICT',
              message: 'A project with this name already exists but is not accessible',
            });
          }
          throw err;
        }
        resolvedId = created.id;
      }
    }
    return nextWithResolved(req, res, next, resolvedId);
  } catch (err) {
    console.error('[project-attachments] project scope check failed', {
      employeeHash: hashIdentifier(req.employeeId),
      projectKey: raw,
      errCode: err?.code,
      errMessage: err?.message?.split('\n')[0],
    });
    return res.status(503).json({ error: 'PROJECT_SCOPE_CHECK_FAILED', message: 'Could not verify project' });
  }
}

// Tiny helper to keep the resolved UUID reachable by the route handlers
// below. Express ≥4 lazy-parses req.params from req.url on every read,
// so a plain `req.params.x = …` doesn't stick — we expose the resolved
// UUID via a custom property `req.resolvedProjectId` and the route
// handlers read it back via the helper below.
function nextWithResolved(req, res, next, resolvedId) {
  req.resolvedProjectId = resolvedId;
  next();
}

// Helper the route handlers use to read the projectId — falls back to
// `req.params.projectId` for legacy UUID callers, prefers the resolved
// UUID when the URL carried a free-text name.
function readProjectId(req) {
  return req.resolvedProjectId || req.params.projectId;
}

router.use(requireAuth);
router.use(requireProjectScope);

// ─── GET /api/projects/:projectId/attachments ───────────────────────────────
// List attachments for a project, newest first. Excludes soft-deleted
// rows. ?type= filter narrows to one of the 5 enum values. ?types=A,B,C
// accepts a CSV so the admin Reports page can send one round trip for a
// multi-type chip selection.
//
// [DR-022] Cursor-paginated on (uploadedAt DESC, id DESC). The previous
// `take: 100` cap silently dropped every record past row 100, and the
// X-Total-Count header reflected only the returned slice — making a
// project with >100 attachments unlistable from the My Projects
// accordion. The fix: take+1 with a keyset cursor mirroring
// adminReports.js (same keyset shape so a future move to a shared codec
// is cheap). The wire surface keeps `attachments: [...]` for the legacy
// caller and adds `nextCursor` so the SPA can load more.
//
// 200 → { attachments: [...], nextCursor?: string|null }
// 400 → VALIDATION_ERROR (bad projectId UUID, unknown ?type, bad cursor)
// 404 → PROJECT_NOT_FOUND
// 503 → DB_UNAVAILABLE
router.get('/', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  if (!prisma) {
    return res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });
  }

  const projectId = readProjectId(req);
  const { type, types, category, categories, cursor, limit } = req.query;

  // [DR-022] Resolve the type filter — accept either `?type=` (single
  // enum, legacy callers) or `?types=A,B,C` (CSV, admin Reports page).
  // CSV takes precedence when both are supplied; an unknown value in
  // either shape is a 400 INVALID_TYPE.
  const requestedTypes = [];
  if (types) {
    if (typeof types !== 'string') {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        code: 'INVALID_TYPE',
        message: 'types must be a comma-separated string',
      });
    }
    for (const t of types.split(',').map((s) => s.trim()).filter(Boolean)) {
      if (!VALID_REPORT_TYPES.has(t)) {
        return res.status(400).json({
          error: 'VALIDATION_ERROR',
          code: 'INVALID_TYPE',
          message: `types contains unknown value: ${t}`,
        });
      }
      requestedTypes.push(t);
    }
  }
  if (type) {
    if (!VALID_REPORT_TYPES.has(type)) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        code: 'INVALID_TYPE',
        message: `type must be one of: ${Array.from(VALID_REPORT_TYPES).join(', ')}`,
      });
    }
    if (!requestedTypes.length) requestedTypes.push(type);
  }

  // [DocumentCategory] Resolve the category filter — same CSV / single
  // shape as the type filter. Unknown values are 400 INVALID_CATEGORY.
  // The shape mirrors `type`/`types` deliberately so the chip row on
  // the React side uses the same onClick handler.
  const requestedCategories = [];
  if (categories) {
    if (typeof categories !== 'string') {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        code: 'INVALID_CATEGORY',
        message: 'categories must be a comma-separated string',
      });
    }
    for (const c of categories.split(',').map((s) => s.trim()).filter(Boolean)) {
      if (!VALID_DOCUMENT_CATEGORIES.has(c)) {
        return res.status(400).json({
          error: 'VALIDATION_ERROR',
          code: 'INVALID_CATEGORY',
          message: `categories contains unknown value: ${c}`,
        });
      }
      requestedCategories.push(c);
    }
  }
  if (category) {
    if (!VALID_DOCUMENT_CATEGORIES.has(category)) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        code: 'INVALID_CATEGORY',
        message: `category must be one of: ${Array.from(VALID_DOCUMENT_CATEGORIES).join(', ')}`,
      });
    }
    if (!requestedCategories.length) requestedCategories.push(category);
  }

  // [DR-022] Cursor codec — base64url(JSON({ uploadedAt: ISO, id })).
  // Mirrors adminReports.js so we could lift it into a shared helper
  // next; today it stays inline because the admin route's comment
  // explains why we don't yet share with this one (different cursors
  // for DPR / Inspection / Drawing / BOQ mean a shared helper needs
  // care). For now: tiny inline codec, opaque to clients.
  let cursorPredicate = null;
  if (cursor) {
    if (typeof cursor !== 'string') {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        code: 'INVALID_CURSOR',
        message: 'cursor must be a string',
      });
    }
    let decoded;
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bad shape');
      const ts = new Date(parsed.uploadedAt);
      if (typeof parsed.uploadedAt !== 'string' || Number.isNaN(ts.getTime())) throw new Error('bad ts');
      if (typeof parsed.id !== 'string' || parsed.id.length === 0 || parsed.id.length > 128) throw new Error('bad id');
      decoded = { uploadedAt: ts, id: parsed.id };
    } catch {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        code: 'INVALID_CURSOR',
        message: 'cursor is malformed',
      });
    }
    cursorPredicate = {
      OR: [
        { uploadedAt: { lt: decoded.uploadedAt } },
        { uploadedAt: decoded.uploadedAt, id: { lt: decoded.id } },
      ],
    };
  }

  const take = Math.min(parseInt(limit, 10) > 0 ? parseInt(limit, 10) : 50, 100);

  try {
    // A null projectId means the URL carried a free-text name with no
    // matching Project row yet (the read-only path of round-35.1).
    // ProjectAttachment.projectId is non-nullable in the schema, so a
    // `where: { projectId: null }` filter matches zero rows — exactly
    // what we want for "no reports yet" on a discovered card.
    if (projectId == null) {
      res.setHeader('X-Total-Count', 0);
      return res.json({ attachments: [], nextCursor: null });
    }
    const where = {
      projectId,
      deletedAt: null,
      ...(requestedTypes.length === 1 ? { type: requestedTypes[0] } : {}),
      ...(requestedTypes.length > 1 ? { type: { in: requestedTypes } } : {}),
      // [DocumentCategory] Category filter — uses the composite
      // (projectId, category, deletedAt) index. NULL values are
      // indexed too, so "category IS NULL" legacy reports keep
      // working without a separate index path.
      ...(requestedCategories.length === 1 ? { category: requestedCategories[0] } : {}),
      ...(requestedCategories.length > 1 ? { category: { in: requestedCategories } } : {}),
      ...(cursorPredicate || {}),
    };
    const rows = await prisma.projectAttachment.findMany({
      where,
      orderBy: [{ uploadedAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
    });
    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;
    const last = page[page.length - 1];
    const nextCursor = hasMore && last
      ? Buffer.from(JSON.stringify({
          uploadedAt: last.uploadedAt instanceof Date ? last.uploadedAt.toISOString() : String(last.uploadedAt),
          id: last.id,
        }), 'utf8').toString('base64url')
      : null;
    res.setHeader('X-Total-Count', String(page.length));
    res.setHeader('X-Has-More', hasMore ? 'true' : 'false');
    res.json({
      attachments: page.map(serializeProjectAttachment),
      nextCursor,
    });
  } catch (err) {
    console.error('[project-attachments] list failed', {
      employeeHash: hashIdentifier(req.employeeId),
      projectId,
      errCode: err?.code,
      errMessage: err?.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to fetch attachments' });
  }
}));

// ─── POST /api/projects/:projectId/attachments ──────────────────────────────
// Insert a row. The body is the client-side evidence that an upload
// landed in R2 — same shape drawings.js#POST /api/drawings accepts.
//
//   filename      — original file name (used in the list/download UI)
//   contentType   — MIME type (must be in the dpr-documents allowlist)
//   sizeBytes     — final byte count after the PUT (must be ≤ 25 MB)
//   blobPath      — R2 key returned from /api/dpr/sas-url
//   type          — one of WEEKLY_REPORT / MONTHLY_REPORT /
//                   DUE_DILIGENCE_REPORT / QUALITY_REPORT / OTHER
//   title         — optional human-readable label
//
// `uploadedById` is auto-stamped to req.employeeId. There is no admin-
// on-behalf path — uploading-as-someone-else is the same anti-pattern
// drawings.js flagged as CANNOT_ISSUE_ON_BEHALF; reports follow the
// same rule because the uploader audit column drives the delete-perm
// check below.
//
// 201 → attachment (serialized)
// 400 → VALIDATION_ERROR, PROJECT_NOT_FOUND
// 503 → DB_UNAVAILABLE
router.post('/', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  if (!prisma) {
    return res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });
  }

  const projectId = readProjectId(req);
  const body = req.body || {};

  // Field validation — keep the wire contract tight.
  if (!body.filename || typeof body.filename !== 'string') {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'filename is required' });
  }
  if (!body.contentType || typeof body.contentType !== 'string') {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'contentType is required' });
  }
  if (!VALID_REPORT_CONTENT_TYPES.has(body.contentType)) {
    return res.status(400).json({
      error: 'INVALID_CONTENT_TYPE',
      code: 'INVALID_CONTENT_TYPE',
      message: `contentType must be one of: ${Array.from(VALID_REPORT_CONTENT_TYPES).join(', ')}`,
    });
  }
  if (typeof body.sizeBytes !== 'number' || !Number.isFinite(body.sizeBytes) || body.sizeBytes <= 0) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'sizeBytes must be a positive number' });
  }
  // 25 MB matches the dpr-documents container cap (routes/dpr.js
  // maxSizeBytesPerContainer). The duplicate check here is defense in
  // depth — the upload pipeline also enforces it, but a malicious or
  // bug-ridden client could craft a POST that bypasses /sas-url.
  if (body.sizeBytes > 25 * 1024 * 1024) {
    return res.status(413).json({
      error: 'REPORT_TOO_LARGE',
      code: 'REPORT_TOO_LARGE',
      message: 'Report must be 1 byte – 26214400 bytes',
    });
  }
  if (!body.blobPath || typeof body.blobPath !== 'string') {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'blobPath is required' });
  }
  // [DR-001] Optional — ulid of the UploadIntent row that vouched for
  // `blobPath`. When supplied it MUST be a non-empty string; when
  // omitted the legacy clients keep working and the sweep's
  // referenced-blobPath defence covers them until they upgrade.
  if (body.uploadIntentUlid != null && body.uploadIntentUlid !== '') {
    if (typeof body.uploadIntentUlid !== 'string') {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'uploadIntentUlid must be a string' });
    }
  }
  if (!body.type || !VALID_REPORT_TYPES.has(body.type)) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      code: 'INVALID_TYPE',
      message: `type must be one of: ${Array.from(VALID_REPORT_TYPES).join(', ')}`,
    });
  }
  // [DocumentCategory] Optional subject-matter classifier. When present
  // it overrides `type` to 'OTHER' (the enum contract still sees a
  // valid value; the existing review state machine treats the row as
  // an "Other" report — `category` is the real classifier). A bad value
  // is 400 INVALID_CATEGORY; an empty string is treated as "no
  // category" so a stub field from a non-upgraded client doesn't 400.
  let resolvedCategory = null;
  if (body.category != null && body.category !== '') {
    if (typeof body.category !== 'string' || !VALID_DOCUMENT_CATEGORIES.has(body.category)) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        code: 'INVALID_CATEGORY',
        message: `category must be one of: ${Array.from(VALID_DOCUMENT_CATEGORIES).join(', ')}`,
      });
    }
    resolvedCategory = body.category;
  }
  if (body.title != null && (typeof body.title !== 'string')) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'title must be a string' });
  }

  // Length caps (post-coercion so the trimmed string is what we cap).
  for (const [k, cap] of Object.entries(FIELD_MAX)) {
    const v = body[k];
    if (v != null && typeof v === 'string' && v.length > cap) {
      return res.status(400).json({ error: `${k} exceeds ${cap} chars`, code: 'VALIDATION_ERROR' });
    }
  }

  // [DR-001] Validate the upload intent BEFORE we touch any rows.
  // Same single-element-array adapter as drawings.js — the helper only
  // reads `p.ulid` from each entry.
  let intentWrapper = null;
  if (body.uploadIntentUlid) {
    intentWrapper = [{ ulid: body.uploadIntentUlid }];
    // [DR-001] Path/container equality check — project attachments
    // upload to `dpr-documents` (same curated bucket as drawings /
    // billing certifications). Without this equality check, a caller
    // could reuse any of their own CONFIRMED intents and bind it to
    // a blobPath the intent never vouched for.
    const intentErr = await validatePhotoIntents({
      prisma,
      employeeId: req.employeeId,
      photos: intentWrapper,
      context: 'projectAttachment.create',
      expectedContainer: 'dpr-documents',
      expectedBlobPath: body.blobPath,
    });
    if (intentErr) return res.status(intentErr.status).json(intentErr.body);
  }

  try {
    // [DR-001] Create + intent claim are one tx. Mirrors the dpr.js
    // contract — see lib/uploadIntentBinding.js for the rationale. A
    // sweep that retires the blob between validate and here makes
    // bindPhotoIntentsTx throw `PhotoBindingLostError`, the whole tx
    // rolls back, the client gets 409 and re-uploads.
    const row = await withRecordTransaction(prisma, 'projectAttachment', async (db) => {
      if (intentWrapper) {
        await assertPhotoIntentsBindable({
          tx: db,
          employeeId: req.employeeId,
          photos: intentWrapper,
          expectedContainer: 'dpr-documents',
          expectedBlobPath: body.blobPath,
        });
      }
      const created = await db.projectAttachment.create({
        data: {
          id: randomUUID(),
          projectId,
          // [DocumentCategory] When `category` is present we silently
          // override `type` to 'OTHER' so the legacy review state
          // machine treats the row as an "Other" report — `category`
          // is the real classifier for these uploads. A well-behaved
          // client already sends type='OTHER' alongside a category; the
          // override is the defensive backstop for any client that
          // forgets. Category-tagged rows skip the admin review queue
          // entirely (status stays PENDING_REVIEW per the schema
          // default, but the admin Reports page's review action bar
          // filters them out via the same `category IS NOT NULL`
          // predicate the GET filter uses).
          type: resolvedCategory ? 'OTHER' : body.type,
          title: body.title ? body.title.trim() : null,
          filename: body.filename.trim(),
          contentType: body.contentType,
          sizeBytes: body.sizeBytes,
          blobPath: body.blobPath,
          // [DR-001] Stamp the ulid verbatim so the sweep's
          // referenced-ulid defence can find this row.
          uploadIntentUlid: body.uploadIntentUlid || null,
          uploadedById: req.employeeId,
          // [DocumentCategory] Subject-matter classifier. NULL on
          // every legacy report upload; set explicitly when the
          // employee picked a category chip on the upload form.
          category: resolvedCategory,
        },
      });
      if (intentWrapper) {
        await bindPhotoIntentsTx({
          tx: db,
          employeeId: req.employeeId,
          photos: intentWrapper,
          boundType: 'projectAttachment',
          recordId: created.id,
          expectedContainer: 'dpr-documents',
          expectedBlobPath: body.blobPath,
        });
      }
      return created;
    });
    res.status(201).json(serializeProjectAttachment(row));
  } catch (err) {
    // [DR-001] Lost upload claim → 409, never 500. Same envelope as
    // dpr.js — the client knows what to do.
    const bindingLost = photoBindingLostResponse(err);
    if (bindingLost) {
      console.warn('ProjectAttachment create rolled back — upload binding lost', {
        employeeHash: hashIdentifier(req.employeeId),
        expected: err.expected,
        bound: err.bound,
      });
      return res.status(bindingLost.status).json(bindingLost.body);
    }
    console.error('[project-attachments] create failed', {
      employeeHash: hashIdentifier(req.employeeId),
      projectId,
      errCode: err?.code,
      errMessage: err?.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to create attachment' });
  }
}));

// ─── GET /api/projects/:projectId/attachments/:attachmentId/read-sas ────────
// Mint a 1-hour presigned GET URL for the stored blob so the React
// download button can hand the browser a `window.open(url)` without
// exposing any R2 credentials. Same auth gate as the list (requireAuth
// + requireProjectScope, both mounted earlier).
//
// 200 → { sasUrl, expiresIn }
// 400 → VALIDATION_ERROR (bad UUID, no blobPath)
// 404 → PROJECT_NOT_FOUND, ATTACHMENT_NOT_FOUND
// 503 → DB_UNAVAILABLE
router.get('/:attachmentId/read-sas', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  if (!prisma) {
    return res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });
  }

  const projectId = readProjectId(req);
  const { attachmentId } = req.params;
  if (!isValidUuid(attachmentId)) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'attachmentId must be a UUID' });
  }

  try {
    const row = await prisma.projectAttachment.findUnique({
      where: { id: attachmentId },
      select: { projectId: true, blobPath: true, deletedAt: true },
    });
    if (!row || row.deletedAt) {
      return res.status(404).json({
        error: 'ATTACHMENT_NOT_FOUND',
        code: 'ATTACHMENT_NOT_FOUND',
        message: 'Attachment not found',
      });
    }
    // Project FK guard — defends against an attachmentId from a
    // different project being passed under the wrong :projectId
    // prefix. (Belt + braces: the route is also reachable via
    // app.use('/api/projects/:projectId/attachments', ...) so a
    // mismatched URL would already 404 via requireProjectScope on the
    // outer prefix, but this catches the in-process case.)
    if (row.projectId !== projectId) {
      return res.status(404).json({
        error: 'ATTACHMENT_NOT_FOUND',
        code: 'ATTACHMENT_NOT_FOUND',
        message: 'Attachment not found',
      });
    }
    if (!row.blobPath) {
      return res.status(400).json({
        error: 'NO_BLOB_ATTACHED',
        code: 'NO_BLOB_ATTACHED',
        message: 'This attachment has no blob path recorded.',
      });
    }

    // [S7 round-2] Verify the blob still exists in R2 BEFORE minting a
    // SAS URL — if the bucket was wiped, restored from a pre-data backup,
    // or the object was deleted by a lifecycle rule, minting the URL just
    // hands the browser a presigned URL that 404s on open. A 410 + clear
    // message lets the SPA surface "file missing, please re-upload"
    // instead of the cryptic R2 NoSuchKey XML.
    // [DR-007] Only `outcome: 'absent'` (404) triggers a 410 BLOB_GONE.
    // Permission/timeout/5xx land in `outcome: 'unknown'` and fall
    // through to minting a fresh SAS URL; the browser surfaces the real
    // error if the object is genuinely missing.
    try {
      const props = await verifyBlobExists('dpr-documents', row.blobPath);
      if (isAbsent(props)) {
        return res.status(410).json({
          error: 'BLOB_GONE',
          code: 'BLOB_GONE',
          message: 'This file is no longer in storage — please re-upload.',
          // Hint to the SPA that the PATCH /:attachmentId/file endpoint
          // can re-upload in-place (preserves row metadata). The SPA
          // surfaces a "Replace file" CTA on top of the toast.
          canReplace: true,
        });
      }
      if (props.outcome === 'unknown') {
        console.warn('[project-attachments] verifyBlobExists unknown, minting SAS anyway', {
          blobPath: row.blobPath,
          reason: props.reason,
        });
      }
    } catch (err) {
      // Defensive — should not happen under DR-007. Kept so a future
      // SDK regression doesn't break the listing.
      console.warn('[project-attachments] verifyBlobExists threw, minting SAS anyway', {
        blobPath: row.blobPath,
        errMessage: err?.message?.split('\n')[0],
      });
    }

    // Container is hard-coded to 'dpr-documents' — same convention as
    // drawings.js#read-sas. The blob path is stored verbatim from the
    // /api/dpr/sas-url response so re-mint is just (container, blobName).
    const { sasUrl } = await generateReadSASUrl('dpr-documents', row.blobPath);
    res.json({ sasUrl, expiresIn: READ_URL_TTL_SECONDS });
  } catch (err) {
    console.error('[project-attachments] read-sas failed', {
      employeeHash: hashIdentifier(req.employeeId),
      projectId,
      attachmentId,
      errCode: err?.code,
      errMessage: err?.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to mint read URL' });
  }
}));

// ─── PATCH /api/projects/:projectId/attachments/:attachmentId/file ───────────
// Replace the underlying blob in-place — preserves the row's identity
// (type / title / uploadedBy / uploadedAt / id) so the admin doesn't
// have to re-type metadata after a BLOB_GONE recovery. Auth: admin OR
// uploader (same gate as DELETE). Resets review state to
// PENDING_REVIEW so the admin's earlier Approve / Reject is no longer
// sitting over a stale blob.
//
// Body shape — same as POST:
//   uploadIntentUlid  — REQUIRED. The new UploadIntent row that vouches
//                       for the new bytes (same DR-001 binding check).
//   blobPath          — REQUIRED. The new R2 key from /api/dpr/sas-url.
//   filename          — REQUIRED. Re-stamped on the row.
//   contentType       — REQUIRED. In VALID_REPORT_CONTENT_TYPES.
//   sizeBytes         — REQUIRED. ≤ 25 MB.
//
// 200 → attachment (serialized)
// 400 → VALIDATION_ERROR
// 403 → NOT_ATTACHMENT_OWNER
// 404 → ATTACHMENT_NOT_FOUND
// 409 → INTENT_MISMATCH (intent doesn't bind to the supplied blobPath)
// 503 → DB_UNAVAILABLE
router.patch('/:attachmentId/file', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  if (!prisma) {
    return res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });
  }

  const projectId = readProjectId(req);
  const { attachmentId } = req.params;
  if (!isValidUuid(attachmentId)) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'attachmentId must be a UUID' });
  }

  const body = req.body || {};
  const { uploadIntentUlid, blobPath, filename, contentType, sizeBytes, expectedVersion } = body;

  if (!uploadIntentUlid || typeof uploadIntentUlid !== 'string') {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'uploadIntentUlid is required' });
  }
  if (!blobPath || typeof blobPath !== 'string') {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'blobPath is required' });
  }
  if (!filename || typeof filename !== 'string') {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'filename is required' });
  }
  if (!contentType || !VALID_REPORT_CONTENT_TYPES.has(contentType)) {
    return res.status(400).json({
      error: 'INVALID_CONTENT_TYPE',
      code: 'INVALID_CONTENT_TYPE',
      message: `contentType must be one of: ${Array.from(VALID_REPORT_CONTENT_TYPES).join(', ')}`,
    });
  }
  if (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > 25 * 1024 * 1024) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'sizeBytes must be 1 byte – 26214400 bytes' });
  }

  // [DR-037] Same stale-version guard as the review PATCH. The replace
  // path increments contentVersion on success — if the SPA's view is
  // behind, we refuse the replace so the user is forced to refresh
  // rather than overwrite a row that already changed in another tab.
  if (expectedVersion !== undefined && expectedVersion !== null) {
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        code: 'INVALID_EXPECTED_VERSION',
        message: 'expectedVersion must be a non-negative integer',
      });
    }
  }

  try {
    // Ownership pre-check before binding so a 403 doesn't run a tx.
    const existing = await prisma.projectAttachment.findUnique({
      where: { id: attachmentId },
      select: {
        projectId: true,
        deletedAt: true,
        uploadedById: true,
        // [DR-037] Read the current version for the optimistic-concurrency
        // check below.
        contentVersion: true,
      },
    });
    if (!existing || existing.deletedAt) {
      return res.status(404).json({ error: 'ATTACHMENT_NOT_FOUND', code: 'ATTACHMENT_NOT_FOUND', message: 'Attachment not found' });
    }
    if (existing.projectId !== projectId) {
      return res.status(404).json({ error: 'ATTACHMENT_NOT_FOUND', code: 'ATTACHMENT_NOT_FOUND', message: 'Attachment not found' });
    }
    const isOwner = existing.uploadedById && existing.uploadedById === req.employeeId;
    if (!req.isAdmin && !isOwner) {
      return res.status(403).json({
        error: 'NOT_ATTACHMENT_OWNER',
        code: 'NOT_ATTACHMENT_OWNER',
        message: 'Only the uploader or an admin may replace this file',
      });
    }

    // [DR-037] Stale-version conflict for replace. Same shape as the
    // review PATCH 409 — distinguishable from INVALID_TRANSITION by
    // error code, so the SPA can render a different message ("content
    // changed since you opened this tab; refresh and try again").
    if (expectedVersion !== undefined && expectedVersion !== null
        && existing.contentVersion !== expectedVersion) {
      return res.status(409).json({
        error: 'STALE_REVIEW_VERSION',
        code: 'STALE_REVIEW_VERSION',
        message: `Row contentVersion is ${existing.contentVersion}; expected ${expectedVersion}. Refresh and retry.`,
        currentVersion: existing.contentVersion,
        submittedVersion: expectedVersion,
      });
    }

    // [DR-001] Bind the new intent → the new blobPath, atomically.
    // Same single-element-array adapter as POST so the helper stays
    // happy. A sweep racing the claim makes the tx roll back; the
    // client re-uploads.
    const intentErr = await validatePhotoIntents({
      prisma,
      employeeId: req.employeeId,
      photos: [{ ulid: uploadIntentUlid }],
      context: 'projectAttachment.replace',
      expectedContainer: 'dpr-documents',
      expectedBlobPath: blobPath,
    });
    if (intentErr) return res.status(intentErr.status).json(intentErr.body);

    const updated = await withRecordTransaction(prisma, 'projectAttachment', async (db) => {
      await assertPhotoIntentsBindable({
        tx: db,
        employeeId: req.employeeId,
        photos: [{ ulid: uploadIntentUlid }],
        expectedContainer: 'dpr-documents',
        expectedBlobPath: blobPath,
      });
      // Re-stamp blob fields + reset review state. The audit trail
      // (uploadedById / uploadedAt) is preserved; status reverts to
      // PENDING_REVIEW so the admin's earlier Approve / Reject isn't
      // sitting over a fresh blob they haven't seen yet.
      //
      // [DR-037] Increment contentVersion on every replace so a
      // reviewer holding the OLD version's stale tab gets a 409 on
      // their next PATCH (the review endpoint compares expectedVersion
      // against this row's now-bumped value).
      return db.projectAttachment.update({
        where: { id: attachmentId },
        data: {
          blobPath,
          filename,
          contentType,
          sizeBytes,
          uploadIntentUlid,
          status: 'PENDING_REVIEW',
          reviewedById: null,
          reviewedAt: null,
          reviewNotes: null,
          contentVersion: { increment: 1 },
        },
      });
    });

    res.json(serializeProjectAttachment(updated));
  } catch (err) {
    console.error('[project-attachments] replace-file failed', {
      employeeHash: hashIdentifier(req.employeeId),
      projectId,
      attachmentId,
      errCode: err?.code,
      errMessage: err?.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to replace file' });
  }
}));

// ─── DELETE /api/projects/:projectId/attachments/:attachmentId ───────────────
// Soft-delete via deletedAt. Auth-gated to (admin OR uploader) — matches
// the BoqItem ownership model. Idempotent: a second DELETE on an
// already-deleted row is a 200 with the row as-is (preserves the
// deletedAt timestamp for audit).
//
// 200 → attachment (serialized)
// 400 → VALIDATION_ERROR (bad UUID)
// 403 → NOT_ATTACHMENT_OWNER (non-admin, non-uploader)
// 404 → ATTACHMENT_NOT_FOUND
// 503 → DB_UNAVAILABLE
router.delete('/:attachmentId', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  if (!prisma) {
    return res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });
  }

  const projectId = readProjectId(req);
  const { attachmentId } = req.params;
  if (!isValidUuid(attachmentId)) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'attachmentId must be a UUID' });
  }

  try {
    const row = await prisma.projectAttachment.findUnique({
      where: { id: attachmentId },
    });
    if (!row || row.deletedAt) {
      // Idempotent — already deleted OR never existed returns the
      // same 404. Mirrors drawings.js#DELETE for an already-
      // SUPERSEDED row which is 200; here we choose 404 because
      // "deleted" is terminal and indistinguishable from "missing".
      return res.status(404).json({
        error: 'ATTACHMENT_NOT_FOUND',
        code: 'ATTACHMENT_NOT_FOUND',
        message: 'Attachment not found',
      });
    }
    if (row.projectId !== projectId) {
      return res.status(404).json({
        error: 'ATTACHMENT_NOT_FOUND',
        code: 'ATTACHMENT_NOT_FOUND',
        message: 'Attachment not found',
      });
    }
    // Ownership check — admin OR uploader. uploadedById is nullable
    // (SetNull on employee delete); a row with uploadedById=null was
    // uploaded by a deleted employee, so only an admin can clean it up.
    const isOwner = row.uploadedById && row.uploadedById === req.employeeId;
    if (!req.isAdmin && !isOwner) {
      return res.status(403).json({
        error: 'NOT_ATTACHMENT_OWNER',
        code: 'NOT_ATTACHMENT_OWNER',
        message: 'Only the uploader or an admin may delete this attachment',
      });
    }

    const updated = await prisma.projectAttachment.update({
      where: { id: attachmentId },
      data: { deletedAt: new Date() },
    });
    res.json(serializeProjectAttachment(updated));
  } catch (err) {
    console.error('[project-attachments] delete failed', {
      employeeHash: hashIdentifier(req.employeeId),
      projectId,
      attachmentId,
      errCode: err?.code,
      errMessage: err?.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to delete attachment' });
  }
}));

// ─── PATCH /api/projects/:projectId/attachments/:attachmentId ───────────────
// Admin-only review state machine (S7/MyReports, 2026-09-12).
//
// User feedback: the Project Reports page exposes upload + list +
// download + delete, but admins had no way to Approve / Request
// Revision / Reject a submitted report. Every uploaded report sat in
// the same implicit "unreviewed" state forever. This endpoint closes
// the loop — admins get a one-click state change with an optional
// reason, mirroring InspectionDetail's admin action bar (R36).
//
// State machine (validated server-side):
//
//   PENDING_REVIEW ──► APPROVED          (closes the review)
//   PENDING_REVIEW ──► REVISION_REQUESTED (carries reviewNotes)
//   PENDING_REVIEW ──► REJECTED           (carries reviewNotes)
//   REVISION_REQUESTED ──► APPROVED      (admin accepts the revised copy)
//   REVISION_REQUESTED ──► REJECTED      (admin gives up)
//
//   APPROVED is terminal — re-approving an already-approved row is a
//   no-op 200 (idempotent), but transitioning APPROVED → anything else
//   is a 409 INVALID_TRANSITION (audit semantic: a closed review
//   cannot be silently re-opened). REJECTED is also terminal.
//
// reviewNotes is REQUIRED for REVISION_REQUESTED and REJECTED (so the
// uploader knows what to change), OPTIONAL for APPROVED (free-text
// audit note), and IGNORED on no-op re-approvals.
//
// `requireFreshAdmin` is intentional — mirrors the DR-001 / R36 admin
// mutator contract: a stale JWT could carry isAdmin=true after an
// admin was demoted. Re-reading Employee.isAdmin from the DB on every
// mutation keeps the action bar's contract honest.
//
// 200 → attachment (serialized)
// 400 → VALIDATION_ERROR (bad UUID, bad status, missing notes, notes too long)
// 403 → NOT_ADMIN
// 404 → ATTACHMENT_NOT_FOUND
// 409 → INVALID_TRANSITION
// 503 → DB_UNAVAILABLE
router.patch('/:attachmentId', requireFreshAdmin, asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  if (!prisma) {
    return res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });
  }

  const projectId = readProjectId(req);
  const { attachmentId } = req.params;
  if (!isValidUuid(attachmentId)) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'attachmentId must be a UUID' });
  }

  const body = req.body || {};
  const { status: nextStatus, reviewNotes: rawNotes, expectedVersion } = body;

  // [DR-037] Stale-review guard. SPA captures the row's contentVersion
  // at click-time and echoes it back as expectedVersion. If the row
  // has been replaced or reviewed since (contentVersion bumped), we
  // refuse the write so an admin can't Approve a blob they never saw.
  // Validated here (before the row lookup) so a malformed payload gets
  // a clean 400 rather than a 404-then-409 dance.
  if (expectedVersion !== undefined && expectedVersion !== null) {
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        code: 'INVALID_EXPECTED_VERSION',
        message: 'expectedVersion must be a non-negative integer',
      });
    }
  }

  // Validate the requested target state. Anything outside this set is
  // a 400 — the client is asking for a state we don't model.
  const ALLOWED_TARGETS = new Set(['APPROVED', 'REVISION_REQUESTED', 'REJECTED']);
  if (!nextStatus || !ALLOWED_TARGETS.has(nextStatus)) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      code: 'INVALID_STATUS',
      message: 'status must be one of APPROVED, REVISION_REQUESTED, REJECTED',
    });
  }

  // reviewNotes is optional for APPROVED, required for the other two.
  // Trim + cap length to keep the audit column bounded.
  let reviewNotes = null;
  if (typeof rawNotes === 'string') {
    reviewNotes = rawNotes.trim().slice(0, FIELD_MAX.reviewNotes);
  }
  if ((nextStatus === 'REVISION_REQUESTED' || nextStatus === 'REJECTED') && !reviewNotes) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      code: 'REVIEW_NOTES_REQUIRED',
      message: 'reviewNotes is required when requesting revision or rejecting',
    });
  }

  try {
    const row = await prisma.projectAttachment.findUnique({
      where: { id: attachmentId },
      select: {
        id: true,
        projectId: true,
        status: true,
        deletedAt: true,
        reviewedById: true,
        // [DR-037] Read the current version so we can compare against
        // expectedVersion before stamping status / reviewedById / etc.
        contentVersion: true,
      },
    });
    if (!row || row.deletedAt) {
      return res.status(404).json({
        error: 'ATTACHMENT_NOT_FOUND',
        code: 'ATTACHMENT_NOT_FOUND',
        message: 'Attachment not found',
      });
    }
    if (row.projectId !== projectId) {
      return res.status(404).json({
        error: 'ATTACHMENT_NOT_FOUND',
        code: 'ATTACHMENT_NOT_FOUND',
        message: 'Attachment not found',
      });
    }

    // State machine validation. APPROVED + REJECTED are terminal — once
    // a review closes it stays closed unless explicitly transitioned via
    // REVISION_REQUESTED (which is itself only reachable from a still-
    // open state).
    const fromStatus = row.status || 'PENDING_REVIEW';
    const ALLOWED_TRANSITIONS = {
      PENDING_REVIEW: new Set(['APPROVED', 'REVISION_REQUESTED', 'REJECTED']),
      REVISION_REQUESTED: new Set(['APPROVED', 'REJECTED']),
      APPROVED: new Set(),
      REJECTED: new Set(),
    };
    if (!ALLOWED_TRANSITIONS[fromStatus]?.has(nextStatus)) {
      return res.status(409).json({
        error: 'INVALID_TRANSITION',
        code: 'INVALID_TRANSITION',
        message: `Cannot transition from ${fromStatus} to ${nextStatus}`,
        fromStatus,
        toStatus: nextStatus,
      });
    }

    // [DR-037] Stale-review conflict — the row's contentVersion has
    // moved since the SPA captured it. Most likely a parallel Replace
    // happened (new blob, contentVersion+1); the reviewer's decision
    // would land on bytes they haven't seen. Return 409 with both
    // versions so the SPA can render "refresh and try again" copy
    // instead of silently mutating the unseen blob.
    if (expectedVersion !== undefined && expectedVersion !== null
        && row.contentVersion !== expectedVersion) {
      return res.status(409).json({
        error: 'STALE_REVIEW_VERSION',
        code: 'STALE_REVIEW_VERSION',
        message: `Row contentVersion is ${row.contentVersion}; expected ${expectedVersion}. Refresh and retry.`,
        currentVersion: row.contentVersion,
        submittedVersion: expectedVersion,
      });
    }

    // Stamp reviewedById + reviewedAt in lockstep with the status
    // change so the audit row is consistent — never one without the
    // other. reviewedAt is intentionally always set on a real
    // transition; the client uses its presence to render "Reviewed by"
    // copy.
    //
    // [DR-037] contentVersion bumped on every successful review write
    // so a second reviewer hitting the same row's stale tab also
    // 409s. Monotonic — never decremented.
    const updated = await prisma.projectAttachment.update({
      where: { id: attachmentId },
      data: {
        status: nextStatus,
        reviewedById: req.employeeId,
        reviewedAt: new Date(),
        reviewNotes,
        contentVersion: { increment: 1 },
      },
    });
    res.json(serializeProjectAttachment(updated));
  } catch (err) {
    console.error('[project-attachments] patch (review) failed', {
      employeeHash: hashIdentifier(req.employeeId),
      projectId,
      attachmentId,
      errCode: err?.code,
      errMessage: err?.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to update review status' });
  }
}));

module.exports = router;
