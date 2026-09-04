// Round-26.5: Cold-start warm-up endpoint.
//
// Render's free plan spins the service down after 15 minutes of idle. The
// next request after a sleep pays a ~30-60s cold-start tax AND frequently
// hits a TCP-level reset (the waking server drops the in-flight connection
// before it has a chance to bind its socket). Round-26.5 closed the user-
// facing half of that race with api.request() retry-once-on-NETWORK_ERROR
// for mutating verbs (src/lib/api.js).
//
// This endpoint closes the operational half: a low-cost ping that keeps
// the server warm. We schedule it from a Render Cron Job at every 10
// minutes (`*/10 * * * *` UTC). 10 min < 15 min idle window = no spin-down.
// The ping also touches prisma so the DB connection pool is warm, which
// is the other half of the cold-start race on the Supabase side.
//
// Endpoint:
//   POST /api/internal/warmup/ping
//     Header: X-Internal-Token: <INTERNAL_API_TOKEN>
//   Optional: ?touch=db to force a `SELECT 1` round-trip (default: true)
//
// Response shape mirrors the existing internal-* endpoints so the cron
// job's success-detection is uniform:
//
//   { ok: true, ts: <iso>, warmupMs: <elapsed>, dbTouched: <bool> }
//
// Failure shape:
//
//   { ok: false, error: <string> } (HTTP 503)
//
// Cost math (Render free plan):
//   - 6 pings/hour × 24h = 144/day. Each ping ~200ms of CPU.
//   - Negligible vs the human-facing cold-start pain (a 30s timeout on
//     the first user action after a 15-min lull).
//
// If we ever move off Render's free plan (the user mentioned this is
// budget-driven), this endpoint can be deleted along with the cron job.

'use strict';

const express = require('express');
const router = express.Router();

function getPrisma(req) { return req.app.get('prisma'); }

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// Mirror internal-digest.js:77 — 404 when unset, 403 when mismatched.
// Same shape as the other internal endpoints so the cron job's auth
// expectations don't drift between sibling routes.
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

router.post('/ping', requireInternalToken, asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const start = Date.now();

  // ?touch=db (default true) — a no-op-ish query that forces a real
  // round-trip to the Supabase pooler. The whole point of the ping is
  // to wake everything up; skipping the DB touch would let the pool
  // go cold between pings on slow paths.
  const touchParam = typeof req.query.touch === 'string' ? req.query.touch.toLowerCase() : 'db';
  const touchDb = touchParam !== 'no' && touchParam !== 'false' && touchParam !== '0';

  let dbTouched = false;
  if (touchDb && prisma) {
    try {
      // $queryRaw is the cheapest read; no model scan, no auth overhead.
      await prisma.$queryRaw`SELECT 1`;
      dbTouched = true;
    } catch (err) {
      // Don't fail the ping on DB hiccups — the cold-start prevention
      // is the goal; the DB is secondary. Log so we can spot chronic
      // outages via the cron logs.
      console.warn('[internal-warmup] db touch failed', {
        message: err?.message?.split('\n')[0],
        prismaCode: err?.code,
      });
    }
  }

  res.json({
    ok: true,
    ts: new Date().toISOString(),
    warmupMs: Date.now() - start,
    dbTouched,
  });
}));

module.exports = router;
