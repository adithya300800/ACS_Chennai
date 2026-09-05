/**
 * [S3-7] Upload-intent consumption — the missing half of LPR-012.
 *
 * LPR-012 (round-26) built a durable `upload_intent` registry: /sas-url
 * writes a PENDING row before handing out the presigned URL, and
 * /confirm-upload flips it to CONFIRMED once the bytes are verified in R2.
 *
 * But nothing ever CONSUMED the registry at the point that matters. The
 * DPR and Inspection POST handlers attached photos straight from the
 * client array (`photos: { create: photos.map(...) }`) and neither read,
 * validated, nor consumed the intent. Repo-wide, `uploadIntent` appeared
 * only in `lib/uploadRoutes.js` and its tests. That left two silent holes:
 *
 *   1. A CONFIRMED intent whose DPR was never POSTed is bound to nothing.
 *      The LPR-012 cleanup deliberately skipped CONFIRMED rows (they were
 *      assumed to be referenced by a business record), so the blob became
 *      a permanent orphan paying permanent storage cost.
 *
 *   2. A client could POST a DPR carrying a `ulid` with no intent at all.
 *      Only the 26-char Crockford shape was checked, so the photo row
 *      could point at a blob that never existed — or at another
 *      employee's blob (IDOR), since nothing tied the ulid to the caller.
 *
 * This module is the consumption half, shared by both routes exactly as
 * DR-021 shares the /sas-url + /confirm-upload contract:
 *
 *   - `validatePhotoIntents()` runs during request validation, BEFORE the
 *     create. Every photo must map to a CONFIRMED intent owned by the
 *     authenticated employee, or the request is rejected 400
 *     UPLOAD_NOT_CONFIRMED. Because the lookup is scoped by `employeeId`,
 *     a foreign ulid is indistinguishable from a nonexistent one — the
 *     IDOR defence and the missing-intent defence are the same query.
 *
 *   - `bindPhotoIntents()` runs immediately AFTER the create succeeds and
 *     stamps `boundType` + `boundAt` on the consumed intents. That stamp
 *     is what tells the durable sweep "this blob has an owner, leave it
 *     alone"; without it, the sweep retires the blob after its grace
 *     window.
 *
 * ── Why `expiresAt` is not applied to CONFIRMED rows ─────────────────────
 *
 * `expiresAt` is the 20-minute PENDING TTL — the window in which the
 * client must actually upload bytes and call /confirm-upload. It is not a
 * deadline for submitting the report. Enforcing it here would 400 any user
 * who spends more than 20 minutes filling in a DPR form after attaching
 * photos, which is an ordinary thing to do on a construction site.
 *
 * `/confirm-upload` already encodes this: its CONFIRMED branch returns
 * early, before the `expiresAt` check, so a CONFIRMED intent is
 * deliberately immune to the PENDING TTL. We keep that contract.
 *
 * The real liveness bound on a CONFIRMED-but-unbound intent is the sweep's
 * grace window (default 1 hour, `UPLOAD_SWEEP_CONFIRMED_GRACE_MS`). When
 * that window lapses the sweep deletes the blob and flips the row to
 * EXPIRED — at which point `status === 'CONFIRMED'` is false and the
 * validation below rejects it. So "not expired" is enforced through the
 * status column, which is the only signal that reflects whether the bytes
 * still exist in R2.
 *
 * ── Graceful degradation ─────────────────────────────────────────────────
 *
 * Both helpers no-op when `prisma.uploadIntent` is absent, mirroring the
 * guard in `lib/uploadRoutes.js`. That covers deployments where the
 * LPR-012 migration has not been applied yet, and the many unit suites
 * that wire a hand-rolled Prisma mock exposing only `dPR` / `inspectionRecord`.
 * Turning those into 500s would be a self-inflicted outage; the sweep
 * still reclaims the storage either way.
 */

'use strict';

const { hashIdentifier } = require('./pii');

/**
 * Collect the unique ulids from a validated photos array.
 * Duplicates in one payload are legal (the client may attach the same
 * blob twice); they consume one intent, so counts are compared against
 * the deduped set.
 */
function uniqueUlids(photos) {
  const seen = new Set();
  for (const p of photos) {
    if (p && typeof p.ulid === 'string') seen.add(p.ulid);
  }
  return [...seen];
}

/**
 * Verify every photo in the payload maps to a CONFIRMED upload intent
 * owned by `employeeId`.
 *
 * Call this AFTER the per-photo shape validation (ulid regex, container,
 * content-type, size) and BEFORE the create — it is a request-validation
 * step, not a side-effect.
 *
 * @returns {Promise<null | { status: number, body: object }>}
 *   `null` when every photo is backed by a confirmed intent (or when the
 *   intent store is unavailable). Otherwise an Express response envelope
 *   the caller should send verbatim.
 */
async function validatePhotoIntents({ prisma, employeeId, photos, context }) {
  if (!Array.isArray(photos) || photos.length === 0) return null;
  if (!prisma || !prisma.uploadIntent || typeof prisma.uploadIntent.findMany !== 'function') {
    return null; // see "Graceful degradation" above
  }

  const ulids = uniqueUlids(photos);
  if (ulids.length === 0) return null;

  let confirmed;
  try {
    confirmed = await prisma.uploadIntent.findMany({
      // Scoped by employeeId: an intent belonging to another employee is
      // simply not found, so IDOR and "no intent at all" collapse into
      // one rejection path. Never widen this to a bare `ulid: { in }`.
      where: { employeeId, ulid: { in: ulids }, status: 'CONFIRMED' },
      select: { ulid: true },
    });
  } catch (err) {
    // A failed lookup must not silently admit unverified photos — that
    // would re-open the hole this module exists to close. 503 is the same
    // shape /confirm-upload uses for UPLOAD_INTENT_LOOKUP_FAILED.
    console.error('[upload/intent] binding lookup failed', {
      employeeHash: hashIdentifier(employeeId),
      context,
      ulidCount: ulids.length,
      errCode: err && err.code,
      errMessage: err && err.message ? err.message.split('\n')[0] : String(err),
    });
    return {
      status: 503,
      body: { error: 'UPLOAD_INTENT_LOOKUP_FAILED', message: 'Could not validate photo uploads' },
    };
  }

  const confirmedSet = new Set(confirmed.map((r) => r.ulid));
  const missingIndexes = [];
  for (let i = 0; i < photos.length; i++) {
    const p = photos[i];
    if (!p || !confirmedSet.has(p.ulid)) missingIndexes.push(i);
  }

  if (missingIndexes.length === 0) return null;

  // Log with the PII-hashed employee identifier — never a bare ulid, which
  // on its own is an unattributable token that helps nobody debug.
  console.warn('[upload/intent] rejected photos with no confirmed intent', {
    employeeHash: hashIdentifier(employeeId),
    context,
    photoCount: photos.length,
    missingCount: missingIndexes.length,
    missingIndexes: missingIndexes.slice(0, 10),
  });

  return {
    status: 400,
    body: {
      error: 'UPLOAD_NOT_CONFIRMED',
      message:
        `photos[${missingIndexes.slice(0, 5).join(', ')}] ` +
        'have no confirmed upload; re-upload the photo(s) and try again',
      photoIndexes: missingIndexes,
    },
  };
}

/**
 * Stamp `boundType` + `boundAt` on the intents consumed by a freshly
 * created record. Best-effort by design: the record already exists and
 * the client already deserves its 201, so a binding failure must never
 * turn into a 500. It is logged instead, because an unbound intent is
 * exactly the state the sweep will retire — visibility is the whole
 * point of the warning.
 *
 * The `status: 'CONFIRMED'` filter is an atomic guard, not a redundancy:
 * if the sweep flipped the row to EXPIRED between validation and here,
 * `count` comes back short and we log rather than resurrect a row whose
 * blob has already been deleted.
 *
 * NOTE (DR-006): the DPR and Inspection create paths no longer use this —
 * they use `bindPhotoIntentsTx` below, which throws instead of logging so
 * the enclosing transaction rolls back. This best-effort variant is kept
 * for callers that genuinely cannot roll back (a record that already
 * committed in an earlier request).
 *
 * @returns {Promise<{ bound: number, expected: number, ok: boolean }>}
 */
async function bindPhotoIntents({ prisma, employeeId, photos, boundType, recordId }) {
  if (!Array.isArray(photos) || photos.length === 0) return { bound: 0, expected: 0, ok: true };
  if (!prisma || !prisma.uploadIntent || typeof prisma.uploadIntent.updateMany !== 'function') {
    return { bound: 0, expected: 0, ok: true };
  }

  const ulids = uniqueUlids(photos);
  if (ulids.length === 0) return { bound: 0, expected: 0, ok: true };

  try {
    const result = await prisma.uploadIntent.updateMany({
      where: { employeeId, ulid: { in: ulids }, status: 'CONFIRMED' },
      data: { boundType, boundAt: new Date() },
    });
    const bound = (result && typeof result.count === 'number') ? result.count : 0;
    if (bound !== ulids.length) {
      console.warn('[upload/intent] partial bind after record create', {
        employeeHash: hashIdentifier(employeeId),
        boundType,
        recordId,
        expected: ulids.length,
        bound,
        // The blobs behind the unbound ulids will be retired by the
        // durable sweep once the grace window lapses. If this fires
        // routinely, the create path is racing the sweep and the grace
        // window (UPLOAD_SWEEP_CONFIRMED_GRACE_MS) is too short.
      });
    }
    return { bound, expected: ulids.length, ok: bound === ulids.length };
  } catch (err) {
    console.error('[upload/intent] bind failed after record create', {
      employeeHash: hashIdentifier(employeeId),
      boundType,
      recordId,
      expected: ulids.length,
      errCode: err && err.code,
      errMessage: err && err.message ? err.message.split('\n')[0] : String(err),
    });
    return { bound: 0, expected: ulids.length, ok: false };
  }
}

/**
 * ── [DR-006] The server race the best-effort bind above cannot close ──────
 *
 * SOL DR-006 (server half): the create path validated the intents, COMMITTED
 * the report + photo rows, and only then bound the intents. Two things can
 * go wrong inside that window:
 *
 *   - the durable sweep flips a CONFIRMED row to EXPIRED and deletes the
 *     blob, so the committed photo row points at bytes that no longer exist;
 *   - the bind write itself fails.
 *
 * In both cases the old code logged a warning and still returned 201. The
 * user is told "saved", the evidence is gone, and nobody who matters ever
 * sees the log line. The audit is explicit: *"a short binding count is an
 * error, not successful publication."*
 *
 * The fix is to make the claim and the create ONE transaction:
 *
 *   1. `validatePhotoIntents` still runs first, outside the tx — it is the
 *      cheap rejection path (400 UPLOAD_NOT_CONFIRMED) and we do not want to
 *      open a transaction just to reject a fabricated ulid.
 *   2. Inside `prisma.$transaction`:
 *      a. `assertPhotoIntentsBindable` re-reads the intents with the SAME
 *         `status: 'CONFIRMED'` predicate,
 *      b. the report + photo rows are created,
 *      c. `bindPhotoIntentsTx` stamps `boundType`/`boundAt` with the same
 *         predicate and compares `count` against the expected set.
 *   3. A short count throws `PhotoBindingLostError`, which rolls the whole
 *      transaction back — no report, no photo rows — and the route
 *      translates it to **409 PHOTO_BINDING_LOST** so the client can
 *      re-upload. Never a 500: nothing is broken, the evidence just moved.
 *
 * The `status: 'CONFIRMED'` filter on the updateMany is the atomic guard.
 * A sweep that retires a row mid-request makes the count short, which is
 * exactly the signal we want to surface.
 */

/** Tagged error so the route can translate the failure to 409, not 500. */
class PhotoBindingLostError extends Error {
  constructor({ expected, bound, boundType }) {
    super('Photo upload ownership was lost before the record could be saved');
    this.name = 'PhotoBindingLostError';
    // Duck-typed flag: `instanceof` is unreliable across jest module
    // registries and any future re-require of this module.
    this.isPhotoBindingLost = true;
    this.expected = expected;
    this.bound = bound;
    this.boundType = boundType;
  }
}

/**
 * Express envelope for a `PhotoBindingLostError`, or `null` for any other
 * error (the caller keeps its existing prisma-mapping / 500 path).
 *
 * Wire shape mirrors the rest of both routes: `{ error, code, message }`.
 */
function photoBindingLostResponse(err) {
  if (!err || !err.isPhotoBindingLost) return null;
  return {
    status: 409,
    body: {
      error: 'PHOTO_BINDING_LOST',
      code: 'PHOTO_BINDING_LOST',
      message:
        'One or more photo uploads expired before the record was saved. ' +
        'Nothing was saved — re-attach the photo(s) and submit again.',
    },
  };
}

/**
 * Run `fn` inside a real interactive transaction when the client supports
 * one, otherwise straight through on the base client.
 *
 * Two callers need the fallback:
 *   - deployments/tests whose Prisma stub has no `$transaction`;
 *   - stubs whose `$transaction` hands back a PARTIAL client that does not
 *     expose the model being written (several suites wire a tx store with
 *     only the handful of delegates their route path touches).
 *
 * A real PrismaClient always satisfies both checks, so production always
 * gets the transactional path. Degrading here keeps the pre-existing
 * behaviour for those stubs instead of turning them into 500s.
 *
 * @param {object} prisma      base client
 * @param {string} modelName   delegate the callback will write (e.g. 'dPR')
 * @param {(db: object) => Promise<any>} fn
 */
async function withRecordTransaction(prisma, modelName, fn) {
  if (!prisma || typeof prisma.$transaction !== 'function') return fn(prisma);
  return prisma.$transaction(async (tx) => {
    const usable = tx && tx[modelName] && typeof tx[modelName].create === 'function';
    return fn(usable ? tx : prisma);
  });
}

/**
 * [DR-006] Step (a): re-assert, INSIDE the transaction, that every photo
 * still maps to a CONFIRMED intent owned by `employeeId`.
 *
 * This is not a duplicate of `validatePhotoIntents` — that one ran before
 * the transaction opened. This read happens under the same snapshot as the
 * create and the bind, so it fails fast (before we write anything) when a
 * sweep landed between request validation and here.
 *
 * @throws {PhotoBindingLostError}
 */
async function assertPhotoIntentsBindable({ tx, employeeId, photos }) {
  if (!Array.isArray(photos) || photos.length === 0) return;
  if (!tx || !tx.uploadIntent || typeof tx.uploadIntent.findMany !== 'function') return;

  const ulids = uniqueUlids(photos);
  if (ulids.length === 0) return;

  const confirmed = await tx.uploadIntent.findMany({
    where: { employeeId, ulid: { in: ulids }, status: 'CONFIRMED' },
    select: { ulid: true },
  });
  if (confirmed.length !== ulids.length) {
    throw new PhotoBindingLostError({ expected: ulids.length, bound: confirmed.length });
  }
}

/**
 * [DR-006] Steps (c)+(d): claim the intents INSIDE the create transaction.
 *
 * Unlike `bindPhotoIntents`, a short count or a failed write THROWS, which
 * rolls the enclosing transaction back. That is the whole point: a report
 * whose evidence could not be claimed must not exist.
 *
 * An empty photos array is a no-op (`ulid: { in: [] }` would be too, but we
 * short-circuit so the no-photo path never touches the registry).
 *
 * @throws {PhotoBindingLostError}
 */
async function bindPhotoIntentsTx({ tx, employeeId, photos, boundType, recordId }) {
  if (!Array.isArray(photos) || photos.length === 0) return { bound: 0, expected: 0 };
  if (!tx || !tx.uploadIntent || typeof tx.uploadIntent.updateMany !== 'function') {
    return { bound: 0, expected: 0 }; // see "Graceful degradation" above
  }

  const ulids = uniqueUlids(photos);
  if (ulids.length === 0) return { bound: 0, expected: 0 };

  const result = await tx.uploadIntent.updateMany({
    // `status: 'CONFIRMED'` is the atomic guard — see the DR-006 block above.
    where: { employeeId, ulid: { in: ulids }, status: 'CONFIRMED' },
    data: { boundType, boundAt: new Date() },
  });
  const bound = (result && typeof result.count === 'number') ? result.count : 0;

  if (bound !== ulids.length) {
    console.warn('[upload/intent] bind short — rolling back record create', {
      employeeHash: hashIdentifier(employeeId),
      boundType,
      recordId,
      expected: ulids.length,
      bound,
    });
    throw new PhotoBindingLostError({ expected: ulids.length, bound, boundType });
  }
  return { bound, expected: ulids.length };
}

module.exports = {
  validatePhotoIntents,
  bindPhotoIntents,
  uniqueUlids,
  // [DR-006] atomic claim-with-create
  PhotoBindingLostError,
  photoBindingLostResponse,
  withRecordTransaction,
  assertPhotoIntentsBindable,
  bindPhotoIntentsTx,
};
