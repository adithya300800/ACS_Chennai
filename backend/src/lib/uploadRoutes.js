/**
 * DR-021 (round-20): shared upload routes for DPR + Inspection.
 *
 * Before this refactor, both `src/routes/dpr.js` and `src/routes/inspection.js`
 * had ~80 lines each of nearly-identical upload code:
 *   - The /sas-url handler (content-type allowlist, container allowlist,
 *     MAX_PHOTO_SIZE gate at issue time, pendingUploads registration,
 *     20-min TTL with orphan-blob cleanup).
 *   - The /confirm-upload handler (size verification, content-type
 *     check, blob existence check, 1 KB size tolerance, PII-hashed
 *     error logging).
 *   - The pendingUploads Map (separate instance in each file).
 *   - The MAX_PHOTO_SIZE constant.
 *   - The sweepPendingUpload helper.
 *
 * DR-003's auth + byte-ceiling + orphan-cleanup fixes doubled that
 * duplication. Any future change (e.g. a stricter content-type
 * allowlist, a different storage backend) would have to be made twice
 * and likely drifted.
 *
 * The refactor extracts the shared contract into one module:
 *   - `mountUploadRoutes(router, config)` wires BOTH `/sas-url` and
 *     `/confirm-upload` on the supplied router.
 *   - Two modes:
 *       * "hardcoded" container (Inspection): server picks 'inspection-photos'.
 *       * "client-pick" containers (DPR): client supplies `container`,
 *         server validates against an allowlist.
 *   - Single process-wide pendingUploads Map (keyed by employeeId +
 *     ulid, never collides between routes).
 *   - Single MAX_PHOTO_SIZE + sweepPendingUpload + verifyBlobExists
 *     error-shape policy.
 *
 * Both dpr.js and inspection.js now call this with their own config.
 */

const {
  generateULID,
  generateUploadSASUrl,
  verifyBlobExists,
  deleteBlob,
  CONTENT_TYPE_EXT,
} = require('./blobStorage');
const { hashIdentifier } = require('./pii');

// Shared policy constants. Both routes MUST agree on these — keeping
// them in one place is the whole point of the DR-021 refactor.
const MAX_PHOTO_SIZE = 10 * 1024 * 1024;   // 10 MB
const PENDING_TTL_MS = 20 * 60 * 1000;     // 20 min (long enough for a slow mobile upload, short enough to bound memory)
const SIZE_TOLERANCE_BYTES = 1024;        // 1 KB tolerance for chunked-upload finalization

// Process-wide pending upload registry. Entries are keyed by
// `${employeeId}:${ulid}` and the ulid is server-generated per
// request, so the two consumers (DPR + Inspection) cannot collide.
// One Map, one TTL sweeper, one source of truth.
const pendingUploads = new Map();

// DR-003: best-effort orphan-blob cleanup. When the 20-min TTL fires,
// if the user uploaded bytes to R2 but never called /confirm-upload,
// those bytes become orphaned (unreferenced, paying for storage forever).
// 404 from R2 means the blob never landed — that's fine.
async function sweepPendingUpload({ employeeId, ulid, container, blobName }) {
  try {
    await deleteBlob(container, blobName);
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404) return;
    console.warn('Upload orphan-blob cleanup failed', {
      employeeHash: hashIdentifier(employeeId),
      ulid,
      container,
      errMessage: err.message?.split('\n')[0],
    });
  }
}

// Validate a client-declared sizeBytes. Returns null if OK, or an
// Express response object to send. Used by /sas-url (the gate that
// rejects oversized declarations BEFORE issuing the SAS URL — DR-003).
function validateSizeBytes(sizeBytes) {
  if (sizeBytes === undefined) return null;
  if (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return { status: 400, body: { error: 'INVALID_SIZE', message: 'sizeBytes must be a positive number' } };
  }
  if (sizeBytes > MAX_PHOTO_SIZE) {
    return { status: 413, body: { error: 'PHOTO_TOO_LARGE', message: `Photo must be 1 byte – ${MAX_PHOTO_SIZE} bytes` } };
  }
  return null;
}

/**
 * Mount /sas-url and /confirm-upload on the supplied router.
 *
 * Config:
 *   - allowedTypes: Content-Type allowlist (default: jpeg/png/webp) —
 *     used as the fallback for any container NOT listed in
 *     `allowedTypesPerContainer`.
 *   - allowedTypesPerContainer: per-container override map.
 *     e.g. `{ 'dpr-documents': [...images, 'application/pdf'] }` lets
 *     documents accept PDFs while keeping `dpr-photos` image-only.
 *     Missing containers fall back to `allowedTypes` (defense in depth).
 *   - container: server-hardcoded container name (Inspection-style)
 *   - allowedContainers: array of containers the client may pick
 *     (DPR-style). Mutually exclusive with `container` — pass one
 *     or the other, not both.
 *
 * Both routes:
 *   - Require req.employeeId (mount the function AFTER your auth gate)
 *   - Validate contentType against allowedTypesPerContainer[container]
 *     ?? allowedTypes
 *   - Validate sizeBytes against MAX_PHOTO_SIZE
 *   - Use a per-employeeId ULID-scoped blob path
 *     (a leaked SAS cannot cross tenants)
 *   - Sweep orphaned blobs at PENDING_TTL_MS if /confirm-upload
 *     never landed
 */
function mountUploadRoutes(router, config = {}) {
  if (!router) throw new Error('mountUploadRoutes requires an Express router');
  const {
    allowedTypes = ['image/jpeg', 'image/png', 'image/webp'],
    allowedTypesPerContainer = {},
    container: hardcodedContainer,
    allowedContainers,
  } = config;

  // Per-route resolver: lookup the per-container allowlist if present,
  // otherwise fall back to the default allowedTypes. A missing entry
  // (rather than an empty array) means "use the default" — that's the
  // defense-in-depth property: if a caller forgets to opt a new
  // container into PDF support, the new container is image-only by
  // default, not zero-allowlist.
  const resolvedAllowedTypesFor = (container) => {
    if (container && Object.prototype.hasOwnProperty.call(allowedTypesPerContainer, container)) {
      return allowedTypesPerContainer[container];
    }
    return allowedTypes;
  };

  if (!hardcodedContainer && (!allowedContainers || allowedContainers.length === 0)) {
    throw new Error('mountUploadRoutes requires either `container` (hardcoded) or `allowedContainers` (client-pick)');
  }
  if (hardcodedContainer && allowedContainers) {
    throw new Error('mountUploadRoutes: pass `container` OR `allowedContainers`, not both');
  }

  // Mode 1: hardcoded container (Inspection). Client doesn't send
  // `container`; the server uses `hardcodedContainer` directly.
  // Mode 2: client-pick container (DPR). Client must send `container`
  // and it must be in `allowedContainers`.
  const pickContainer = (body) => {
    if (hardcodedContainer) return hardcodedContainer;
    return body.container;
  };
  const validateContainer = (container, res) => {
    if (!container) {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: 'container required' });
      return false;
    }
    // Hardcoded mode: server picks the container, no allowlist check
    // needed (and `allowedContainers` is undefined). Client-pick mode:
    // verify against the allowlist. Calling `.includes` on undefined
    // here used to crash the route with a TypeError → 500 (DR-014
    // mounted-app integration suite surfaced it; the existing isolated
    // uploadRoutes.test.js "hardcoded" cases had been timing out for the
    // same reason).
    if (allowedContainers && !allowedContainers.includes(container)) {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid container' });
      return false;
    }
    return true;
  };

  // ─── POST /sas-url ─────────────────────────────────────────────────────
  router.post('/sas-url', async (req, res) => {
    const { filename, contentType, sizeBytes } = req.body || {};

    if (!filename || !contentType) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'filename, contentType required' });
    }
    const container = pickContainer(req.body);
    if (!validateContainer(container, res)) return;

    const allowed = resolvedAllowedTypesFor(container);
    if (!allowed.includes(contentType)) {
      return res.status(400).json({ error: 'INVALID_CONTENT_TYPE', message: `Only ${allowed.join(', ')} allowed for ${container}` });
    }

    const sizeErr = validateSizeBytes(sizeBytes);
    if (sizeErr) return res.status(sizeErr.status).json(sizeErr.body);

    const ulid = generateULID();

    // Blob scoped under `${employeeId}/${ulid}.${ext}` so a leaked
    // SAS cannot cross tenants. Extension derived from validated
    // contentType, NEVER from user-supplied filename.
    const { sasUrl, blobPath, expiresAt } = await generateUploadSASUrl(
      container,
      req.employeeId,
      ulid,
      contentType
    );

    pendingUploads.set(`${req.employeeId}:${ulid}`, {
      employeeId: req.employeeId,
      container,
      filename,
      contentType,
      blobName: blobPath,
    });

    // LPR-012: persist an UploadIntent row BEFORE returning the SAS
    // URL. If the DB write fails, do not return a usable SAS — the
    // /confirm-upload handler would have nothing to mark CONFIRMED.
    // The intent is the durable handshake; the Map is just the
    // hot-path cache.
    const prisma = req.app && req.app.get('prisma');
    if (prisma?.uploadIntent) {
      try {
        await prisma.uploadIntent.create({
          data: {
            employeeId: req.employeeId,
            ulid,
            container,
            blobPath,
            contentType,
            status: 'PENDING',
            expiresAt: new Date(Date.now() + PENDING_TTL_MS),
          },
        });
      } catch (err) {
        // Roll back the Map entry we just inserted (don't leak it).
        pendingUploads.delete(`${req.employeeId}:${ulid}`);
        console.error('[upload/intent] create failed', {
          employeeHash: hashIdentifier(req.employeeId),
          ulid,
          container,
          errCode: err?.code,
          errMessage: err?.message?.split('\n')[0],
        });
        return res.status(503).json({ error: 'UPLOAD_INTENT_CREATE_FAILED', message: 'Could not register upload intent' });
      }
    }

    // 20-min TTL: bound the in-memory map AND clean up any orphaned
    // R2 blob if the user never confirmed.
    setTimeout(() => {
      const key = `${req.employeeId}:${ulid}`;
      const entry = pendingUploads.get(key);
      pendingUploads.delete(key);
      if (entry) {
        sweepPendingUpload({
          employeeId: entry.employeeId,
          ulid,
          container: entry.container,
          blobName: entry.blobName,
        }).catch(() => {});
      }
    }, PENDING_TTL_MS).unref();

    res.json({ sasUrl, ulid, blobPath, expiresAt });
  });

  // ─── POST /confirm-upload ──────────────────────────────────────────────
  router.post('/confirm-upload', async (req, res) => {
    const { ulid, filename, contentType, sizeBytes } = req.body || {};

    if (!ulid || !filename || !contentType || sizeBytes === undefined) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'All fields required' });
    }
    const container = pickContainer(req.body);
    if (!validateContainer(container, res)) return;

    if (sizeBytes <= 0 || sizeBytes > MAX_PHOTO_SIZE) {
      return res.status(413).json({ error: 'PHOTO_TOO_LARGE', message: `Photo must be 1 byte – ${MAX_PHOTO_SIZE} bytes` });
    }
    const allowed = resolvedAllowedTypesFor(container);
    if (!allowed.includes(contentType)) {
      return res.status(400).json({ error: 'INVALID_CONTENT_TYPE', message: `Only ${allowed.join(', ')} allowed for ${container}` });
    }

    const pendingKey = `${req.employeeId}:${ulid}`;

    // LPR-012: durable ownership + lifecycle check FIRST. The DB row is
    // the source of truth — a cleared/evicted in-process Map entry must
    // not be allowed to invalidate a still-valid intent (e.g. after a
    // process restart, or after the first successful confirm-upload
    // already deleted the Map entry below).
    const prisma = req.app && req.app.get('prisma');
    if (prisma?.uploadIntent) {
      try {
        const intent = await prisma.uploadIntent.findUnique({
          where: { employeeId_ulid: { employeeId: req.employeeId, ulid } },
        });
        if (!intent) {
          // No DB row at all — fall back to the in-process Map for
          // back-compat (deployments before LPR-012 migration applied,
          // or unit tests that don't wire the intent store).
          const pending = pendingUploads.get(pendingKey);
          if (!pending || pending.employeeId !== req.employeeId) {
            return res.status(404).json({ error: 'BLOB_NOT_FOUND', message: 'Upload not found or unauthorized' });
          }
        } else if (intent.status === 'CONFIRMED') {
          // Idempotent re-confirm — bytes are already attached to a
          // business record; respond 200 rather than 5xx. Matters
          // because a flaky network can retry /confirm-upload after
          // the server already accepted it.
          return res.json({ verified: true, alreadyConfirmed: true });
        } else if (intent.status === 'EXPIRED' || intent.expiresAt.getTime() < Date.now()) {
          return res.status(410).json({ error: 'INTENT_EXPIRED', message: 'Upload intent has expired; please restart the upload' });
        } else {
          // PENDING — also require the Map entry as defence-in-depth
          // (a future refactor that clears the Map on /sas-url MUST
          // update this branch).
          const pending = pendingUploads.get(pendingKey);
          if (!pending || pending.employeeId !== req.employeeId) {
            return res.status(404).json({ error: 'BLOB_NOT_FOUND', message: 'Upload not found or unauthorized' });
          }
        }
      } catch (err) {
        console.error('[upload/intent] lookup failed', {
          employeeHash: hashIdentifier(req.employeeId),
          ulid,
          errCode: err?.code,
          errMessage: err?.message?.split('\n')[0],
        });
        return res.status(503).json({ error: 'UPLOAD_INTENT_LOOKUP_FAILED', message: 'Could not validate upload intent' });
      }
    } else {
      // No prisma wired (unit tests that don't care about intents).
      const pending = pendingUploads.get(pendingKey);
      if (!pending || pending.employeeId !== req.employeeId) {
        return res.status(404).json({ error: 'BLOB_NOT_FOUND', message: 'Upload not found or unauthorized' });
      }
    }

    // Server-side blob verification — derive the same scoped blob
    // name and confirm the bytes actually landed with the claimed
    // size + content-type.
    try {
      const ext = CONTENT_TYPE_EXT[contentType];
      const blobName = `${req.employeeId}/${ulid}.${ext}`;
      const props = await verifyBlobExists(container, blobName);
      if (!props.exists) {
        return res.status(404).json({ error: 'BLOB_NOT_UPLOADED', message: 'Photo bytes not found in storage' });
      }
      if (props.contentType && props.contentType !== contentType) {
        return res.status(400).json({ error: 'CONTENT_TYPE_MISMATCH', message: 'Uploaded content-type does not match request' });
      }
      if (Math.abs((props.contentLength || 0) - sizeBytes) > SIZE_TOLERANCE_BYTES) {
        return res.status(400).json({ error: 'SIZE_MISMATCH', message: 'Uploaded size does not match declared size' });
      }
    } catch (err) {
      console.error('Upload blob verification failed', {
        employeeHash: hashIdentifier(req.employeeId),
        container, ulid,
        errMessage: err.message?.split('\n')[0],
      });
      return res.status(502).json({ error: 'BLOB_VERIFICATION_FAILED', message: 'Could not verify upload' });
    }

    pendingUploads.delete(pendingKey);

    // LPR-012: mark the intent CONFIRMED so a future confirm-upload
    // call returns idempotently and so the orphan-cleanup cron knows
    // this blob is bound to a business record.
    if (prisma?.uploadIntent) {
      try {
        await prisma.uploadIntent.update({
          where: { employeeId_ulid: { employeeId: req.employeeId, ulid } },
          data: { status: 'CONFIRMED', confirmedAt: new Date() },
        });
      } catch (err) {
        // Log but do not fail the response — the bytes are verified,
        // the client got what they needed. The next orphan sweep will
        // see the intent as PENDING and skip the blob (status !=
        // EXPIRED, and we don't sweep CONFIRMED-but-still-referenced).
        console.warn('[upload/intent] mark-confirmed failed', {
          employeeHash: hashIdentifier(req.employeeId),
          ulid,
          errCode: err?.code,
          errMessage: err?.message?.split('\n')[0],
        });
      }
    }

    res.json({ verified: true });
  });
}

module.exports = {
  mountUploadRoutes,
  MAX_PHOTO_SIZE,
  PENDING_TTL_MS,
  SIZE_TOLERANCE_BYTES,
  // Exported for tests + advanced use cases:
  pendingUploads,
  sweepPendingUpload,
  validateSizeBytes,
};
