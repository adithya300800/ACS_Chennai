require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const { PrismaClient } = require('@prisma/client');

const authRoutes = require('./routes/auth');
const attendanceRoutes = require('./routes/attendance');
const dprRoutes = require('./routes/dpr');
const contactRoutes = require('./routes/contact');
const { loginLimiter, refreshLimiter, contactLimiter, sasLimiter } = require('./middleware/rateLimit');

const app = express();
const prisma = new PrismaClient();

// Trust Azure App Service load balancer (1 hop) so req.ip reflects the client
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
app.use(helmet({ contentSecurityPolicy: false })); // API only; tighten later if HTML routes appear

// CORS — manual headers, exact origin allowlist
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Max-Age', '300');
  }
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});

// Body parser with explicit per-route size limits applied via per-route options below.
// Default 100kb is fine for most endpoints; auth/contact use a tighter limit.
app.use(express.json({ limit: '1mb' }));

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
    checks.db = `fail: ${err.message?.split('\n')[0] || 'unknown'}`;
  }

  try {
    const { getClient } = require('./lib/blobStorage');
    const client = getClient();
    // List containers with prefix to verify credentials without listing the whole account
    const iter = client.listContainers({ prefix: 'dpr-' }).byPage({ maxPageSize: 1 });
    await iter.next();
    checks.blob = 'ok';
  } catch (err) {
    ok = false;
    checks.blob = `fail: ${err.message?.split('\n')[0] || 'unknown'}`;
  }

  res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'degraded', checks });
});

// ─── Routes ──────────────────────────────────────────────────────────────────
// Auth: rate-limit per-IP BEFORE routing so abusive callers hit the limiter
// even if their payload would otherwise be parsed/rejected.
app.use('/api/auth/login', loginLimiter);
app.use('/api/auth/refresh', refreshLimiter);
app.use('/api/auth', express.json({ limit: '32kb' }), authRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/dpr/sas-url', sasLimiter);
app.use('/api/dpr', dprRoutes);
app.use('/api/contact', contactLimiter, express.json({ limit: '16kb' }), contactRoutes);

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  const requestId = req.headers['x-request-id'] || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  console.error(`[err ${requestId}]`, err.message);
  if (process.env.NODE_ENV !== 'production') {
    console.error(err.stack);
  }
  res.status(500).json({ error: 'Internal server error', requestId });
});

// ─── Process error handlers (Node 22 default: terminate on unhandled rejection) ──
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
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
