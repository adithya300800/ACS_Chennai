'use strict';

const express = require('express');
const { randomUUID } = require('crypto');
const { requireAuth } = require('../middleware/auth');
const boqStorage = require('../lib/boqStorage');
const {
  reserve: reserveIdempotency,
  complete: completeIdempotency,
  release: releaseIdempotency,
} = require('../lib/idempotency');

const router = express.Router();
const BUCKET = boqStorage.DEFAULT_BUCKET;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;
const MAX_FILES = 20;
const MAX_FILENAME_LENGTH = 200;
const ALLOWED_EXTENSIONS = new Set(['dxf', 'ifc']);

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function getPrisma(req) {
  return req.app.get('prisma');
}

function errorBody(error, message, extra = {}) {
  return { error, code: error, message, ...extra };
}

function sanitizeFilename(filename) {
  if (typeof filename !== 'string' || !filename.trim() || filename.length > 1024) return null;
  const basename = filename.replace(/\\/g, '/').split('/').pop().trim().replace(/[\u0000-\u001f\u007f]/g, '');
  if (!basename || basename.length > MAX_FILENAME_LENGTH) return null;
  const extension = basename.includes('.') ? basename.split('.').pop().toLowerCase() : '';
  if (!ALLOWED_EXTENSIONS.has(extension)) return null;
  return { filename: basename, extension };
}

function sniffFile(prefix, extension) {
  const bytes = Buffer.isBuffer(prefix) ? prefix : Buffer.from(prefix || '');
  const text = bytes.toString('utf8');
  let detected;
  if (text.startsWith('AutoCAD Binary DXF')) detected = 'dxf';
  else if (text.startsWith('ISO-10303-21')) detected = 'ifc';
  else if (/^\s*0[\r\n]+\s*SECTION\b/i.test(text)) detected = 'dxf';
  else if (text.startsWith('%PDF-')) return { error: 'PDF_NOT_SUPPORTED' };
  else return { error: 'UNSUPPORTED_FILE_TYPE' };
  return detected === extension ? { fileType: detected } : { error: 'FILE_EXTENSION_MISMATCH' };
}

async function activeProjectAccess(prisma, projectId, employeeId) {
  const [project, employee] = await Promise.all([
    prisma.project.findUnique({ where: { id: projectId }, select: { id: true, isActive: true } }),
    prisma.employee.findUnique({ where: { id: employeeId }, select: { isAdmin: true } }),
  ]);
  if (!project || !project.isActive || !employee) return false;
  if (employee.isAdmin) return true;
  const assignment = await prisma.projectAssignment.findUnique({
    where: { projectId_employeeId: { projectId, employeeId } },
    select: { id: true },
  });
  return Boolean(assignment);
}

async function respondUnauthorizedProject(res) {
  return res.status(404).json(errorBody('NOT_FOUND', 'Resource not found'));
}

async function rejectReservedRequest(prisma, reservation, res, status, body) {
  await releaseIdempotency({ prisma, reservation });
  return res.status(status).json(body);
}

function sanitizeJob(job) {
  return {
    id: job.id,
    projectId: job.projectId,
    status: job.status,
    dataStatus: job.dataStatus,
    productionMode: job.productionMode,
    dxfScale: job.dxfScale,
    revision: job.revision,
    settings: job.settingsJson,
    files: Array.isArray(job.inputFiles) ? job.inputFiles.map((file) => ({
      uploadId: file.uploadId,
      filename: file.filename,
      fileType: file.fileType,
      sizeBytes: file.sizeBytes,
    })) : [],
    error: job.errorCode ? { code: job.errorCode, message: job.errorMessage } : null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
  };
}

router.use(requireAuth);

router.post('/uploads/presign', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const { projectId, filename, sizeBytes } = req.body || {};
  const safeName = sanitizeFilename(filename);
  if (typeof projectId !== 'string' || !projectId || !safeName) {
    return res.status(400).json(errorBody('VALIDATION_ERROR', 'projectId and a .dxf or .ifc filename are required'));
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    return res.status(400).json(errorBody('INVALID_SIZE', 'sizeBytes must be a positive integer'));
  }
  if (sizeBytes > MAX_FILE_BYTES) {
    return res.status(413).json(errorBody('BOQ_FILE_TOO_LARGE', `Each drawing must be no larger than ${MAX_FILE_BYTES} bytes`));
  }
  if (!await activeProjectAccess(prisma, projectId, req.employeeId)) return respondUnauthorizedProject(res);

  const uploadId = boqStorage.generateULID();
  const signed = await boqStorage.createUploadUrl({
    projectId,
    employeeId: req.employeeId,
    uploadId,
    extension: safeName.extension,
  });
  await prisma.uploadIntent.create({
    data: {
      employeeId: req.employeeId,
      ulid: uploadId,
      container: boqStorage.bucketName(),
      blobPath: signed.blobPath,
      contentType: 'application/octet-stream',
      expectedSizeBytes: sizeBytes,
      projectId,
      originalFilename: safeName.filename,
      status: 'PENDING',
      expiresAt: new Date(signed.expiresAt),
    },
  });
  return res.status(201).json({ uploadId, sasUrl: signed.sasUrl, blobPath: signed.blobPath, expiresAt: signed.expiresAt });
}));

router.post('/uploads/confirm', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const { uploadId } = req.body || {};
  if (typeof uploadId !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(uploadId)) {
    return res.status(400).json(errorBody('VALIDATION_ERROR', 'uploadId must be a valid upload id'));
  }
  const intent = await prisma.uploadIntent.findUnique({
    where: { employeeId_ulid: { employeeId: req.employeeId, ulid: uploadId } },
  });
  if (!intent || intent.container !== boqStorage.bucketName() || !intent.projectId ||
      !await activeProjectAccess(prisma, intent.projectId, req.employeeId)) {
    return respondUnauthorizedProject(res);
  }
  if (intent.status === 'CONFIRMED' && intent.verifiedAt && intent.verifiedSizeBytes === intent.expectedSizeBytes) {
    return res.json({ uploadId, verified: true, sizeBytes: intent.verifiedSizeBytes });
  }
  if (intent.status !== 'PENDING' || intent.expiresAt <= new Date()) {
    return res.status(409).json(errorBody('UPLOAD_INTENT_EXPIRED', 'The upload intent is no longer available; upload the file again'));
  }

  let verified;
  try {
    verified = await boqStorage.verifyUpload(intent.blobPath);
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404) {
      return res.status(400).json(errorBody('UPLOAD_NOT_FOUND', 'The uploaded object was not found'));
    }
    console.warn('[boq-generator] upload verification failed', { code: err?.name, status: err?.$metadata?.httpStatusCode });
    return res.status(502).json(errorBody('UPLOAD_VERIFY_FAILED', 'Could not verify the uploaded drawing; retry shortly'));
  }
  if (verified.contentLength !== intent.expectedSizeBytes) {
    return res.status(400).json(errorBody('UPLOAD_SIZE_MISMATCH', 'Uploaded size does not match the declared size', {
      expectedSizeBytes: intent.expectedSizeBytes,
      actualSizeBytes: verified.contentLength,
    }));
  }
  if (verified.contentType !== 'application/octet-stream') {
    return res.status(400).json(errorBody('UPLOAD_CONTENT_TYPE_MISMATCH', 'The upload must use application/octet-stream'));
  }
  const detected = sniffFile(verified.prefix, intent.originalFilename.split('.').pop().toLowerCase());
  if (detected.error) {
    const message = detected.error === 'PDF_NOT_SUPPORTED'
      ? 'PDF drawings are not supported; upload DXF or IFC'
      : 'The uploaded bytes do not match a supported DXF or IFC file';
    return res.status(400).json(errorBody(detected.error, message));
  }

  const verifiedAt = new Date();
  const result = await prisma.uploadIntent.updateMany({
    where: {
      id: intent.id,
      employeeId: req.employeeId,
      container: boqStorage.bucketName(),
      projectId: intent.projectId,
      status: 'PENDING',
      boundAt: null,
      expiresAt: { gt: verifiedAt },
    },
    data: {
      status: 'CONFIRMED',
      confirmedAt: verifiedAt,
      verifiedAt,
      verifiedSizeBytes: verified.contentLength,
      verifiedContentType: 'application/octet-stream',
    },
  });
  if (!result || result.count !== 1) {
    const current = await prisma.uploadIntent.findUnique({
      where: { employeeId_ulid: { employeeId: req.employeeId, ulid: uploadId } },
    });
    if (current?.status === 'CONFIRMED' && current.verifiedAt && current.verifiedSizeBytes === current.expectedSizeBytes) {
      return res.json({ uploadId, verified: true, sizeBytes: current.verifiedSizeBytes });
    }
    return res.status(409).json(errorBody('UPLOAD_INTENT_CHANGED', 'The upload intent changed during verification; retry'));
  }
  return res.json({ uploadId, verified: true, sizeBytes: verified.contentLength, fileType: detected.fileType });
}));

router.post('/jobs', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const body = req.body || {};
  const { projectId, uploads, dxfScale, rateSource, wastagePct } = body;
  const idempotencyKey = req.headers['idempotency-key'];
  if (typeof idempotencyKey !== 'string' || !idempotencyKey.length || idempotencyKey.length > 128) {
    return res.status(400).json(errorBody('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required and must be at most 128 characters'));
  }
  if (typeof projectId !== 'string' || !projectId || !Array.isArray(uploads) || uploads.length < 1 || uploads.length > MAX_FILES ||
      uploads.some((uploadId) => typeof uploadId !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(uploadId)) ||
      new Set(uploads).size !== uploads.length) {
    return res.status(400).json(errorBody('VALIDATION_ERROR', `projectId and 1-${MAX_FILES} unique upload ids are required`));
  }
  if (dxfScale !== undefined && dxfScale !== null && (typeof dxfScale !== 'number' || !Number.isFinite(dxfScale) || dxfScale <= 0)) {
    return res.status(400).json(errorBody('VALIDATION_ERROR', 'dxfScale must be a positive finite number'));
  }
  if (wastagePct !== undefined && wastagePct !== null && (typeof wastagePct !== 'number' || !Number.isFinite(wastagePct) || wastagePct < 0 || wastagePct > 100)) {
    return res.status(400).json(errorBody('VALIDATION_ERROR', 'wastagePct must be between 0 and 100'));
  }
  if (rateSource !== undefined && rateSource !== null && (typeof rateSource !== 'string' || rateSource.length > 100)) {
    return res.status(400).json(errorBody('VALIDATION_ERROR', 'rateSource must be a string up to 100 characters'));
  }
  if (!await activeProjectAccess(prisma, projectId, req.employeeId)) return respondUnauthorizedProject(res);

  const reservation = await reserveIdempotency({ prisma, route: 'boqGenerator.create', req });
  if (reservation.mismatch) return res.status(409).json(errorBody('IDEMPOTENCY_MISMATCH', 'Idempotency-Key was used for a different request body'));
  if (reservation.replay && reservation.cached) {
    return res.set('Idempotent-Replay', 'true').status(reservation.cached.status || 201).json(reservation.cached.body);
  }
  if (reservation.conflict) {
    return res.status(409).json(errorBody('IDEMPOTENCY_CONFLICT', reservation.poisoned
      ? 'A previous request with this Idempotency-Key failed; use a new key'
      : 'A request with this Idempotency-Key is already in progress'));
  }

  let intents;
  try {
    intents = await prisma.uploadIntent.findMany({
      where: {
        employeeId: req.employeeId,
        ulid: { in: uploads },
        container: boqStorage.bucketName(),
        projectId,
        status: 'CONFIRMED',
        boundAt: null,
      },
      select: {
        id: true, ulid: true, employeeId: true, projectId: true, container: true,
        blobPath: true, originalFilename: true, expectedSizeBytes: true,
        verifiedSizeBytes: true, verifiedAt: true,
      },
    });
  } catch (err) {
    await releaseIdempotency({ prisma, reservation });
    throw err;
  }
  if (intents.length !== uploads.length || intents.some((intent) =>
    !intent.verifiedAt || !Number.isSafeInteger(intent.expectedSizeBytes) ||
    intent.expectedSizeBytes !== intent.verifiedSizeBytes || intent.verifiedSizeBytes <= 0 || intent.verifiedSizeBytes > MAX_FILE_BYTES)) {
    return rejectReservedRequest(prisma, reservation, res, 400,
      errorBody('UPLOAD_NOT_CONFIRMED', 'Every upload must be verified, confirmed, and belong to this project'));
  }
  const totalBytes = intents.reduce((total, intent) => total + intent.verifiedSizeBytes, 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    return rejectReservedRequest(prisma, reservation, res, 413,
      errorBody('BOQ_TOTAL_TOO_LARGE', `Combined drawings must be no larger than ${MAX_TOTAL_BYTES} bytes`));
  }
  const byUlid = new Map(intents.map((intent) => [intent.ulid, intent]));
  const orderedIntents = uploads.map((uploadId) => byUlid.get(uploadId));
  const settings = {
    ...(rateSource !== undefined ? { rateSource } : {}),
    ...(wastagePct !== undefined ? { wastagePct } : {}),
  };
  const inputFiles = orderedIntents.map((intent) => ({
    uploadId: intent.ulid,
    filename: intent.originalFilename,
    fileType: intent.originalFilename.split('.').pop().toLowerCase(),
    contentType: 'application/octet-stream',
    sizeBytes: intent.verifiedSizeBytes,
    blobPath: intent.blobPath,
  }));
  const jobId = randomUUID();
  const now = new Date();
  const job = {
    id: jobId,
    employeeId: req.employeeId,
    projectId,
    status: 'DRAFT',
    dxfScale: dxfScale ?? null,
    scaleConfirmedBy: dxfScale != null ? req.employeeId : null,
    scaleConfirmedAt: dxfScale != null ? now : null,
    idempotencyKey,
    settingsJson: settings,
    inputFiles,
    updatedAt: now,
  };
  const responseBody = {
    id: jobId,
    projectId,
    status: 'DRAFT',
    dxfScale: dxfScale ?? null,
    settings,
    files: inputFiles.map(({ uploadId, filename, fileType, sizeBytes }) => ({ uploadId, filename, fileType, sizeBytes })),
    createdAt: now,
  };
  try {
    const createJob = async (db) => {
      const claim = await db.uploadIntent.updateMany({
        where: {
          employeeId: req.employeeId,
          ulid: { in: uploads },
          container: boqStorage.bucketName(),
          projectId,
          status: 'CONFIRMED',
          boundAt: null,
          verifiedAt: { not: null },
          verifiedSizeBytes: { gt: 0 },
        },
        data: { boundType: 'boq_job', boundAt: now },
      });
      if (!claim || claim.count !== uploads.length) {
        const lost = new Error('BOQ upload binding was lost');
        lost.code = 'BOQ_UPLOAD_BINDING_LOST';
        throw lost;
      }
      const created = await db.boqJob.create({ data: job });
      if (reservation.namespacedKey && !reservation.legacy && db.requestDedupe) {
        await completeIdempotency({
          prisma: db,
          reservation,
          status: 201,
          body: responseBody,
          recordKind: 'boqJob',
          recordId: jobId,
        });
      }
      return created;
    };

    if (typeof prisma.$transaction === 'function') {
      await prisma.$transaction((tx) => createJob(tx), { isolationLevel: 'Serializable' });
    } else {
      await createJob(prisma);
    }
    if (reservation.legacy || !reservation.namespacedKey) {
      await completeIdempotency({ prisma, reservation, status: 201, body: responseBody, recordKind: 'boqJob', recordId: jobId });
    }
    return res.status(201).json(responseBody);
  } catch (err) {
    try {
      await releaseIdempotency({ prisma, reservation });
    } catch (releaseError) {
      console.warn('[boq-generator] idempotency reservation release failed', { code: releaseError?.code });
    }
    if (err?.code === 'BOQ_UPLOAD_BINDING_LOST' || err?.code === 'P2002' || err?.code === 'P2034') {
      return res.status(409).json(errorBody(err.code === 'BOQ_UPLOAD_BINDING_LOST' ? 'UPLOAD_ALREADY_CLAIMED' : 'IDEMPOTENCY_CONFLICT',
        'The upload or request was claimed by another request; retry with a fresh upload or key'));
    }
    throw err;
  }
}));

router.get('/jobs/:boqJobId', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const job = await prisma.boqJob.findUnique({ where: { id: req.params.boqJobId } });
  if (!job || !await activeProjectAccess(prisma, job.projectId, req.employeeId)) return respondUnauthorizedProject(res);
  return res.json(sanitizeJob(job));
}));

router.get('/jobs/:boqJobId/boq', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const job = await prisma.boqJob.findUnique({
    where: { id: req.params.boqJobId },
    select: { id: true, projectId: true },
  });
  if (!job || !await activeProjectAccess(prisma, job.projectId, req.employeeId)) return respondUnauthorizedProject(res);
  const snapshot = await prisma.boqSnapshot.findFirst({
    where: { boqJobId: job.id },
    orderBy: { revision: 'desc' },
  });
  if (!snapshot) return res.status(404).json(errorBody('BOQ_NOT_SAVED', 'No saved BOQ snapshot is available'));
  const document = await boqStorage.readSnapshot(snapshot.snapshotBlobPath);
  return res.json(document);
}));

module.exports = router;