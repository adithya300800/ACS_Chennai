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
//
// Round-35: the cap is now parameterized so a single shared helper can
// serve both the 10 MB photo cap (dpr-photos / inspection-photos) and
// the new 25 MB document cap (dpr-documents). All existing callers pass
// the implicit default — backward-compatible. The new `mountUploadRoutes`
// caller passes a per-container cap via `resolvedMaxBytes(container)`.
function validateSizeBytes(sizeBytes, maxBytes = MAX_PHOTO_SIZE) {
  if (sizeBytes === undefined) return null;
  if (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return { status: 400, body: { error: 'INVALID_SIZE', message: 'sizeBytes must be a positive number' } };
  }
  if (sizeBytes > maxBytes) {
    return { status: 413, body: { error: 'PHOTO_TOO_LARGE', message: `Photo must be 1 byte – ${maxBytes} bytes` } };
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
 *   - Validate sizeBytes against maxSizeBytesPerContainer[container]
 *     ?? MAX_PHOTO_SIZE (Round-35: per-container cap; default 10 MB)
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
    // Round-35: per-container byte cap. e.g. dpr-photos=10 MB,
    // dpr-documents=25 MB. Missing entries fall back to MAX_PHOTO_SIZE
    // (defense in depth — same pattern as allowedTypesPerContainer).
    maxSizeBytesPerContainer = {},
    // [DR-016] Per-container allowlist of path-prefix segments the
    // client may opt into via the `pathPrefix` body field. When a
    // container has an entry, the client MAY pick any of the listed
    // prefixes; the issuer prepends it to the blob name and the
    // returned blobPath keeps the prefix so the downstream save /
    // read / DR-001 binding helpers always see a server-owned,
    // stable key. A container missing from this allowlist means
    // "this container does not support prefixes" — `pathPrefix`
    // body fields are 400'd regardless of value. The DPR mount
    // advertises `{ 'dpr-documents': ['billing'] }` so COP PDF
    // certs land under `billing/<employee>/<ulid>.pdf` while
    // Drawing + Project Report uploads stay unprefixed (their
    // backend readers do not expect a leading segment).
    allowedPathPrefixesPerContainer = {},
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

  // Round-35: per-container size cap. Same defense-in-depth shape as
  // resolvedAllowedTypesFor — missing entry means "use the global
  // default" (MAX_PHOTO_SIZE), not zero-cap. The dpr-documents
  // container is opted into 25 MB by routes/dpr.js; dpr-photos and
  // inspection-photos stay at the 10 MB photo default.
  const resolvedMaxBytes = (container) => {
    if (container && Object.prototype.hasOwnProperty.call(maxSizeBytesPerContainer, container)) {
      return maxSizeBytesPerContainer[container];
    }
    return MAX_PHOTO_SIZE;
  };

  // [DR-016] Per-container path prefix resolver. Returns the
  // requested prefix when the container's allowlist contains it,
  // or null. A container missing from the allowlist is
  // "no-prefixes-supported" — any client-supplied pathPrefix is
  // rejected with 400 below. A missing pathPrefix body field is
  // always OK (a no-op), so unprefixed callers (Drawing, Report)
  // need no knowledge of the field.
  const resolvedPathPrefix = (container, requested) => {
    if (!requested) return null;
    if (typeof requested !== 'string') return null;
    const trimmed = requested.trim();
    if (!trimmed) return null;
    const allowed = allowedPathPrefixesPerContainer[container];
    if (!Array.isArray(allowed) || !allowed.includes(trimmed)) return null;
    return trimmed;
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

    // [DR-016] Validate the client-requested path prefix BEFORE the
    // types / size checks so a malicious value never reaches the
    // issuer. Resolver returns null when the body field is absent
    // (most callers — Drawing / Report — never set it), or when the
    // requested prefix isn't in the container's allowlist. The
    // latter surfaces as 400 INVALID_PATH_PREFIX so a misbehaving
    // client gets an explicit signal instead of a silent
    // unprefixed mint that would later break server-side
    // validation.
    const requestedPrefix = req.body?.pathPrefix;
    const pathPrefix = resolvedPathPrefix(container, requestedPrefix);
    if (requestedPrefix != null && requestedPrefix !== '' && pathPrefix === null) {
      return res.status(400).json({
        error: 'INVALID_PATH_PREFIX',
        message: `pathPrefix is not allowed for ${container}`,
      });
    }

    const allowed = resolvedAllowedTypesFor(container);
    if (!allowed.includes(contentType)) {
      return res.status(400).json({ error: 'INVALID_CONTENT_TYPE', message: `Only ${allowed.join(', ')} allowed for ${container}` });
    }

    const sizeErr = validateSizeBytes(sizeBytes, resolvedMaxBytes(container));
    if (sizeErr) return res.status(sizeErr.status).json(sizeErr.body);

    const ulid = generateULID();

    // [DR-016] The validated prefix is threaded through to the
    // issuer so the returned `blobPath` keeps the server-owned
    // shape (e.g. `billing/<employee>/<ulid>.pdf`). With no prefix
    // the legacy unprefixed shape is preserved — Drawing / Report
    // uploads stay unaffected.
    const { sasUrl, blobPath, expiresAt } = await generateUploadSASUrl(
      container,
      req.employeeId,
      ulid,
      contentType,
      { pathPrefix }
    );

    pendingUploads.set(`${req.employeeId}:${ulid}`, {
      employeeId: req.employeeId,
      container,
      filename,
      contentType,
      blobName: blobPath,
      pathPrefix,
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

    if (sizeBytes <= 0 || sizeBytes > resolvedMaxBytes(container)) {
      return res.status(413).json({ error: 'PHOTO_TOO_LARGE', message: `Photo must be 1 byte – ${resolvedMaxBytes(container)} bytes` });
    }
    const allowed = resolvedAllowedTypesFor(container);
    if (!allowed.includes(contentType)) {
      return res.status(400).json({ error: 'INVALID_CONTENT_TYPE', message: `Only ${allowed.join(', ')} allowed for ${container}` });
    }

    const pendingKey = `${req.employeeId}:${ulid}`;

    // [DR-018] The durable UploadIntent is the authoritative source of
    // truth. The in-process `pendingUploads` Map is a hot-path cache
    // ONLY — it is never consulted to invalidate a still-valid intent.
    // After a process restart, replica switch, or any eviction that
    // drops the in-process entry, the DB row alone must be sufficient
    // to drive a successful confirm before the intent's expiresAt.
    const prisma = req.app && req.app.get('prisma');
    let intent = null;
    let intentLookupFailed = false;
    if (prisma?.uploadIntent) {
      try {
        intent = await prisma.uploadIntent.findUnique({
          where: { employeeId_ulid: { employeeId: req.employeeId, ulid } },
        });
      } catch (err) {
        console.error('[upload/intent] lookup failed', {
          employeeHash: hashIdentifier(req.employeeId),
          ulid,
          errCode: err?.code,
          errMessage: err?.message?.split('\n')[0],
        });
        intentLookupFailed = true;
      }
      if (intentLookupFailed) {
        return res.status(503).json({ error: 'UPLOAD_INTENT_LOOKUP_FAILED', message: 'Could not validate upload intent' });
      }
    }

    if (intent) {
      // Idempotent re-confirm — bytes are already attached to a
      // business record; respond 200 rather than 5xx. Matters because
      // a flaky network can retry /confirm-upload after the server
      // already accepted it.
      if (intent.status === 'CONFIRMED') {
        return res.json({ verified: true, alreadyConfirmed: true });
      }
      // EXPIRED status or expired-by-time → 410.
      if (intent.status === 'EXPIRED' || intent.expiresAt.getTime() < Date.now()) {
        return res.status(410).json({ error: 'INTENT_EXPIRED', message: 'Upload intent has expired; please restart the upload' });
      }
      // PENDING — validate the untrusted request fields against the
      // durable record. The intent owns the canonical container, blob
      // path, and content type; the request is never allowed to
      // override them.
      if (intent.container !== container) {
        return res.status(400).json({ error: 'CONTAINER_MISMATCH', message: 'Container does not match upload intent' });
      }
      if (intent.contentType !== contentType) {
        return res.status(400).json({ error: 'CONTENT_TYPE_MISMATCH', message: 'Content-type does not match upload intent' });
      }

      // CAS: atomic PENDING → CONFIRMED with an expiry guard. If the
      // count is not exactly 1, another confirm already won the race
      // OR expiresAt crossed NOW() between the check above and the
      // CAS. Either way, refuse with 410 — the lost-expiry race must
      // never return a successful confirmation.
      let casCount;
      try {
        const cas = await prisma.uploadIntent.updateMany({
          where: {
            id: intent.id,
            status: 'PENDING',
            expiresAt: { gt: new Date() },
          },
          data: { status: 'CONFIRMED', confirmedAt: new Date() },
        });
        casCount = cas.count || 0;
      } catch (err) {
        console.error('[upload/intent] CAS failed', {
          employeeHash: hashIdentifier(req.employeeId),
          ulid,
          errCode: err?.code,
          errMessage: err?.message?.split('\n')[0],
        });
        return res.status(503).json({ error: 'UPLOAD_INTENT_CONFIRM_FAILED', message: 'Could not confirm upload intent' });
      }

      if (casCount !== 1) {
        return res.status(410).json({ error: 'INTENT_EXPIRED', message: 'Upload intent has expired; please restart the upload' });
      }

      // Server-side blob verification. The blobName is derived from
      // the durable intent record — the canonical owner of the key
      // shape (including any `allowedPathPrefixesPerContainer`
      // prefix). NEVER reconstructed from untrusted request fields.
      try {
        const props = await verifyBlobExists(intent.container, intent.blobPath);
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
          container: intent.container, ulid,
          errMessage: err.message?.split('\n')[0],
        });
        return res.status(502).json({ error: 'BLOB_VERIFICATION_FAILED', message: 'Could not verify upload' });
      }

      // Refresh the in-process Map cache AFTER successful confirmation
      // so subsequent same-process calls can short-circuit. The Map
      // is NEVER consulted above to invalidate an intent.
      pendingUploads.set(pendingKey, {
        employeeId: req.employeeId,
        container: intent.container,
        filename,
        contentType: intent.contentType,
        blobName: intent.blobPath,
        pathPrefix: null,
      });

      return res.json({ verified: true });
    }

    // No durable intent found — fall back to the in-process Map for
    // back-compat (deployments before LPR-012 migration applied, or
    // unit tests that don't wire the intent store). The Map is the
    // source of truth in this branch ONLY.
    const pending = pendingUploads.get(pendingKey);
    if (!pending || pending.employeeId !== req.employeeId) {
      return res.status(404).json({ error: 'BLOB_NOT_FOUND', message: 'Upload not found or unauthorized' });
    }

    // Back-compat blob verification using the Map entry's blobName
    // (the server-issued key), falling back to the legacy shape only
    // when no entry exists — kept for pre-LPR-012 / no-prisma-stub
    // test paths.
    try {
      const blobName = pending.blobName || `${req.employeeId}/${ulid}.${CONTENT_TYPE_EXT[contentType] || 'bin'}`;
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
