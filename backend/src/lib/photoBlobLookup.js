/**
 * [DR-018] Canonical-photo-blob resolver.
 *
 * The audit caught a path-derivation bug in every DPR photo read site
 * (list, detail, repair). Every reader was reconstructing the storage
 * key as `${dpr.submittedById}/${photo.ulid}.${ext}` — the shape the
 * `/sas-url` mint uses *for the original submitter*. When an admin
 * replaces a photo whose bytes were never landed, the new `/sas-url`
 * mints under the admin's prefix, but the reader still looked under
 * the submitter's prefix. The byte was at `${adminId}/${ulid}.ext`;
 * the reader asked for `${submitterId}/${ulid}.ext` and returned a
 * null `readUrl`, the BLOB_GONE placeholder rendered, and the photo
 * looked permanently unrecoverable.
 *
 * This helper exposes the two candidate addresses a reader should
 * try, in priority order:
 *
 *   1. **Canonical** — the `blobPath` stamped on the most recent
 *      CONFIRMED `uploadIntent` row for `(container, ulid)`. The
 *      intent row is the durable handshake written by `/sas-url`
 *      before the presigned PUT is even issued (lib/uploadRoutes.js
 *      line 301), so it is the authoritative answer to "where did
 *      this ulid land?". Read-time lookup means we don't need a
 *      schema migration; the intent row is already there.
 *
 *   2. **Legacy** — the historical `${dpr.submittedById}/${ulid}.${ext}`
 *      derivation, kept so a photo uploaded before the intent lookup
 *      was wired (and any read path that hasn't yet been migrated)
 *      still resolves. This is the exact shape the production
 *      readers were using pre-fix.
 *
 * `resolvePhotoBlobAddress()` returns the *first* candidate R2
 * resolves as `outcome: 'present'`; `null` if every candidate is
 * `absent` (the photo is genuinely gone and the SPA should keep its
 * BLOB_GONE surface). Network / permission / timeout failures on any
 * single candidate still fall through to the next, so a flaky R2 on
 * the canonical path does not regress the legacy path.
 *
 * Mock-friendly — gracefully returns `null` for the canonical branch
 * when `prisma.uploadIntent` is not exposed (the legacy unit suites
 * wire a hand-rolled Prisma mock with only `dPR` / `inspectionRecord`
 * / `dPRPhoto`).
 */

'use strict';

const { CONTENT_TYPE_EXT, verifyBlobExists, isAbsent } = require('./blobStorage');

/**
 * Build the legacy `${submitterId}/${ulid}.${ext}` derivation. Pure
 * function — no I/O — so it can be reused by tests and by the
 * existing readers that don't yet need the dual-reader.
 */
function legacyPhotoBlobName(dpr, photo) {
  if (!dpr || !dpr.submittedById || !photo || !photo.ulid) return null;
  const ext = CONTENT_TYPE_EXT[photo.contentType];
  return ext
    ? `${dpr.submittedById}/${photo.ulid}.${ext}`
    : `${dpr.submittedById}/${photo.ulid}`;
}

/**
 * Look up the canonical blob address from the durable `uploadIntent`
 * table. Returns `null` when the intent row is missing / not
 * CONFIRMED / on a different container — every condition the reader
 * should treat as "fall back to the legacy derivation".
 *
 * Best-effort: any DB error is swallowed and reported as `null` so a
 * transient intent-table outage never breaks the legacy read.
 */
async function canonicalPhotoBlobName(prisma, photo) {
  if (!prisma || !prisma.uploadIntent || typeof prisma.uploadIntent.findFirst !== 'function') {
    return null;
  }
  if (!photo || !photo.ulid || !photo.container) return null;
  try {
    const intent = await prisma.uploadIntent.findFirst({
      where: {
        ulid: photo.ulid,
        container: photo.container,
        status: 'CONFIRMED',
      },
      orderBy: { confirmedAt: 'desc' },
      select: { blobPath: true },
    });
    return intent && intent.blobPath ? intent.blobPath : null;
  } catch (err) {
    return null;
  }
}

/**
 * Resolve a photo to the first storage address R2 confirms as
 * present, in canonical → legacy order. Returns `null` only when
 * every candidate is `absent` (a 404 from HEAD). `unknown` outcomes
 * (timeout / 403 / 5xx) fall through to the next candidate so a
 * single-path R2 hiccup doesn't regress the read.
 *
 * @returns {Promise<{ blobName: string|null, source: 'canonical'|'legacy'|'absent' }>}
 */
async function resolvePhotoBlobAddress({ prisma, photo, dpr }) {
  const legacy = legacyPhotoBlobName(dpr, photo);
  const canonical = await canonicalPhotoBlobName(prisma, photo);

  const candidates = [];
  if (canonical && canonical !== legacy) candidates.push({ blobName: canonical, source: 'canonical' });
  if (legacy) candidates.push({ blobName: legacy, source: 'legacy' });

  for (const c of candidates) {
    let props;
    try {
      props = await verifyBlobExists(photo.container, c.blobName);
    } catch (_err) {
      // Defensive — `verifyBlobExists` already swallows thrown errors
      // and returns an outcome shape, so this branch should not fire
      // in production. Skip and try the next candidate.
      continue;
    }
    if (props && props.outcome === 'present') {
      return { blobName: c.blobName, source: c.source };
    }
    // 'absent' or 'unknown' → fall through to next candidate.
  }

  return { blobName: null, source: 'absent' };
}

module.exports = {
  legacyPhotoBlobName,
  canonicalPhotoBlobName,
  resolvePhotoBlobAddress,
};