// Round-40 #4 — app_log retention enforcement.
//
// Background:
//   The new AppLog table (see backend/prisma/schema.prisma) is the single
//   durable store for HTTP requests, error-handler errors, and safeAsync
//   fanout failures. Without a retention policy the table grows unbounded —
//   at ~30k rows/day the projected 500 MB Supabase free-tier quota is the
//   binding limit somewhere between months 1 and 6.
//
// This file ships ONE endpoint: `POST /api/internal/cron/prune-logs`,
// called daily by a GitHub Actions workflow (cron-prune-logs.yml).
// The endpoint deletes rows older than `LOG_RETENTION_DAYS` (default 30)
// using a raw DELETE — see why in (1).
//
//   GH Actions rather than a Render Cron Job for the same reason as
//   cron-upload-sweep.yml and cron-warmup.yml: Render cron requires a
//   paid plan, and public repo Actions minutes are free. Worst-case
//   lag is ~5-15 minutes, and the only consequence of a delayed run
//   is that some log rows live ~24h longer than the retention window
//   — harmless.
//
// (1) Why raw $executeRaw over prisma.appLog.deleteMany:
//   - `deleteMany({ where: { createdAt: { lt: threshold } } })` works fine
//     and would be the idiomatic shape. We use $executeRaw because it lets
//     us stamp the deletion count directly into a structured log row
//     AND return it in the response body. The query plan for an indexed
//     range DELETE on `created_at` is identical to Prisma's compiled form
//     so there is no performance trade-off.
//   - The `@@index([createdAt])` index on AppLog keeps this DELETE a
//     single contiguous range scan (matches the partitioning-rejected
//     decision rationale from the round-40 plan).
//
// (2) No VACUUM:
//   Postgres autovacuum runs daily per the default 200-threshold factor
//   anyway and reclaims dead tuples asynchronously. Manually VACUUMing
//   from a cron fires additional I/O during the very incident (storage
//   pressure) that put us in this position — unhelpful. The autovacuumer
//   reclaims within ~24h of the DELETE.
//
// (3) The retention row itself (the one we emit at "cron.prune_logs"
//   level=info after the DELETE succeeds) is ALSO subject to retention on
//   the next prune. That's correct: the row is a proof-of-life that the
//   prune ran, not a durable audit requirement (the audit requirement is
//   that the prune RAN, which is verified by GH Actions' own run-log
//   retention).
//
// (4) Idempotency:
//   DELETE is idempotent — re-running the endpoint on the same day is a
//   no-op. The endpoint can be safely called by both the daily cron AND a
//   manual backfill (`dryRun=true` for preview, no `dryRun` for actual
//   deletion).
//
// (5) Auth:
//   INTERNAL_API_TOKEN gate, same shape as internal-warmup, internal-
//   digest, internal-training-overdue, internal-admin-attendance. 404
//   when unset, 403 when the header doesn't match.

'use strict';

const express = require('express');
const router = express.Router();
const log = require('../lib/log');

function getPrisma(req) { return req.app.get('prisma'); }

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// Mirror internal-warmup.js:52 — 404 when unset, 403 when mismatched.
function requireInternalToken(req, res, next) {
  const expected = process.env.INTERNAL_API_TOKEN;
  if (!expected) {
    return res.status(404).json({ error: 'Not found' });
  }
  if (req.headers['x-internal-token'] !== expected) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

const DEFAULT_RETENTION_DAYS = 30;

router.post('/prune-logs', requireInternalToken, asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  if (!prisma) {
    return res.status(500).json({ error: 'Prisma not available' });
  }

  // Allow operators to override retention per-call (backfill windows, dry-
  // runs, ad-hoc tightening). Default mirrors LOG_RETENTION_DAYS so a
  // service-level config change actually takes effect without a redeploy.
  const configuredDays = parseInt(process.env.LOG_RETENTION_DAYS || '', 10);
  const queryDays = parseInt(
    typeof req.query.days === 'string' ? req.query.days : '',
    10,
  );
  const retentionDays = Number.isFinite(queryDays) && queryDays > 0
    ? queryDays
    : (Number.isFinite(configuredDays) && configuredDays > 0
        ? configuredDays
        : DEFAULT_RETENTION_DAYS);

  const dryRun = String(req.query.dryRun || '').toLowerCase() === 'true';

  let deleted = 0;
  let ranAt = new Date();

  if (dryRun) {
    // COUNT(*) instead of DELETE so an operator can preview without
    // mutating. Mirrors the shape of the real run's response so the
    // operator's verification script doesn't need a branch.
    const rows = await prisma.$queryRaw`
      SELECT COUNT(*)::int AS n FROM app_log WHERE created_at < NOW() - (${retentionDays} * INTERVAL '1 day')
    `;
    deleted = Array.isArray(rows) && rows[0] ? Number(rows[0].n) : 0;
  } else {
    const result = await prisma.$executeRaw`
      DELETE FROM app_log WHERE created_at < NOW() - (${retentionDays} * INTERVAL '1 day')
    `;
    // $executeRaw returns the number of affected rows on a Postgres
    // DELETE — driver-agnostic under Prisma's pg adapter. The BigInt
    // shape on some platforms is normalised to Number for the log.
    deleted = typeof result === 'bigint' ? Number(result) : Number(result || 0);
  }

  log.info(
    {
      source: 'cron',
      route: req.originalUrl,
      method: req.method,
      retentionDays,
      dryRun,
      deleted,
    },
    'cron.prune_logs',
  );

  res.json({
    ok: true,
    ranAt: ranAt.toISOString(),
    retentionDays,
    deleted,
    dryRun,
  });
}));

module.exports = router;
