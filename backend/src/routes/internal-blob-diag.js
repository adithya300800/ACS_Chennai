// [BLOB_GONE root-cause diagnostic, 2026-09-14] TEMPORARY one-shot probe.
//
// Symptom: ProjectAttachment download returns ⚠ BLOB_GONE on every report.
// Hypothesis: R2 bucket reachable (dpr-photos / dpr-documents both HEAD-ok
// on /ready) but the bytes referenced by `ProjectAttachment.blobPath` are
// missing from that bucket — either because the bucket is wrong (different
// R2 account), the prefix is wrong (legacy `report/` vs current unprefixed
// layout), or the bytes truly don't exist.
//
// Diagnostic surfaces all four signals:
//   1. List first N keys in dpr-photos + dpr-documents (with common
//      prefix buckets so we can spot a prefix-mismatch pattern).
//   2. For every non-deleted ProjectAttachment row, run verifyBlobExists
//      and report exists:true / exists:false / errored.
//   3. For every DPR photo row, run verifyBlobExists on each blob in the
//      photo's `blobPath`.
//   4. Cross-reference: how many DB rows have ZERO matching keys in the
//      bucket (genuinely missing) vs how many errored (likely IAM/account
//      drift).
//
// Gated on the same INTERNAL_API_TOKEN as /version + the other internal-*
// routes. DELETE this file + remove the mount in index.js after the
// diagnostic returns. Don't keep a diagnostic route in production.

'use strict';

const express = require('express');
const router = express.Router();
const { HeadObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const blobStorage = require('../lib/blobStorage');

function getPrisma(req) { return req.app.get('prisma'); }

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function requireInternalToken(req, res, next) {
  const expected = process.env.INTERNAL_API_TOKEN;
  if (!expected) return res.status(404).json({ error: 'Not found' });
  if (req.headers['x-internal-token'] !== expected) return res.status(403).json({ error: 'Forbidden' });
  next();
}

// List up to MaxKeys keys in a bucket. Cheap — no recursion on ContinuationToken,
// that's enough for a diagnostic.
async function listKeys(Bucket, MaxKeys = 2000) {
  const client = blobStorage.getClient();
  const resp = await client.send(new ListObjectsV2Command({ Bucket, MaxKeys }));
  const keys = (resp.Contents || []).map((o) => ({
    Key: o.Key,
    Size: o.Size,
    LastModified: o.LastModified,
  }));
  // Prefix buckets — first two path segments. Helpful for spotting whether
  // keys live under `report/` (legacy) vs `${employeeId}/` (current).
  const prefixCounts = {};
  for (const k of keys) {
    const seg = k.Key.split('/').slice(0, 2).join('/');
    prefixCounts[seg] = (prefixCounts[seg] || 0) + 1;
  }
  const topPrefixes = Object.entries(prefixCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([prefix, count]) => ({ prefix, count }));
  return { totalListed: keys.length, truncated: resp.IsTruncated || false, topPrefixes, sampleKeys: keys.slice(0, 25) };
}

async function headBlob(Bucket, Key) {
  const client = blobStorage.getClient();
  try {
    const props = await client.send(new HeadObjectCommand({ Bucket, Key }));
    return { exists: true, size: props.ContentLength, contentType: props.ContentType };
  } catch (err) {
    const code = err?.$metadata?.httpStatusCode;
    const name = err?.name || err?.Code || 'unknown';
    if (code === 404 || code === 403) return { exists: false, code, name };
    return { exists: false, errored: true, code, name, message: err?.message?.split('\n')[0] };
  }
}

router.get('/blob-diag', requireInternalToken, asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const bucketsToProbe = (req.query.buckets?.split(',') || ['dpr-photos', 'dpr-documents']);
  const maxKeys = Math.min(parseInt(req.query.maxKeys || '2000', 10) || 2000, 5000);

  const out = {
    ts: new Date().toISOString(),
    buckets: {},
    projectAttachments: null,
    dprPhotos: null,
  };

  // 1. Bucket listings.
  for (const Bucket of bucketsToProbe) {
    try {
      out.buckets[Bucket] = await listKeys(Bucket, maxKeys);
    } catch (err) {
      out.buckets[Bucket] = { errored: true, code: err?.$metadata?.httpStatusCode, name: err?.name, message: err?.message?.split('\n')[0] };
    }
  }

  // 2. ProjectAttachment rows.
  if (prisma) {
    try {
      const rows = await prisma.projectAttachment.findMany({
        where: { deletedAt: null },
        select: { id: true, projectId: true, blobPath: true, filename: true, uploadedAt: true, contentType: true, sizeBytes: true },
        orderBy: { uploadedAt: 'desc' },
        take: 200,
      });
      const results = [];
      let exists = 0, gone = 0, errored = 0;
      for (const r of rows) {
        const head = await headBlob('dpr-documents', r.blobPath);
        if (head.exists) exists++;
        else if (head.errored) errored++;
        else gone++;
        results.push({ id: r.id, blobPath: r.blobPath, filename: r.filename, uploadedAt: r.uploadedAt, ...head });
      }
      out.projectAttachments = { total: rows.length, exists, gone, errored, sample: results.slice(0, 30), full: results };
    } catch (err) {
      out.projectAttachments = { errored: true, message: err?.message?.split('\n')[0] };
    }
  }

  // 3. DPR photo rows — Prisma schema uses `blobPath` (TEXT[]) in some versions
  //    and `path` (TEXT) in others. Probe both shapes.
  if (prisma) {
    try {
      const photos = await prisma.dPRPhoto.findMany({
        select: { id: true, dprId: true, blobPath: true },
        take: 50,
      }).catch(() => []);
      if (photos.length === 0) {
        // Try the legacy field name.
        const alt = await prisma.dPRPhoto.findMany({
          select: { id: true, dprId: true, path: true },
          take: 50,
        }).catch(() => []);
        out.dprPhotos = { triedField: 'path', count: alt.length };
      } else {
        out.dprPhotos = { triedField: 'blobPath', count: photos.length };
      }
    } catch (err) {
      out.dprPhotos = { errored: true, message: err?.message?.split('\n')[0] };
    }
  }

  res.json(out);
}));

module.exports = router;
