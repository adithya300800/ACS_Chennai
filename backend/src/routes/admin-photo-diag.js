/**
 * TEMPORARY admin-gated diagnostic — DELETE this file + its mount in
 * index.js once we have a confirmed root cause for the Sept-11/12 DPR +
 * Inspection photo BLOB_GONE reports (2026-09-15).
 *
 * Not security-sensitive: this route is gated behind `requireFreshAdmin`
 * (DB-backed admin claim, not just a JWT claim) so a leaked JWT alone
 * can't probe internal R2 paths. But: this route widens the attack
 * surface of an admin hit, so it should NOT outlive the investigation.
 *
 * Endpoints:
 *   GET /api/admin/diag/photo-head
 *     Query params:
 *       container  — required, one of ALLOWED_R2_BUCKETS
 *       blobPath   — required, full blob key the app currently mints
 *                    (e.g. "<employeeId>/<ulid>.jpg")
 *       ulid       — optional, full 26-char ULID. When supplied, we list
 *                    every key in `container` whose path contains it so
 *                    we can detect "bytes were uploaded but at the wrong
 *                    path" mismatches between DB and R2.
 *
 *     Returns:
 *       {
 *         container, expectedBlobPath,
 *         head: { exists, contentType?, contentLength?, lastModified? }
 *         ulidMatches: string[],         // empty if no ulid supplied
 *       }
 */
const express = require('express');
const router = express.Router();
const { requireAuth, requireFreshAdmin } = require('../middleware/auth');
const { verifyBlobExists, listObjects, ALLOWED_R2_BUCKETS } = require('../lib/blobStorage');

router.use(requireAuth);
router.use(requireFreshAdmin);

router.get('/photo-head', async (req, res) => {
  const { container, blobPath, ulid } = req.query;
  if (!container || !blobPath) {
    return res.status(400).json({ error: 'container + blobPath are required' });
  }
  if (!ALLOWED_R2_BUCKETS.includes(container)) {
    return res.status(400).json({
      error: 'unknown container',
      allowed: ALLOWED_R2_BUCKETS,
    });
  }

  try {
    const props = await verifyBlobExists(container, blobPath);

    // Optional cross-reference: list keys (capped at 1000) and filter for
    // any that contain the supplied ulid. Detects "uploaded but to a
    // different employee-prefix" mismatches between DB and R2.
    let ulidMatches = [];
    if (typeof ulid === 'string' && ulid.length >= 8) {
      const all = await listObjects(container, { MaxKeys: 1000 });
      ulidMatches = all.filter((o) => o.Key.includes(ulid)).map((o) => o.Key);
    }

    return res.json({
      container,
      expectedBlobPath: blobPath,
      head: props.exists
        ? {
            exists: true,
            contentType: props.contentType,
            contentLength: props.contentLength,
            lastModified: props.lastModified,
          }
        : { exists: false },
      ulidMatches,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

module.exports = router;
