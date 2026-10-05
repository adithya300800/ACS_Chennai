/**
 * [Payslips Stage 1 / commit 3] Pure payslip helpers.
 *
 * Owns:
 *   * `verifyBlobMagicBytes` — three-state PDF magic-bytes check
 *     (matches the DR-007 contract that verifyBlobExists uses, so a future
 *     caller can branch on outcome==null|false|true without learning
 *     a new vocabulary).
 *   * `serializePayslipForWire` — BigInt-safe JSON serializer. Prisma's
 *     `sizeBytes` is BigInt because the cap is 25 MB and a future >2 GB
 *     upload must not silently wrap; `JSON.stringify(BigInt)` throws,
 *     so every wire response has to walk the row and `.toString()` the
 *     bigints before they touch the JSON.stringify path. Same shape as
 *     BoqExecution's serializeInspectionRecordForWire (round-26).
 *   * `bindPayslipToIntent` — transactionally promotes an UploadIntent
 *     row (CONFIRMED) to a Payslip row. Validates the blobPath's
 *     `payslips/` prefix, the PDF magic bytes, and the (employee_id,
 *     year, month) partial-unique pre-conditions. Marks the intent
 *     boundType='payslip' so the durable sweep (commit 2) leaves the
 *     blob alone.
 *   * `publishPayslip` — per-row late publish. Stamps
 *     publishedAt/publishedById in its OWN transaction; one failure
 *     doesn't roll back others. Returns `{ published, failed }` so
 *     the route can surface the partial-success state.
 *   * `revokePayslip` — soft-delete (sets deletedAt, revokedAt,
 *     revokedById, revokedReason) inside a transaction. The R2 blob
 *     is left intact; the sweep's `purgedAt IS NULL` predicate means
 *     only the operator-driven purge script retires bytes for
 *     revoked rows.
 *   * `sendPayslipEmail` — async Resend send. Fired via setImmediate
 *     from publishPayslip so the publish HTTP response returns
 *     immediately. Stamps emailStatus on the row after the send
 *     attempt. No salary figures, no SAS URL, no recipient id in
 *     the email body — the link is to the backend's own download
 *     endpoint, not to R2.
 *
 * Privacy discipline (cross-cutting, mirrors plan §C.4):
 *   * No real employee data — every helper accepts whatever it gets
 *     and trusts the route-layer input validation.
 *   * No salary figures in error messages, logs, or audit strings.
 *     `sanitizeAuditReason` rejects substrings that look like salary
 *     tokens before they touch revokedReason / email_failed_reason.
 *
 * Threat model (cross-cutting):
 *   * The serialize / send paths are untrusted-input-from-a-DB-row.
 *     A future schema-drift bug must NOT leak payroll metadata:
 *     serializePayslipForWire returns ONLY the documented columns,
 *     and the email body template references nothing outside
 *     {employeeName, year, month, downloadUrl}.
 *   * The `setImmediate` queue survives the response being sent — a
 *   publish that re-subscribes a recipient to their already-queued email
 *   on retry is the documented behaviour (idempotent at the row-level
 *   via the WHERE publishedAt IS NULL guard).
 */

'use strict';

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { sendEmail, escapeHtml, isConfigured: emailIsConfigured } = require('./email');
const { hashIdentifier } = require('./pii');

const PAYSLIP_BLOB_PREFIX = 'payslips';
// PDF magic header — `%PDF-`. The first 5 bytes of any conforming PDF.
const PDF_MAGIC = Buffer.from('%PDF-', 'ascii');
// Accept up to 4 KiB before the magic — some PDFs prefix the magic with
// whitespace / a BOM (rare but legal). 4 KiB is the same upper range the
// itinerary / recipe scanners use and is plenty for whitespace + leading
// comments.
const PDF_MAGIC_SCAN_BYTES = 4096;

const EMAIL_TYPE = 'PAYSLIP_PUBLISHED';

const EMAIL_STATUS = Object.freeze({
  PENDING: 'PENDING',
  SENT: 'SENT',
  FAILED: 'FAILED',
  SKIPPED_OPT_OUT: 'SKIPPED_OPT_OUT',
  SKIPPED_NO_ADDRESS: 'SKIPPED_NO_ADDRESS',
  SKIPPED_TYPE_MUTED: 'SKIPPED_TYPE_MUTED',
});

// Audit reason sanitiser — REFUSE substrings that look like salary
// figures so an HR typo / disgruntled actor who fills the reason field
// with a net-pay figure cannot exfiltrate it via the email log /
// revokedReason column.
//
// Behaviour: extract the rejected keyword and throw PIM_AUDIT_REASON_REJECTED
// with `{ rejectedWord }` attached. The route maps this to a 400 with a
// message that names the offending word, so the admin can rewrite the
// reason without guessing. We do NOT silently redact — silent redaction
// hides the contract violation and prevents the admin from learning
// that the reason was wrong. (See plan §C.4 PII scan.)
const SALARY_PII_PATTERN = /\b(pan|uan|account|salary|net\s*pay|gross\s*pay|basic|hra|earnings|deductions?|tax|ctc)\b/i;
const MAX_AUDIT_REASON_LEN = 500;

function sanitizeAuditReason(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim().slice(0, MAX_AUDIT_REASON_LEN);
  if (!trimmed) return null;
  const match = SALARY_PII_PATTERN.exec(trimmed);
  if (match) {
    const err = Object.assign(
      new Error(`Audit reason rejected — contains keyword "${match[0].toLowerCase()}"`),
      { code: 'PIM_AUDIT_REASON_REJECTED', rejectedWord: match[0].toLowerCase() },
    );
    throw err;
  }
  return trimmed;
}

/**
 * Verify that a blob in R2 is a real PDF. Three-state outcome:
 *   { ok: true, contentType, sizeBytes, etag }  — magic bytes match
 *   { ok: false, reason, observedMagic }        — magic bytes do NOT match
 *   { ok: null, reason }                        — could not HEAD the blob
 *
 * The three states match the contract `verifyBlobExists` already uses
 * (DR-007) so a caller can branch without learning a new vocabulary.
 *
 * @param {S3Client|object} client   - @aws-sdk/client-s3 client (or a
 *   mock that exposes `client.send(GetObjectCommand)`).
 * @param {string} container         - R2 bucket name
 * @param {string} blobPath          - blob name (incl. prefix)
 * @param {object} [opts]            - { signal } AbortSignal for the read
 */
async function verifyBlobMagicBytes(client, container, blobPath, opts = {}) {
  if (!client || !container || !blobPath) {
    return { ok: null, reason: 'MISSING_ARGS' };
  }
  try {
    // Fetch only the first PDF_MAGIC_SCAN_BYTES — much cheaper than the
    // full 25 MB max. Range is RFC-7233 standard byte-range.
    const range = `bytes=0-${PDF_MAGIC_SCAN_BYTES - 1}`;
    const resp = await client.send(new GetObjectCommand({
      Bucket: container,
      Key: blobPath,
      Range: range,
    }), {
      abortSignal: opts.signal,
    });
    const head = await streamToBuffer(resp.Body);
    const observedMagic = head.slice(0, 5).toString('ascii');
    if (!head.subarray(0, 5).equals(PDF_MAGIC)) {
      return {
        ok: false,
        reason: 'NOT_PDF',
        observedMagic,
      };
    }
    return {
      ok: true,
      contentType: resp.ContentType || 'application/pdf',
      sizeBytes: Number(resp.ContentLength ?? 0),
      etag: (resp.ETag || '').replace(/^"|"$/g, ''),
    };
  } catch (err) {
    const status = err.$metadata?.httpStatusCode;
    if (status === 404) {
      return { ok: null, reason: 'BLOB_NOT_FOUND' };
    }
    if (err.name === 'AbortError') {
      return { ok: null, reason: 'TIMEOUT' };
    }
    return {
      ok: null,
      reason: err.name || err.Code || `NETWORK_ERROR_${status || 'UNKNOWN'}`,
    };
  }
}

// Tiny stream-to-buffer helper. The AWS SDK v3 returns a Node Readable
// (`Body`) for GetObjectCommand. Buffering the first 4 KiB is cheap; we
// don't need the full payload (the magic-bytes check is a prefix read).
function streamToBuffer(stream) {
  if (!stream) return Promise.resolve(Buffer.alloc(0));
  // AWS SDK v3 may expose `transformToByteArray()` natively (added in
  // client-s3 3.363.0). Fall back to a manual stream collection when it's
  // not present so the test mock + an older SDK both work.
  if (typeof stream.transformToByteArray === 'function') {
    return stream.transformToByteArray().then((u8) => Buffer.from(u8));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(Buffer.from(c)));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

/**
 * BigInt-safe payslip row serializer. Walks the row, calls `.toString()`
 * on every BigInt (sizeBytes), and shapes the response exactly the way
 * the front-end's `MyPayslip` / `CoverageView` components consume it.
 *
 * Stable key order — keys appear in the order the front-end consumes
 * them, so a JSON.stringify diff is a useful sanity check during dev.
 *
 * NO salary figures. NO PII beyond what's already in the row.
 */
function serializePayslipForWire(row) {
  if (!row) return null;
  return {
    id: row.id,
    employeeId: row.employeeId,
    year: row.year,
    month: row.month,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes == null ? null : row.sizeBytes.toString(),
    blobPath: row.blobPath,
    uploadedAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    publishedAt: row.publishedAt instanceof Date ? row.publishedAt.toISOString() : row.publishedAt,
    revokedAt: row.revokedAt instanceof Date ? row.revokedAt.toISOString() : row.revokedAt,
    deletedAt: row.deletedAt instanceof Date ? row.deletedAt.toISOString() : row.deletedAt,
    emailStatus: row.emailStatus,
    emailSentAt: row.emailSentAt instanceof Date ? row.emailSentAt.toISOString() : row.emailSentAt,
    // Denormalized recipient preview (the employee relation is included
    // via the route's Prisma include). NEVER surfaces salary figures —
    // just the name + email so the admin's coverage view can show
    // "X payslips sent to <name>".
    recipientName: row.employee?.name || null,
    recipientEmail: row.employee?.email || null,
  };
}

/**
 * Bind an UploadIntent row to a new Payslip row.
 *
 * Atomic flow (single Prisma transaction):
 *   1. Look up the intent by (employeeId, ulid). MUST exist and be
 *      CONFIRMED. The intent's blobPath is server-owned.
 *   2. Verify the blobPath's prefix is exactly `payslips/`. An
 *      unprefixed blob (which mountUploadRoutes allows for legacy /
 *      Drawing callers) would let an admin bind a non-payslip blob
 *      to a Payslip row — the prefix is the second boundary AFTER
 *      the admin-only mount. Pinning the prefix here keeps the
 *      binding blast radius tight even if a future /sas-url change
 *      loosens the prefix allowlist.
 *   3. Verify the blob's first 5 bytes are `%PDF-`. If not, the blob
 *      was uploaded as a non-PDF and must not become a Payslip row.
 *   4. Insert the Payslip row with the canonical
 *      `payslips/{year}/{month}/{employeeId}/{ulid}.pdf` shape. The
 *      (employee_id, year, month) partial unique guards against
 *      duplicate coverage for the same calendar month.
 *   5. Mark the UploadIntent boundType='payslip' + boundAt=now(). The
 *      durable sweep's CONFIRMED-orphan pass (where boundAt IS NULL)
 *      leaves this row alone.
 *
 * Throws on any failure — caller maps to 400 INVALID_BLOB_PREFIX |
 * 404 UPLOAD_NOT_CONFIRMED | 409 DUPLICATE | 500 VERIFY_FAILED.
 *
 * @param {object} prisma       - the Prisma client
 * @param {object} args
 * @param {string} args.ulid              - the intent's ulid
 * @param {string} args.employeeId        - the payslip recipient
 * @param {string} args.uploadedById      - the admin acting on the bind
 * @param {number} args.year              - 2000..2100 (validated upstream)
 * @param {number} args.month             - 1..12 (validated upstream)
 * @param {object} [args.s3Client]        - injected for tests; falls back
 *                                          to blobStorage.getClient()
 * @param {Function} [args.verifyMagicBytes] - test seam for replacing
 *   the magic-bytes check (default: the module's own
 *   verifyBlobMagicBytes). The bound function takes
 *   `(client, container, blobPath)` and returns the three-state outcome.
 * @returns {Promise<{ payslip: object, intent: object }>}
 */
async function bindPayslipToIntent(prisma, {
  ulid,
  employeeId,
  uploadedById,
  year,
  month,
  s3Client,
  verifyMagicBytes,
}) {
  if (!prisma?.payslip || !prisma?.uploadIntent) {
    throw Object.assign(new Error('Prisma client missing payslip/uploadIntent delegate'), { code: 'PIM_MISSING' });
  }
  if (!ulid || !employeeId || !uploadedById) {
    throw Object.assign(new Error('Missing required fields'), { code: 'PIM_MISSING_FIELDS' });
  }
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw Object.assign(new Error('year out of range'), { code: 'PIM_INVALID_YEAR' });
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw Object.assign(new Error('month out of range'), { code: 'PIM_INVALID_MONTH' });
  }

  // The intent was keyed by the UPLOADER's employeeId (the admin
  // running the request — see mountUploadRoutes, which writes
  // `employeeId: req.employeeId` on intent creation). Look it up by
  // `uploadedById` (== req.employeeId of the bind call), NOT by the
  // recipient's `employeeId`. The blobPath check below still verifies
  // that the recipient's employeeId matches the path segment, so a
  // tampered uploader cannot bind a payslip for an employee they did
  // not intend to upload to.
  const intent = await prisma.uploadIntent.findUnique({
    where: { employeeId_ulid: { employeeId: uploadedById, ulid } },
  });
  if (!intent) {
    throw Object.assign(new Error('Upload intent not found'), { code: 'PIM_NO_INTENT' });
  }
  if (intent.status !== 'CONFIRMED') {
    throw Object.assign(new Error(`Intent status is ${intent.status}, expected CONFIRMED`), {
      code: 'PIM_INTENT_NOT_CONFIRMED',
    });
  }
  // The intent's blobPath is `payslips/<employeeId>/<ulid>.pdf` — the
  // path segment MUST equal the recipient (body.employeeId) passed to
  // bind. A mismatch means the uploader is trying to bind an intent
  // whose blob was uploaded for a different recipient. Refuse.
  if (intent.blobPath !== `${PAYSLIP_BLOB_PREFIX}/${employeeId}/${ulid}.pdf`) {
    // The intent's blobPath is server-owned by the payslip mount. A
    // mismatch means either (a) a future mount started writing to a
    // different path, or (b) a client tampered with the row. Either
    // way, refuse.
    throw Object.assign(new Error(`blobPath ${intent.blobPath} does not match payslip canonical shape`), {
      code: 'PIM_INVALID_BLOB_PATH',
    });
  }

  // Lazy-load blobStorage.getClient only at the verify step (so a unit
  // test that doesn't touch R2 can pass `s3Client: { send: ... }`).
  const client = s3Client || require('./blobStorage').getClient();
  // The verify seam: tests inject a replacement for the magic-bytes
  // check (the destructure above captured the original reference at
  // module load, so jest.spyOn on module.exports does NOT update the
  // local binding). Production callers leave this undefined and the
  // default destructured function is used.
  const verifyFn = typeof verifyMagicBytes === 'function' ? verifyMagicBytes : verifyBlobMagicBytes;
  const magicCheck = await verifyFn(client, intent.container, intent.blobPath);
  if (magicCheck.ok !== true) {
    throw Object.assign(new Error(`PDF magic check failed: ${magicCheck.reason}`), {
      code: magicCheck.ok === null ? 'PIM_VERIFY_UNAVAILABLE' : 'PIM_NOT_PDF',
      magicReason: magicCheck.reason,
    });
  }

  // Transactional — bind + intent claim commit together, so a partial
  // bind (Payslip row without the intent claimed) cannot happen.
  //
  // Contract change (fixup): emailStatus is NOT stamped here. The schema
  // default was dropped so a freshly-created row is NULL = a draft.
  // The column is set to EMAIL_STATUS.PENDING inside publishPayslip
  // (CAS over publishedAt IS NULL AND deletedAt IS NULL) and inside
  // resendPayslipEmail / the route-level resend-email handler. The
  // stuck-PENDING sweep helper (resendStuckPendingPayslips) therefore
  // cannot match drafts and cannot accidentally email an unpublished
  // row — its Prisma filter is `emailStatus = 'PENDING' AND
  // publishedAt IS NOT NULL AND deletedAt IS NULL AND purgedAt IS NULL`.
  const { payslip, intent: claimed } = await prisma.$transaction(async (tx) => {
    const created = await tx.payslip.create({
      data: {
        employeeId,
        year,
        month,
        ulid,
        uploadIntentUlid: ulid,
        contentType: magicCheck.contentType,
        etag: magicCheck.etag,
        sizeBytes: BigInt(magicCheck.sizeBytes || 0),
        blobPath: intent.blobPath,
        uploadedById,
        // emailStatus intentionally omitted — see comment above.
      },
    });
    const stamped = await tx.uploadIntent.update({
      where: { id: intent.id },
      data: { boundType: 'payslip', boundAt: new Date() },
    });
    return { payslip: created, intent: stamped };
  });

  return { payslip, intent: claimed };
}

/**
 * Per-row late publish. Each payslipId is processed in its OWN
 * transaction so a single failure (e.g. publishedAt already set, row
 * soft-deleted) does not roll back the others.
 *
 * Steps per row:
 *   1. Re-read the row. WHERE publishedAt IS NULL AND deletedAt IS NULL
 *      — the CAS guard so a stale admin tab doesn't re-publish.
 *   2. UPDATE publishedAt/publishedById/emailStatus='PENDING'.
 *   3. After the tx commits, queue an email send via setImmediate. The
 *      publish response returns immediately; the email arrives seconds
 *      later. A failed send stamps emailStatus='FAILED' on a separate
 *      transaction so the row's audit trail stays consistent.
 *
 * Returns { published: [{id, publishedAt}], failed: [{id, reason}] }.
 *
 * @param {object} prisma
 * @param {object} args
 * @param {string[]} args.payslipIds    - up to N ids
 * @param {string}   args.publishedById - the admin acting on the publish
 * @param {object} [args.s3Client]      - injected for tests; falls back
 *   to blobStorage.getClient() (the live S3 client).
 * @param {object} [args.electronicallyDeliver] - test seam for
 *   replacing the setImmediate fire-and-forget sendPayslipEmail.
 * @param {number} [args.delayMs]       - per-row delay (ms) between
 *   sequential email sends. Default reads BULK_PUBLISH_EMAIL_DELAY_MS
 *   (env), falling back to 600ms. Tests override to 0.
 */
async function publishPayslip(prisma, {
  payslipIds,
  publishedById,
  s3Client,
  electronicallyDeliver,
  delayMs,
}) {
  if (!Array.isArray(payslipIds) || payslipIds.length === 0) {
    return { published: [], failed: [] };
  }
  if (!publishedById) {
    throw Object.assign(new Error('publishedById required'), { code: 'PIM_MISSING_FIELDS' });
  }
  const publishResults = [];
  // BULK_PUBLISH_EMAIL_DELAY_MS — default 600ms per row. A bulk publish
  // of 100 payslips then takes ~60s to drain, which is bounded but
  // not bursty. Resend's published limit is 2 req/s on the free tier;
  // 600ms keeps a single-process publish well below that.
  const effectiveDelay = Number.isFinite(delayMs)
    ? delayMs
    : (Number(process.env.BULK_PUBLISH_EMAIL_DELAY_MS) || 600);
  for (const payslipId of payslipIds) {
    if (typeof payslipId !== 'string' || !payslipId) {
      publishResults.push({ id: payslipId, reason: 'INVALID_ID' });
      continue;
    }
    try {
      // Re-read the row so we can compare ETag + ContentLength against
      // the values stamped at bind-time. A blob swap under the same
      // ulid (a misdelivery, a manual R2 re-upload, a future
      // cross-tenant attack) is caught here — the row never publishes
      // with mismatched ETag/size.
      const row = await prisma.payslip.findUnique({
        where: { id: payslipId },
        select: {
          id: true,
          employeeId: true,
          ulid: true,
          blobPath: true,
          etag: true,
          sizeBytes: true,
          publishedAt: true,
          deletedAt: true,
          purgedAt: true,
        },
      });
      if (!row) {
        publishResults.push({ id: payslipId, reason: 'NOT_FOUND' });
        continue;
      }
      if (row.publishedAt) {
        publishResults.push({ id: payslipId, reason: 'ALREADY_PUBLISHED' });
        continue;
      }
      if (row.deletedAt) {
        publishResults.push({ id: payslipId, reason: 'REVOKED' });
        continue;
      }
      if (row.purgedAt) {
        publishResults.push({ id: payslipId, reason: 'PURGED' });
        continue;
      }
      // The test seam lives on module.exports so the test can swap
      // fields between cases. Read it fresh on every publish — a
      // single module-load snapshot would never pick up jest's
      // `payslipTestOverrides.verifyHeadMatches = jest.fn()` assignment.
      const overrides = module.exports.payslipTestOverrides || {};
      const headClient = s3Client || require('./blobStorage').getClient();
      // Head the blob and compare ETag + ContentLength against the
      // row's recorded values. A mismatch = the bytes changed under
      // the same ulid; refuse the publish.
      const verifyHead = typeof overrides.verifyHeadMatches === 'function'
        ? overrides.verifyHeadMatches
        : verifyBlobMatchesRecorded;
      const headCheck = await verifyHead(
        headClient,
        PAYSLIP_BLOB_BUCKET,
        row.blobPath,
        row.etag,
        row.sizeBytes,
      );
      if (headCheck !== 'ok') {
        publishResults.push({ id: payslipId, reason: headCheck });
        continue;
      }
      const stamp = await prisma.payslip.updateMany({
        where: {
          id: payslipId,
          publishedAt: null,
          deletedAt: null,
        },
        data: {
          publishedAt: new Date(),
          publishedById,
          emailStatus: EMAIL_STATUS.PENDING,
        },
      });
      if (stamp.count !== 1) {
        publishResults.push({ id: payslipId, reason: 'NOT_PUBLISHABLE' });
        continue;
      }
      publishResults.push({ id: payslipId, ok: true });
    } catch (err) {
      publishResults.push({ id: payslipId, ok: false, reason: err.code || 'PUBLISH_FAILED' });
    }
  }
  const published = publishResults.filter((r) => r.ok);
  const failed = publishResults.filter((r) => !r.ok);

  // Fire-and-forget email send for the published rows. DELIVER
  // SEQUENTIALLY with `effectiveDelay` ms between rows (a row's send
  // resolves before the next setImmediate fires). This is the
  // BULK_PUBLISH_EMAIL_DELAY_MS contract — sequential, not parallel.
  // Rationale:
  //   * Resend's free tier is 2 req/s; parallel setImmediate would
  //     hit 429s the moment an admin publishes 5+ payslips.
  //   * Sequential keeps the audit deterministic — the email log
  //     reflects send-order, not the order Resend happens to ack.
  //   * `setImmediate` still defers the whole chain past the response,
  //     so the HTTP /publish ack returns immediately.
  if (published.length > 0) {
    const deliver = typeof electronicallyDeliver === 'function'
      ? electronicallyDeliver
      : (p) => sendPayslipEmail(prisma, p);
    const queue = published.map((r) => r.id);
    const drain = async () => {
      for (const id of queue) {
        try {
          await deliver(id);
        } catch (_e) {
          // sendPayslipEmail already stamps the row's emailStatus
          // on every branch (SENT/FAILED/SKIPPED_*). Swallow here
          // so one row's failure doesn't break the chain.
        }
        if (effectiveDelay > 0) {
          await new Promise((resolve) => setTimeout(resolve, effectiveDelay));
        }
      }
    };
    setImmediate(() => { drain().catch(() => { /* chain swallowed */ }); });
  }

  return {
    published: published.map((r) => ({ id: r.id })),
    failed: failed.map((r) => ({ id: r.id, reason: r.reason })),
  };
}

// PAYSLIP_BLOB_BUCKET — the R2 container payslip uploads live in. The
// mount in `routes/upload.js` is admin-gated to the `payslips/` prefix,
// so this constant is the second half of the binding boundary: the
// publish-time head check verifies the blob at (this bucket, blobPath)
// still matches the values stamped at bind-time.
const PAYSLIP_BLOB_BUCKET = 'dpr-documents';

// PAYSLIP_MAX_BYTES — single source of truth for the payslip size cap.
// Enforced TWICE on purpose:
//
//   * upload mount  (routes/payslip.js adminUploadRouter)
//     — the upload's `mountUploadRoutes({ maxSizeBytesPerContainer })`
//       is the front-line defence; a forged Content-Length over the
//       cap is rejected before bytes hit R2.
//
//   * download route (routes/payslip.js portalRouter download)
//     — the route buffers chunks from R2 and refuses anything past
//       the cap with 413 PAYSLIP_TOO_LARGE. Defence in depth against
//       a row whose sizeBytes was tampered with between bind and
//       download (out of v1 scope, but the cap is cheap).
//
// Why 2 MB (down from 5 MB in commit 3):
//   * A payslip PDF is 1-2 pages of text + numbers. Even with a generous
//     font embed it stays well under 1 MB.
//   * 2 MB matches the user's pre-AppSec-review requirement: a single
//     cap for both upload and download so a row can never reach a size
//     the download route refuses.
//   * Lowering the cap tightens the OOM blast radius if a misdelivery
//     or future drift slips through. The 5 MB ceiling was a guess;
//     2 MB is an evidence-based ceiling.
//
// Kept as a hard-coded constant (not env-driven) so the test suite
// has one literal to pin. If a future deploy needs to lower the cap
// further, change this constant.
const PAYSLIP_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Head the blob at (bucket, key) and compare ETag + ContentLength
 * against the values the row recorded at bind-time. Returns:
 *   'ok'             — ETag and ContentLength match
 *   'ETAG_DRIFT'     — ETag changed since bind
 *   'SIZE_DRIFT'     — ContentLength changed since bind
 *   'BLOB_NOT_FOUND' — the R2 object is missing
 *   'BLOB_HEAD_FAILED' — R2 returned an error (network, 500, etc.)
 *
 * Strip surrounding double-quotes from the ETag before comparing —
 * R2 returns ETag wrapped in quotes ('"abc123"') and the row records
 * the same shape from verifyBlobMagicBytes. A mismatch in the wrapping
 * would be a false-positive drift.
 */
async function verifyBlobMatchesRecorded(client, bucket, key, recordedEtag, recordedSizeBytes) {
  if (!client) return 'BLOB_HEAD_FAILED';
  try {
    const { HeadObjectCommand } = require('@aws-sdk/client-s3');
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    const observedEtag = String(head.ETag || '').replace(/^"|"$/g, '');
    const observedSize = Number(head.ContentLength ?? 0);
    const expectedEtag = String(recordedEtag || '').replace(/^"|"$/g, '');
    if (observedEtag !== expectedEtag) return 'ETAG_DRIFT';
    // sizeBytes from Prisma is BigInt; coerce via toString → Number.
    const expectedSize = Number(recordedSizeBytes?.toString?.() ?? recordedSizeBytes);
    if (observedSize !== expectedSize) return 'SIZE_DRIFT';
    return 'ok';
  } catch (err) {
    const status = err?.$metadata?.httpStatusCode;
    if (status === 404) return 'BLOB_NOT_FOUND';
    return 'BLOB_HEAD_FAILED';
  }
}

// PAYSLIP_PENDING_STUCK_AGE_MS — a row whose emailStatus is still
// PENDING and whose updatedAt is older than this is considered
// "stuck" (the setImmediate chain died, the process crashed mid-drain,
// Resend returned a transient 5xx and we never retried). The resend
// helper accepts these rows on the assumption that another send
// attempt is safer than a permanent FAILED stamp.
const PAYSLIP_PENDING_STUCK_AGE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Resend a payslip email. Picks up where the publish-time queue left
 * off for rows that have not yet transitioned out of PENDING.
 *
 * Two paths converge here:
 *   1. Admin clicks "Resend" in the UI for a known PENDING/FAILED row.
 *   2. The cron sweep that periodically picks up rows stuck in
 *      PENDING for longer than PAYSLIP_PENDING_STUCK_AGE_MS (likely
 *      process-crashed mid-drain) and re-queues them.
 *
 * Both paths share the same stamp-on-finish behavior:
 *   * SENT  → emailStatus='SENT',     emailSentAt=now(), errorMessage cleared
 *   * FAILED → emailStatus='FAILED', emailFailedReason=resend-error
 *
 * No salary figures in audit strings.
 *
 * @param {object} prisma
 * @param {string} payslipId
 * @param {object} [opts] - { sendEmailOverride, portalBaseUrl, force }
 *   force=true bypasses the SENT-idempotency guard (admin explicitly
 *   asked for another send even though we already delivered).
 */
async function resendPayslipEmail(prisma, payslipId, opts = {}) {
  if (!payslipId) {
    throw Object.assign(new Error('payslipId required'), { code: 'PIM_MISSING_FIELDS' });
  }
  const payslip = await prisma.payslip.findUnique({
    where: { id: payslipId },
    include: { employee: { select: { id: true, name: true, email: true } } },
  });
  if (!payslip) {
    return { ok: false, error: 'NOT_FOUND' };
  }
  if (!payslip.publishedAt) {
    return { ok: false, error: 'NOT_PUBLISHED' };
  }
  if (payslip.deletedAt) {
    return { ok: false, error: 'REVOKED' };
  }
  if (payslip.purgedAt) {
    return { ok: false, error: 'PURGED' };
  }
  // Idempotency: if the last attempt was SENT and the admin didn't
  // force, refuse. The "stuck PENDING" sweep path passes no force
  // flag, but stuck rows are not SENT so this guard does not fire.
  if (!opts.force && payslip.emailStatus === EMAIL_STATUS.SENT) {
    return { ok: false, error: 'ALREADY_SENT' };
  }

  // The recipient has changed emailEnabled or muted since the publish
  // attempt — the original send skipped or failed for a config reason.
  // Reset emailStatus to PENDING so a successful resend can flip it
  // to SENT cleanly. We do NOT touch publishedAt; this is just an
  // additional delivery attempt.
  await prisma.payslip.update({
    where: { id: payslipId },
    data: { emailStatus: EMAIL_STATUS.PENDING, emailFailedReason: null },
  });

  // Defer the actual send to sendPayslipEmail. It re-runs the
  // preference checks (emailEnabled / typeMutes / address) so the
  // resend respects any recipient change since the first attempt.
  const deliver = (id) => sendPayslipEmail(prisma, id, {
    portalBaseUrl: opts.portalBaseUrl,
    sendEmailOverride: opts.sendEmailOverride,
  });
  return deliver(payslipId);
}

/**
 * Scan the payslip table for rows stuck in PENDING for more than
 * PAYSLIP_PENDING_STUCK_AGE_MS and resend them. Returns the count of
 * rows touched. Used ONLY by:
 *   * The POST /api/admin/payslips/resend-stuck endpoint
 *     (admin-driven manual recovery).
 *
 * The user explicitly required this to be admin-triggered, NOT a
 * scheduled job — the helper is wired only to that route. No cron,
 * no GH Actions workflow, no Render cron invokes it.
 *
 * The scan is bounded — LIMIT 100 per run so a 10 000-row backlog
 * drains over 100 admin-triggered calls.
 */
async function resendStuckPendingPayslips(prisma, opts = {}) {
  const cutoff = new Date(Date.now() - PAYSLIP_PENDING_STUCK_AGE_MS);
  const stuck = await prisma.payslip.findMany({
    where: {
      emailStatus: EMAIL_STATUS.PENDING,
      publishedAt: { not: null },
      deletedAt: null,
      purgedAt: null,
      updatedAt: { lt: cutoff },
    },
    select: { id: true },
    take: 100,
    orderBy: { updatedAt: 'asc' },
  });
  let successCount = 0;
  let failCount = 0;
  for (const row of stuck) {
    try {
      const result = await resendPayslipEmail(prisma, row.id, {
        sendEmailOverride: opts.sendEmailOverride,
        portalBaseUrl: opts.portalBaseUrl,
      });
      if (result && result.ok) successCount++;
      else failCount++;
    } catch (_err) {
      failCount++;
    }
    if (Number.isFinite(opts.delayMs) && opts.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
    } else {
      // Honour the same default delay as publish — never burst.
      const d = Number(process.env.BULK_PUBLISH_EMAIL_DELAY_MS) || 600;
      await new Promise((resolve) => setTimeout(resolve, d));
    }
  }
  return { scanned: stuck.length, sent: successCount, failed: failCount };
}

/**
 * Soft-delete a payslip. Sets deletedAt + revokedAt + revokedById +
 * revokedReason inside ONE transaction. The R2 blob stays — only the
 * purge script (commit 8) removes it.
 *
 * @param {object} prisma
 * @param {object} args
 * @param {string}   args.payslipId   - the row to revoke
 * @param {string}   args.revokedById - the admin acting
 * @param {string}   args.reason      - audited reason (PII-sanitised)
 */
async function revokePayslip(prisma, { payslipId, revokedById, reason }) {
  if (!payslipId || !revokedById) {
    throw Object.assign(new Error('payslipId + revokedById required'), { code: 'PIM_MISSING_FIELDS' });
  }
  const sanitisedReason = sanitizeAuditReason(reason);
  return prisma.payslip.update({
    where: { id: payslipId },
    data: {
      deletedAt: new Date(),
      revokedAt: new Date(),
      revokedById,
      revokedReason: sanitisedReason,
    },
  });
}

/**
 * Tombstone a payslip row + delete its R2 blob (misdelivery cleanup).
 *
 * The misdelivery purge script (`scripts/purge-misdelivered-payslip.js`)
 * is the only intended caller — v1 has no HTTP route for this; the audit
 * requires a deliberate operator action with a sanitised reason.
 *
 * What it does, in order:
 *   1. Refuses any row that does not have `deletedAt IS NOT NULL` —
 *      misdelivery MUST go through `revokePayslip` first so the email
 *      status, revokedById, revokedReason audit trail is captured
 *      before the bytes are retired. This is the "revoke first" rule
 *      from the PAYSLIP_MISDELIVERY runbook.
 *   2. Refuses if `purgedAt IS NOT NULL` — double-purge is a no-op
 *      that could mask a second misdelivery investigation.
 *   3. Refuses if the row is not in PAYSLIP_BLOB_BUCKET (the blob-
 *      prefix allowlist — see `payslipUploadLimiter`'s blob-prefix
 *      guard at `routes/payslip.js:mountUploadRoutes`). A misdelivered
 *      payslip uploaded to a non-payslip bucket is out of scope for
 *      this script.
 *   4. Stamps `purgedById`, `purgedAt`, `purgedReason` inside one
 *      Prisma update. `purgedReason` is run through the same
 *      `sanitizeAuditReason` as `revokedReason` so a PII-laden reason
 *      (the admin pasting the offending salary into the reason) is
 *      refused, not silently truncated.
 *   5. Calls `deleteBlob(container, blobPath)` from `lib/blobStorage`.
 *      A blob already gone (`NoSuchKey` / 404) is treated as success
 *      and logged — the row stays tombstoned either way, the audit
 *      wins over the byte counter.
 *
 * Idempotency:
 *   * Re-running after a successful purge: step 2 raises
 *     `PAYSLIP_ALREADY_PURGED`. The script catches this and reports it
 *     as "already purged, no-op".
 *   * Re-running after revoke but before purge: succeeds — the row is
 *     tombstoned in one transaction.
 *
 * The four-guard predicate on every portal read (`publishedAt IS NOT
 * NULL AND deletedAt IS NULL AND purgedAt IS NULL`) means the
 * employee never sees the row again — the page returns 404 on
 * download, the list endpoint omits it, the partial unique index
 * `payslip_active_per_month_uidx` admits a fresh replacement row for
 * the same (employee, year, month).
 *
 * @param {object} prisma
 * @param {object} args
 * @param {string} args.payslipId   - the row to tombstone
 * @param {string} args.purgedById  - the operator (admin id) acting
 * @param {string} args.reason      - audited reason (PII-sanitised)
 * @returns {Promise<{ ok: true, alreadyPurged?: boolean, blobDeleted: boolean }>}
 */
async function purgePayslipBlob(prisma, { payslipId, purgedById, reason }) {
  if (!payslipId || !purgedById) {
    throw Object.assign(new Error('payslipId + purgedById required'), { code: 'PIM_MISSING_FIELDS' });
  }
  const sanitisedReason = sanitizeAuditReason(reason);
  const row = await prisma.payslip.findUnique({
    where: { id: payslipId },
    select: {
      id: true,
      blobPath: true,
      blobContainer: true,
      deletedAt: true,
      purgedAt: true,
    },
  });
  if (!row) {
    throw Object.assign(new Error('Payslip not found'), { code: 'PAYSLIP_NOT_FOUND' });
  }
  if (row.purgedAt) {
    return { ok: true, alreadyPurged: true, blobDeleted: false };
  }
  if (!row.deletedAt) {
    throw Object.assign(
      new Error('Payslip must be revoked before it is purged'),
      { code: 'PAYSLIP_NOT_REVOKED' },
    );
  }
  if (!row.blobPath || !row.blobContainer) {
    throw Object.assign(
      new Error('Payslip has no recorded blob to purge'),
      { code: 'PAYSLIP_NO_BLOB' },
    );
  }
  if (row.blobContainer !== PAYSLIP_BLOB_BUCKET) {
    // Defence-in-depth: the upload mount restricts to PAYSLIP_BLOB_BUCKET,
    // but if a future migration changes the bucket allowlist, this guard
    // keeps the purge script from deleting out-of-scope bytes.
    throw Object.assign(
      new Error(`Payslip blob container ${row.blobContainer} is not purgeable`),
      { code: 'PAYSLIP_BUCKET_OUT_OF_SCOPE' },
    );
  }

  // Stamping the tombstone in one statement makes the row transition
  // visible to other processes atomically (4-guard predicate flips,
  // partial unique frees up, etc.). The blob delete happens AFTER the
  // tombstone is durable — a blob-still-present row that returns 404
  // on download is acceptable; a tombstone-with-no-bytes row is what
  // we want for the audit log.
  await prisma.payslip.update({
    where: { id: payslipId },
    data: {
      purgedById,
      purgedAt: new Date(),
      purgedReason: sanitisedReason,
    },
  });

  // Best-effort blob delete. blobStorage.deleteBlob throws on a
  // non-2xx S3 response — if the bytes were already gone (a previous
  // partial run, a manual operator delete), we want the row to stay
  // tombstoned and the audit to be the source of truth.
  const { deleteBlob } = require('./blobStorage');
  let blobDeleted = false;
  try {
    await deleteBlob(row.blobContainer, row.blobPath);
    blobDeleted = true;
  } catch (err) {
    // Swallow 404s. Anything else is logged by the script — the row
    // tombstone is already durable, so a follow-up rerun is safe.
    if (err && (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404)) {
      blobDeleted = false;
    } else {
      throw Object.assign(
        new Error(`R2 delete failed: ${err?.message || 'unknown'}`),
        { code: 'PAYSLIP_BLOB_DELETE_FAILED' },
      );
    }
  }

  return { ok: true, blobDeleted };
}

/**
 * Send the "your payslip for {year}-{month} is ready" email.
 *
 * Composition rules (privacy discipline):
 *   * Subject: "Your ACS Chennai payslip for {Month Year}" — no salary.
 *   * Body: greeting + employee_name (recipient's first name if we can
 *     parse it from the full name), the canonical year-month label,
 *     a single CTA button to the portal's `https://<host>/portal/payslips`
 *     page, and a footer. NO salary figure. NO blob URL. NO SAS URL.
 *   * The portal page is reached by login; the download endpoint is the
 *     server-side streamer (commit-3 GET /api/payslips/:id/download).
 *
 * Preference filtering — INTENTIONALLY BYPASSED for payslip emails.
 *   * Why: payslip is a critical-type document (it carries salary data)
 *     and a muted / opted-out employee must still be told their payslip
 *     is ready. The portal's per-employee inbox is the only place the
 *     file lives, so the email is the receipt that payroll has been
 *     delivered. Skipping it on user prefs would silently drop payroll
 *     delivery for any employee who muted `PAYSLIP_PUBLISHED`.
 *   * This is a deliberate, documented exception to the round-25
 *     notifier contract. The in-app notification (fanOut / AppLog) is
 *     still respect-prefs; only the direct payslip email bypasses.
 *   * The ONLY short-circuits the function honours are deliverability
 *     gates, not user preference:
 *       - recipient has no email address → SKIPPED_NO_ADDRESS
 *       - outbound email is unconfigured (no RESEND_API_KEY) → FAILED
 *         with reason EMAIL_NOT_CONFIGURED
 *     Both of those are environment / contact-data failures, not
 *     preference. A muted / opted-out employee still gets the email.
 *
 * Audit:
 *   * On any send attempt (sent or failed), write an EmailLog row in the
 *     same shape as the round-25 notifier uses. Channel='PAYSLIP_DIRECT'.
 *   * Status is mirrored on `payslip.emailStatus` so the admin can read
 *     it without joining two tables.
 *
 * @param {object} prisma
 * @param {string} payslipId
 * @param {object} [opts] - { portalBaseUrl, sendEmailOverride }
 */
async function sendPayslipEmail(prisma, payslipId, opts = {}) {
  if (!prisma?.payslip) {
    return { ok: false, error: 'PIM_NO_PRISMA' };
  }
  const payslip = await prisma.payslip.findUnique({
    where: { id: payslipId },
    include: { employee: { select: { id: true, name: true, email: true, isAdmin: true } } },
  });
  if (!payslip) return { ok: false, error: 'NOT_FOUND' };
  if (!payslip.employee) return { ok: false, error: 'NO_RECIPIENT' };

  const recipientEmail = payslip.employee.email;

  // [PAYSLIP_BYPASS_NOTIFICATION_MUTES] INTENTIONALLY BYPASSED.
  // This function does NOT consult `notificationPreference` (no
  // `findUnique` on it) and does NOT honour `emailEnabled=false` or
  // `typeMutes.PAYSLIP_PUBLISHED=true`. See the docstring above — the
  // only short-circuits below are deliverability gates, not user
  // preference. Removing this comment block would re-introduce the
  // silent-payroll-drop bug from the round-25 notifier contract.
  // The in-app notification (fanOut / AppLog) is a separate code path
  // and still respects user prefs; this is a one-route exception for
  // the direct "payslip available" email.

  if (!recipientEmail || typeof recipientEmail !== 'string' || !recipientEmail.includes('@')) {
    await stampEmailStatus(prisma, payslipId, EMAIL_STATUS.SKIPPED_NO_ADDRESS);
    await writeAuditLog(prisma, { payslipId, recipientEmail: null, channel: 'PAYSLIP_DIRECT', status: 'SKIPPED_NO_ADDRESS', subject: composeSubject(payslip) });
    return { ok: false, status: EMAIL_STATUS.SKIPPED_NO_ADDRESS };
  }

  if (!emailIsConfigured()) {
    // Outbound email isn't configured (RESEND_API_KEY missing). Stamp
    // FAILED with a sanitised reason so the admin's coverage page shows
    // a clear "needs config" marker.
    await stampEmailStatus(prisma, payslipId, EMAIL_STATUS.FAILED, 'EMAIL_NOT_CONFIGURED');
    return { ok: false, status: EMAIL_STATUS.FAILED, reason: 'EMAIL_NOT_CONFIGURED' };
  }

  const subject = composeSubject(payslip);
  const html = composeBody({
    payslip,
    // The portal is a HashRouter SPA. The path-after-hash is
    // `/portal/payslips`; the URL the email's CTA button uses must
    // include the `#` so the browser treats it as a hash-route and the
    // SPA router takes over. Falling back to the SPA host (per
    // acs-render-host-map memory note), not the marketing origin.
    portalBaseUrl: opts.portalBaseUrl || process.env.PAYSLIP_LINK_BASE_URL || process.env.PORTAL_BASE_URL || 'https://acs-portal-spa.onrender.com',
  });
  const sender = typeof opts.sendEmailOverride === 'function'
    ? opts.sendEmailOverride
    : sendEmail;
  const result = await sender({ to: recipientEmail, subject, html });

  if (result && result.ok) {
    await stampEmailStatus(prisma, payslipId, EMAIL_STATUS.SENT);
    await writeAuditLog(prisma, {
      payslipId,
      recipientEmail,
      channel: 'PAYSLIP_DIRECT',
      status: 'SENT',
      subject,
      providerMessageId: result.messageId,
    });
    return { ok: true, status: EMAIL_STATUS.SENT };
  }
  const reason = (result && result.error) || 'UNKNOWN';
  await stampEmailStatus(prisma, payslipId, EMAIL_STATUS.FAILED, reason);
  await writeAuditLog(prisma, {
    payslipId,
    recipientEmail,
    channel: 'PAYSLIP_DIRECT',
    status: 'FAILED',
    subject,
    errorMessage: reason,
  });
  return { ok: false, status: EMAIL_STATUS.FAILED, reason };
}

function composeSubject(payslip) {
  const monthName = MONTH_NAMES[payslip.month - 1] || String(payslip.month);
  return `Your ACS Chennai payslip for ${monthName} ${payslip.year}`;
}

function composeBody({ payslip, portalBaseUrl }) {
  const monthName = MONTH_NAMES[payslip.month - 1] || String(payslip.month);
  // Generic salutation — do NOT include any employee name fragment.
  // The recipient's first/last name is PII per the email-redaction
  // contract (fixup G1): the body must contain no employee name, id,
  // filename, amount, or blob path. The greeting is intentionally
  // generic so the email cannot be tied to an individual even if
  // intercepted.
  // HashRouter URL — the `#` MUST precede `/portal/payslips` so the
  // browser treats it as a hash-route and the SPA router takes over.
  // A plain `/portal/payslips` would 404 against the SPA host (which
  // serves the index.html only for the bare path).
  const url = `${portalBaseUrl.replace(/\/+$/, '')}/#/portal/payslips`;
  return `<!doctype html>
<html lang="en">
  <body style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; color:#1f2937;">
    <p>Hello,</p>
    <p>Your payslip for <strong>${escapeHtml(monthName)} ${escapeHtml(String(payslip.year))}</strong> is now available on the ACS Chennai portal.</p>
    <p style="margin: 24px 0;">
      <a href="${escapeHtml(url)}"
         style="display:inline-block;padding:10px 18px;background:#2563eb;color:#ffffff;border-radius:6px;text-decoration:none;font-weight:600;">
        View your payslip
      </a>
    </p>
    <p>If the button does not work, paste this URL into your browser:<br />
      <a href="${escapeHtml(url)}">${escapeHtml(url)}</a>
    </p>
    <p style="color:#6b7280;font-size:13px;margin-top:24px;">
      This message is from the ACS Chennai HR system. If you did not expect this email,
      please contact <a href="mailto:info@acschennai.com">info@acschennai.com</a>.
    </p>
  </body>
</html>`;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

async function stampEmailStatus(prisma, payslipId, status, reason = null) {
  try {
    await prisma.payslip.update({
      where: { id: payslipId },
      data: {
        emailStatus: status,
        emailSentAt: status === EMAIL_STATUS.SENT ? new Date() : undefined,
        emailFailedReason: reason || null,
      },
    });
  } catch (err) {
    // Stamp failure must NOT poison the response. Log the hash so an
    // operator can find the row by recipient id, but never log the
    // recipient email itself.
    console.error('[payslip] email status stamp failed', {
      payslipHash: hashIdentifier(payslipId),
      status,
      errCode: err?.code,
    });
  }
}

async function writeAuditLog(prisma, { payslipId, recipientEmail, channel, status, subject, providerMessageId, errorMessage }) {
  if (!prisma?.emailLog) return;
  try {
    await prisma.emailLog.create({
      data: {
        employeeId: (await prisma.payslip.findUnique({
          where: { id: payslipId },
          select: { employeeId: true },
        }))?.employeeId || 'unknown',
        recipientEmail: recipientEmail || 'unknown',
        subject: subject || '(no subject)',
        channel,
        status,
        providerMessageId: providerMessageId || null,
        errorMessage: errorMessage || null,
      },
    });
  } catch (err) {
    console.error('[payslip] audit log write failed', {
      payslipHash: hashIdentifier(payslipId),
      errCode: err?.code,
    });
  }
}

module.exports = {
  EMAIL_TYPE,
  EMAIL_STATUS,
  PAYSLIP_BLOB_PREFIX,
  PAYSLIP_BLOB_BUCKET,
  PAYSLIP_MAX_BYTES,
  PAYSLIP_PENDING_STUCK_AGE_MS,
  MAX_AUDIT_REASON_LEN,
  verifyBlobMagicBytes,
  verifyBlobMatchesRecorded,
  sanitizeAuditReason,
  serializePayslipForWire,
  bindPayslipToIntent,
  publishPayslip,
  revokePayslip,
  purgePayslipBlob,
  sendPayslipEmail,
  resendPayslipEmail,
  resendStuckPendingPayslips,
  // Exported for tests
  composeSubject,
  composeBody,
  // Test-only stash. The route layer reads this fresh on every bind
  // and only when NODE_ENV === 'test'. Tests set/unset fields here
  // (a plain object — jest mocks not needed) to swap the magic-bytes
  // check without rebuilding the Express app.
  payslipTestOverrides: {
    verifyMagicBytes: null,
    verifyHeadMatches: null,
    electronicallyDeliver: null,
  },
};