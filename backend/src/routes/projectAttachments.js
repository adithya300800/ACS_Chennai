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
//   DELETE /:attachmentId                    soft-delete via deletedAt.
//                                             Auth-gated to (admin OR
//                                             uploader) — matches the Boq
//                                             item deletion policy.
//
// Auth model:
//   - requireAuth on every route.
//   - `requireProjectScope` middleware (private to this module) checks
//     the project exists + isActive — returns 404 PROJECT_NOT_FOUND
//     otherwise. Mirrors the project-existence pre-check in
//     drawings.js#POST /api/drawings.
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
const { requireAuth } = require('../middleware/auth');
const { mapPrismaError } = require('../lib/errors');
const { hashIdentifier } = require('../lib/pii');
const { randomUUID } = require('crypto');
const { generateReadSASUrl, READ_URL_TTL_SECONDS } = require('../lib/blobStorage');

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
    uploadedById: row.uploadedById,
    uploadedAt: row.uploadedAt instanceof Date ? row.uploadedAt.toISOString() : row.uploadedAt,
    deletedAt: row.deletedAt instanceof Date ? row.deletedAt.toISOString() : row.deletedAt,
  };
}

// ─── requireProjectScope ────────────────────────────────────────────────────
// All routes except DELETE go through this gate — confirms the project
// exists and is active. DELETE also gates per-attachment ownership below.
// 404 PROJECT_NOT_FOUND rather than 403 so a leaked URL can't enumerate
// archived projects by existence.
async function requireProjectScope(req, res, next) {
  const prisma = getPrisma(req);
  if (!prisma) {
    return res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });
  }
  const { projectId } = req.params;
  if (!projectId || !isValidUuid(projectId)) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', code: 'PROJECT_ID_INVALID', message: 'projectId must be a UUID' });
  }
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, isActive: true },
    });
    if (!project || !project.isActive) {
      return res.status(404).json({
        error: 'PROJECT_NOT_FOUND',
        code: 'PROJECT_NOT_FOUND',
        message: 'Linked project does not exist or is archived',
      });
    }
    next();
  } catch (err) {
    console.error('[project-attachments] project scope check failed', {
      employeeHash: hashIdentifier(req.employeeId),
      projectId,
      errCode: err?.code,
      errMessage: err?.message?.split('\n')[0],
    });
    return res.status(503).json({ error: 'PROJECT_SCOPE_CHECK_FAILED', message: 'Could not verify project' });
  }
}

router.use(requireAuth);
router.use(requireProjectScope);

// ─── GET /api/projects/:projectId/attachments ───────────────────────────────
// List attachments for a project, newest first. Excludes soft-deleted
// rows. ?type= filter narrows to one of the 5 enum values.
//
// 200 → { attachments: [...] }
// 400 → VALIDATION_ERROR (bad projectId UUID, unknown ?type)
// 404 → PROJECT_NOT_FOUND
// 503 → DB_UNAVAILABLE
router.get('/', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  if (!prisma) {
    return res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });
  }

  const { projectId } = req.params;
  const { type } = req.query;

  if (type && !VALID_REPORT_TYPES.has(type)) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      code: 'INVALID_TYPE',
      message: `type must be one of: ${Array.from(VALID_REPORT_TYPES).join(', ')}`,
    });
  }

  try {
    const rows = await prisma.projectAttachment.findMany({
      where: {
        projectId,
        deletedAt: null,
        ...(type ? { type } : {}),
      },
      orderBy: [{ uploadedAt: 'desc' }, { id: 'desc' }],
      take: 100,
    });
    res.setHeader('X-Total-Count', rows.length);
    res.json({ attachments: rows.map(serializeProjectAttachment) });
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

  const { projectId } = req.params;
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
  if (!body.type || !VALID_REPORT_TYPES.has(body.type)) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      code: 'INVALID_TYPE',
      message: `type must be one of: ${Array.from(VALID_REPORT_TYPES).join(', ')}`,
    });
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

  try {
    const row = await prisma.projectAttachment.create({
      data: {
        id: randomUUID(),
        projectId,
        type: body.type,
        title: body.title ? body.title.trim() : null,
        filename: body.filename.trim(),
        contentType: body.contentType,
        sizeBytes: body.sizeBytes,
        blobPath: body.blobPath,
        uploadedById: req.employeeId,
      },
    });
    res.status(201).json(serializeProjectAttachment(row));
  } catch (err) {
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

  const { projectId, attachmentId } = req.params;
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

  const { projectId, attachmentId } = req.params;
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

module.exports = router;
