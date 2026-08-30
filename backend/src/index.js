require('dotenv').config();
// express-async-errors monkey-patches Express 4 to forward rejected promises
// from async route handlers into the global error middleware. Without it,
// 23 of 24 async handlers (attendance.js, auth.js, contact.js, dpr.js) would
// silently turn DB errors into unhandledRejections, never reaching the
// Prisma-error mapper at the bottom of this file. MUST be required before
// any route module is loaded.
require('express-async-errors');
const express = require('express');
const helmet = require('helmet');
const { PrismaClient } = require('@prisma/client');

const authRoutes = require('./routes/auth');
const attendanceRoutes = require('./routes/attendance');
const dprRoutes = require('./routes/dpr');
const contactRoutes = require('./routes/contact');
const diagRoutes = require('./routes/diag'); // Round-8: diagnostic endpoint (intentionally retained for ops — gated by admin auth)
const { loginLimiter, refreshLimiter, contactLimiter, sasLimiter } = require('./middleware/rateLimit');

const app = express();
const prisma = new PrismaClient();

// Trust Render's reverse-proxy load balancer (1 hop) so req.ip reflects the
// real client behind Render's edge, not the proxy's IP (rate-limit + audit).
app.set('trust proxy', 1);

const PORT = (process.env.PORT && process.env.PORT !== '') ? process.env.PORT : 8080;

// Allowed origins — exact match only, no wildcard subdomain trust
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean)
  : (process.env.FRONTEND_URL ? [process.env.FRONTEND_URL] : [])
);

if (process.env.NODE_ENV === 'production' && ALLOWED_ORIGINS.length === 0) {
  throw new Error('ALLOWED_ORIGINS or FRONTEND_URL must be set in production');
}

app.disable('x-powered-by');
// Round-7: enable full helmet defaults (CSP, HSTS, X-Frame-Options,
// X-Content-Type-Options, Referrer-Policy, etc). The previous config
// disabled CSP entirely because we assumed an API doesn't render HTML —
// but helmet's defaults are still valuable (HSTS prevents SSL-stripping
// MITM, X-Content-Type-Options prevents MIME sniffing on the JSON
// responses, X-Frame-Options prevents clickjacking on error pages if any
// HTML slips through). The default CSP `default-src 'self'` is fine for
// a JSON-only API — there are no inline scripts or external assets.
//
// Round-11: override helmet's default `Cross-Origin-Opener-Policy:
// same-origin` to `same-origin-allow-popups`. The default severs
// window.opener as soon as the Zoho OAuth popup navigates cross-origin
// from the popup opener (acschennai.com) to the backend's callback
// (acs-chennai.onrender.com) — which means the callback HTML's
// `window.opener.postMessage(...)` runs against `window.opener === null`
// and the OAuth tokens are silently never delivered to the parent.
// `same-origin-allow-popups` preserves COOP isolation for non-popup
// browsing contexts while keeping the opener reference intact for
// popup-launched documents, which is exactly what the OAuth callback
// needs.
app.use(helmet({
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
}));

// CORS — manual headers, exact origin allowlist.
// Round-7: trimmed methods to what this API actually uses. Audited the
// routes: only GET, POST, PUT are mounted (no DELETE or PATCH handlers).
// Listing unused methods gives browsers no extra capability but makes
// intent fuzzing easier (e.g. an attacker probing for DELETE endpoints
// knows the server's CORS policy explicitly allows it).
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key, X-Request-ID, X-Internal-Token');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Max-Age', '300');
  }
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});

// Body parser — per-route mounts instead of a global default. Round-7 fix:
// the previous global `express.json({ limit: '1mb' })` made the tighter
// per-route limits (32kb auth, 16kb contact) no-ops, because Express 4's
// json middleware skips re-parsing once the body is populated. Now the
// default body-parser limit is 16kb applied globally, and the DPR mount
// (which legitimately needs larger photo-metadata payloads) opts in to 1mb.
//
// Mount order matters: parser must be before the route handler.
const defaultBodyLimit = '16kb';
const dprBodyLimit = '1mb';
app.use(express.json({ limit: defaultBodyLimit }));

app.set('prisma', prisma);

// ─── Health & readiness ──────────────────────────────────────────────────────
// /health is the liveness probe (lightweight — never depends on downstreams).
// Deliberately returns only {status, timestamp}. Deploy metadata (SHA, time)
// is exposed only on /version, which requires an internal token — public
// attackers don't need to know which commit is running.
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

// /version is for ops/SRE dashboards. Requires the X-Internal-Token header to
// match INTERNAL_API_TOKEN env var (set via Azure App Setting). 404 when unset.
app.get('/version', (req, res) => {
  const expected = process.env.INTERNAL_API_TOKEN;
  if (!expected) {
    return res.status(404).json({ error: 'Not found' });
  }
  if (req.headers['x-internal-token'] !== expected) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json({
    status: 'ok',
    deploySha: process.env.DEPLOY_SHA || 'unknown',
    deployTime: process.env.DEPLOY_TIME || 'unknown',
    nodeEnv: process.env.NODE_ENV,
  });
});

app.get('/ready', async (req, res) => {
  const checks = { db: 'fail', blob: 'fail' };
  let ok = true;

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.db = 'ok';
  } catch (err) {
    ok = false;
    // Include err.code + err.name so an empty-message Prisma error (e.g.
    // a network-layer failure) still surfaces the cause for diagnosis.
    checks.db = `fail: ${err.code || err.name || 'unknown'}: ${err.message?.split('\n')[0] || ''}`;
  }

  try {
    // R2/S3 readiness: cheap credential + bucket reachability probe.
    // The previous code called client.listContainers — an Azure Blob SDK
    // method that does NOT exist on the AWS S3 v3 client the R2 client is
    // built on. This permanently surfaced a 503 from /ready. HeadBucketCommand
    // is the S3-equivalent (R2-compatible) credential check; it doesn't
    // enumerate objects, so it stays cheap on the hot path.
    const { getClient } = require('./lib/blobStorage');
    const { HeadBucketCommand } = require('@aws-sdk/client-s3');
    const client = getClient();
    const bucket = process.env.R2_BUCKET_DPR_PHOTOS || 'dpr-photos';
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    checks.blob = 'ok';
  } catch (err) {
    ok = false;
    // Distinguish missing-bucket (NotFound), auth/perm (Forbidden), and
    // network failures (NetworkingError) so operators can see the cause
    // without the error leaking credentials or bucket names.
    const errName = err?.name || err?.Code || 'unknown';
    checks.blob = `fail: ${errName}`;
  }

  res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'degraded', checks });
});

// ─── Routes ──────────────────────────────────────────────────────────────────
// Auth: rate-limit per-IP BEFORE routing so abusive callers hit the limiter
// even if their payload would otherwise be parsed/rejected.
app.use('/api/auth/login', loginLimiter);
app.use('/api/auth/refresh', refreshLimiter);
app.use('/api/auth', authRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/dpr/sas-url', sasLimiter);
// DPR mount opts in to a 1mb body limit (work entries + photo metadata
// payloads can legitimately exceed the 16kb default).
app.use('/api/dpr', express.json({ limit: dprBodyLimit }), dprRoutes);
app.use('/api/contact', contactLimiter, contactRoutes);
// Round-8 TEMPORARY: diagnostic endpoint to introspect deployed DB schema.
// Mounted AFTER the body-parsers so it can read raw body. DELETE after F5/F6 resolved.
app.use('/api/diag', diagRoutes);

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  const requestId = req.headers['x-request-id'] || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // Map known Prisma error codes to the right HTTP response so the
  // client gets actionable 4xx instead of a generic 500.
  let status = 500;
  let body = { error: 'Internal server error', requestId };
  // Round-8 (F1): body-parser SyntaxError → 400 instead of 500. The previous
  // catch-all surfaced `not-json{` as 500, which masked the actual cause
  // (malformed JSON from the client) and made it look like a server bug.
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError) && err.status === 400) {
    status = 400;
    body = { error: 'Malformed JSON body', code: 'INVALID_JSON', requestId };
  } else if (err && typeof err.code === 'string') {
    if (err.code === 'P2003') { status = 400; body = { error: 'Referenced record does not exist', code: 'FK_VIOLATION', requestId }; }
    else if (err.code === 'P2009') { status = 400; body = { error: 'Database rejected the input', code: 'VALIDATION_FAILED', requestId }; }
    else if (err.code === 'P2025') { status = 404; body = { error: 'Record not found', code: 'NOT_FOUND', requestId }; }
    else if (['P1001','P1002','P1017','P2024'].includes(err.code)) { status = 503; body = { error: 'Database temporarily unavailable', code: 'DB_UNAVAILABLE', requestId }; }
  }
  console.error(`[err ${requestId}]`, {
    path: req.path,
    method: req.method,
    status,
    code: err?.code,
    name: err?.name,
    message: err?.message?.split('\n')[0],
  });
  if (process.env.NODE_ENV !== 'production') {
    console.error(err.stack);
  }
  res.status(status).json(body);
});

// ─── Process error handlers (Node 22 default: terminate on unhandled rejection) ──
process.on('unhandledRejection', (reason) => {
  // Structured so we can filter for Prisma codes specifically.
  console.error('[unhandledRejection]', {
    code: reason?.code,
    name: reason?.name,
    message: reason?.message?.split('\n')[0],
  });
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', {
    code: err?.code,
    name: err?.name,
    message: err?.message?.split('\n')[0],
  });
  // Best-effort shutdown
  prisma.$disconnect().catch(() => {}).finally(() => process.exit(1));
});

// ─── Boot ────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`ACS Portal API listening on port ${PORT}`);
  console.log(`Allowed origins: ${ALLOWED_ORIGINS.join(', ') || '(none)'}`);
});

// Graceful shutdown — close server first, then disconnect Prisma
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] received ${signal}, draining...`);
  server.close((err) => {
    if (err) console.error('[shutdown] server.close error', err);
  });
  try {
    await prisma.$disconnect();
  } catch (e) {
    console.error('[shutdown] prisma disconnect error', e);
  }
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
