// Asia/Kolkata is the project's single source of truth for calendar days.
// The server otherwise runs in Render's UTC default, which produces
// off-by-one day-buckets for users east of UTC — e.g. an IST employee
// marking between 00:00 and 05:29 IST would see their record bucketed
// under the PREVIOUS UTC date. MUST be set before any Date operation,
// including module-level requires that may read the clock indirectly.
process.env.TZ = 'Asia/Kolkata';
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
const { randomUUID } = require('crypto');
const { PrismaClient } = require('@prisma/client');

const authRoutes = require('./routes/auth');
const attendanceRoutes = require('./routes/attendance');
const dprRoutes = require('./routes/dpr');
// Round-12: Inspection & Compliance Records — new resource that owns the 15
// structured sub-work types formerly nested inside DPR.workEntries (material
// receipt, cube test, water quality, waterproofing, NCR, safety, etc.).
const inspectionRoutes = require('./routes/inspection');
// Round-13: Leave Request workflow (employee submit / admin approve-reject).
const leaveRoutes = require('./routes/leave');
// Round-14: Employee Training — admin assigns external courses (LinkedIn,
// Coursera, Udemy, YouTube, Vimeo, etc.), employees watch in-platform with
// auto progress capture via the YouTube / Vimeo IFrame APIs. Writes
// (course CRUD, bulk-assign, progress pings) are rate-limited by
// trainingWriteLimiter inside the route file; reads are not throttled.
const trainingRoutes = require('./routes/training');
const contactRoutes = require('./routes/contact');
// DR-017: admin storage health — orphan-blob summary + on-demand sweep trigger.
// Mounted at /api/admin/storage — the only admin-only ops surface left after
// DR-012 removed the /api/diag routes. Auth model is requireAuth +
// requireFreshAdmin so the storage mutation route can never run on a stale
// JWT claim.
const storageAdminRoutes = require('./routes/storage');
// SOL-P1#12: admin employee directory — powers the training bulk-assign
// picker. Lives at /api/admin/employees alongside the other admin
// surfaces so the URL pattern matches the "admin = picker" mental model.
const adminEmployeesRoutes = require('./routes/adminEmployees');
// Round-25: notification preferences + admin test-send. The 13 notification
// fan-out hooks in dpr/leave/inspection/training don't go through this
// router — they call notify.fanOutEmail() inline after their tx/inline
// notification.create. This router is the user-facing preferences surface.
const notificationsRoutes = require('./routes/notifications');
const {
  loginLimiter, refreshLimiter, contactLimiter, sasLimiter,
  exportLimiter, leaveCreateLimiter,
} = require('./middleware/rateLimit');

// DR-014 (round-20): extract the Express app factory so mounted-route
// integration tests can call `createApp({ prisma: mock, blobStorage: mock })`
// and exercise the REAL middleware stack (helmet, request-id, CORS,
// body-parser, rate-limiters, every route, the global error handler, and
// the /health /version /ready probes) against a fully wired Express app.
//
// Before this refactor, every test hand-rolled its own minimal app with one
// or two routers and a hand-copied error mapper. That meant the CI suite
// was green while the production app itself could regress (parser order,
// middleware order, error-shape mapping, /version auth). With createApp
// we test the app as it is shipped — the same code path that runs on Render.
//
// Production behavior is unchanged: startServer() still listens on PORT,
// the process still gets the real Prisma client + real blobStorage. The
// only difference is the route through createApp().
function createApp(deps = {}) {
  const prisma = deps.prisma || new PrismaClient();
  // The /ready endpoint probes R2 bucket existence via HeadBucketCommand.
  // Tests inject a mock blobStorage (with `getClient()` and `REQUIRED_BUCKETS`)
  // so they don't reach out to Cloudflare.
  const blobStorage = deps.blobStorage || require('./lib/blobStorage');

  const app = express();

  // Trust Render's reverse-proxy load balancer (1 hop) so req.ip reflects the
  // real client behind Render's edge, not the proxy's IP (rate-limit + audit).
  app.set('trust proxy', 1);

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
    // LPR-011 (smallest demonstrable fix): spell out the CSP explicitly
    // instead of relying on helmet's defaults. A JSON-only API has no
    // legitimate need for inline scripts, eval, remote script origins,
    // remote styles, images, frames, or form-action targets — every one
    // of those is a downgrade surface under XSS or stored-CSS injection.
    // The only directives we relax beyond `default-src 'self'`:
    //   - `connect-src 'self' https://accounts.zoho.com https://*.zoho.com`:
    //     the backend's outbound token-exchange + refresh call to Zoho's
    //     OAuth endpoints. CSP applies to FETCHES initiated by documents
    //     WE serve; the server-side `fetch` in /api/auth/zoho/callback
    //     technically doesn't need this directive, but listing it keeps
    //     the policy honest about where outbound traffic is allowed if a
    //     future route calls a third party from a request context.
    //   - `frame-ancestors 'none'`: blocks `<iframe>` embedding of any
    //     JSON response, which would otherwise allow clickjacking of an
    //     error page that leaked user-controlled content.
    // No `unsafe-inline`, no `'unsafe-eval'`, no wildcard `*` — the
    // CSP is tight. If a future feature needs an inline asset (a
    // `/api/auth/zoho/callback` HTML page already does, and that's the
    // ONLY HTML this server renders), it should serve that one page
    // from a separate origin or add a per-route nonce.
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'", 'https://accounts.zoho.com', 'https://*.zoho.com'],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
      },
    },
  }));

  // ─── Request ID (DR-012) ───────────────────────────────────────────────────
  // Every response carries an `X-Request-Id` so a user reporting "it failed"
  // can hand over one token that ties their request to the server log line in
  // the error handler below. Before DR-012 the id was minted *inside* the error
  // handler, which meant it only existed on 5xx responses and was never sent to
  // the client on success — useless for correlating a report after the fact.
  //
  // Mounted before CORS (and therefore before every route) so the header is
  // present on preflight 204s, health probes, 404s, and error responses alike.
  //
  // An inbound `X-Request-Id` is honoured so a trace started at Render's edge
  // or by the SPA survives the hop — but it is validated first, not echoed
  // blind. Two reasons: (1) `res.setHeader` throws `ERR_INVALID_CHAR` on a
  // value containing CR/LF, so an unvalidated echo turns a malformed header
  // into a 500; (2) an unbounded caller-controlled value would land verbatim
  // in the log line, letting a caller forge log entries. Anything that isn't a
  // short, plain token is discarded in favour of a server-generated UUID.
  const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
  app.use((req, res, next) => {
    const supplied = req.headers['x-request-id'];
    req.id = (typeof supplied === 'string' && REQUEST_ID_RE.test(supplied))
      ? supplied
      : randomUUID();
    res.setHeader('X-Request-Id', req.id);
    next();
  });

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
      // Round-13: expose Content-Disposition + X-Export-* so the browser JS
      // can read the suggested filename and the chosen export format on the
      // /api/attendance/export binary response. Without this the browser
      // gets a Blob but no way to know what to call the file or whether the
      // server fell back from xlsx to csv.
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Export-Format, X-Export-Row-Count, X-Request-Id');
      res.setHeader('Access-Control-Max-Age', '300');
    }
    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }
    next();
  });

  // Body parser — single global 1 MB limit (DR-007 fix).
  // Round-7 had a 16 KB global default + per-route 1 MB opt-ins for DPR and
  // inspection. The intent was "tight limit globally, looser limit per route".
  // In practice that didn't work: Express 4's json middleware skips re-parsing
  // once the body is populated, so a 17 KB payload hitting the global parser
  // 413'd before the route-specific parser could ever run.
  //
  // The route-level overrides are now collapsed into this single 1 MB global.
  // Rationale: DPR and inspection `data` blobs (workEntries + photo metadata,
  // NCR / cube test / material receipt structured JSON) legitimately exceed
  // the 16 KB default, but nothing in the API accepts more than ~1 MB of JSON
  // — uploads are presigned PUT to R2, not JSON bodies. Per-route tighter
  // limits (e.g. auth at 32 KB, contact at 16 KB) are NOT re-introduced here:
  // they were never enforced in Round-7 either (parser-order bug), and adding
  // them now would re-introduce the same ordering trap. If a route genuinely
  // needs a tighter limit in the future, mount its parser BEFORE this one and
  // document why.
  //
  // Mount order matters: parser must be before the route handler.
  const defaultBodyLimit = '1mb';
  app.use(express.json({ limit: defaultBodyLimit }));

  app.set('prisma', prisma);

  // ─── Health & readiness ───────────────────────────────────────────────────
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
  //
  // DR-014 (round-20): extended with expected-SHA verification. The deploy
  // workflow writes DEPLOY_SHA (the commit it pushed) and EXPECTED_SHA
  // (the commit the workflow was triggered for, i.e. github.event.head_sha).
  // When both are present and DIFFERENT, `matches: false` is returned —
  // indicating the running release is not what the workflow intended to ship.
  // This is the "release identity" half of the production-contract suite:
  // ops dashboards alert on `matches === false` rather than guessing.
  app.get('/version', (req, res) => {
    const expected = process.env.INTERNAL_API_TOKEN;
    if (!expected) {
      return res.status(404).json({ error: 'Not found' });
    }
    if (req.headers['x-internal-token'] !== expected) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const deploySha = process.env.DEPLOY_SHA || 'unknown';
    const expectedSha = process.env.EXPECTED_SHA || null;
    // Both set and equal → ok. Both set and different → mismatch. Either
    // missing → null (workflow didn't wire the env, can't determine).
    let matches = null;
    if (expectedSha && deploySha !== 'unknown') {
      matches = deploySha === expectedSha;
    }
    res.json({
      status: 'ok',
      deploySha,
      expectedSha,
      matches,
      deployTime: process.env.DEPLOY_TIME || 'unknown',
      nodeEnv: process.env.NODE_ENV,
    });
  });

  // [PHASE-4 DIAGNOSIS ONLY — DELETE AFTER USE]
  // Temporary endpoint to inspect what tables/columns actually exist on the
  // live Supabase DB so we can confirm the S3-6 migration's
  // `ALTER TABLE training_enrollments` (plural) didn't apply to the table
  // Prisma is actually querying (singular, per `@@map` in schema.prisma).
  // Guarded by INTERNAL_API_TOKEN so it can't leak prod schema publicly.
  app.get('/diag/schema', async (req, res) => {
    const expected = process.env.INTERNAL_API_TOKEN;
    if (!expected || req.headers['x-internal-token'] !== expected) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    try {
      const tables = await prisma.$queryRaw`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_name LIKE 'training%'
        ORDER BY table_name`;
      const cols = await prisma.$queryRaw`
        SELECT table_name, column_name, data_type
        FROM information_schema.columns
        WHERE table_schema='public' AND table_name LIKE 'training%'
        ORDER BY table_name, ordinal_position`;
      const mig = await prisma.$queryRaw`
        SELECT migration_name, applied_steps_count,
               finished_at IS NOT NULL as applied
        FROM _prisma_migrations ORDER BY started_at`;
      res.json({ tables, columns: cols, migrations: mig });
    } catch (err) {
      res.status(500).json({ error: err.message, code: err.code, meta: err.meta });
    }
  });

  app.get('/ready', async (req, res) => {
    // DR-017: every required R2 bucket must be reachable, not just dpr-photos.
    // The previous probe only checked dpr-photos, so /ready reported healthy
    // even when inspection-photos / training-materials were missing — masking
    // the very class of "bucket never provisioned" bugs round-13 fixed for
    // the DPR side. Each probe is a HeadBucket call (no enumeration), so the
    // readiness check stays cheap even with three buckets.
    const checks = { db: 'fail', blob: {} };
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
      const { getClient, REQUIRED_BUCKETS } = blobStorage;
      const { HeadBucketCommand } = require('@aws-sdk/client-s3');
      const client = getClient();
      // Run probes in parallel — three HeadBucket calls finish in well under
      // a second even on a cold R2 path, and serial would just add latency
      // to every Render liveness ping.
      const probeResults = await Promise.all(REQUIRED_BUCKETS.map(async (Bucket) => {
        try {
          await client.send(new HeadBucketCommand({ Bucket }));
          return { Bucket, ok: true };
        } catch (err) {
          // Distinguish missing-bucket (NotFound), auth/perm (Forbidden), and
          // network failures (NetworkingError) so operators can see the cause
          // without the error leaking credentials or bucket names.
          const errName = err?.name || err?.Code || 'unknown';
          return { Bucket, ok: false, error: errName };
        }
      }));
      for (const r of probeResults) {
        checks.blob[r.Bucket] = r.ok ? 'ok' : `fail: ${r.error}`;
        if (!r.ok) ok = false;
      }
    } catch (err) {
      // R2 client itself failed to initialize (missing env, bad endpoint).
      // This is a deploy-level misconfiguration; mark ALL buckets unknown
      // rather than guessing.
      ok = false;
      const errName = err?.name || err?.message || 'unknown';
      for (const Bucket of (blobStorage.REQUIRED_BUCKETS || [])) {
        checks.blob[Bucket] = `fail: client: ${errName}`;
      }
    }

    res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'degraded', checks });
  });

  // ─── Routes ───────────────────────────────────────────────────────────────
  // Auth: rate-limit per-IP BEFORE routing so abusive callers hit the limiter
  // even if their payload would otherwise be parsed/rejected.
  app.use('/api/auth/login', loginLimiter);
  app.use('/api/auth/refresh', refreshLimiter);
  app.use('/api/auth', authRoutes);
  // Round-13: rate-limit the binary export BEFORE requireAuth so the limiter
  // fires even for unauthenticated floods (saves a DB lookup). The handler
  // itself still requires admin, so a banned admin still gets 403.
  app.use('/api/attendance/export', exportLimiter);
  app.use('/api/attendance', attendanceRoutes);
  // Round-13: leave routes. The create-rate-limiter is mounted inside the
  // route file (POST /) so it only throttles submissions — list/get/cancel
  // remain unthrottled. leaveCreateLimiter is imported above and exported.
  app.use('/api/leave', leaveRoutes);
  // Round-14: employee training. Same pattern as leave — write-limiter is
  // mounted inside the route file on POST/PUT only, so the dashboard reads
  // stay cheap. No body-limit override: payloads are tiny (one URL + small
  // metadata), well under the global 1mb default.
  app.use('/api/training', trainingRoutes);
  app.use('/api/dpr/sas-url', sasLimiter);
  // DPR mount uses the global 1mb body limit (DR-007). Photo metadata +
  // workEntries payloads can legitimately approach 1 MB; actual binary
  // uploads go via R2 presigned PUT, not JSON bodies.
  app.use('/api/dpr', dprRoutes);
  // Round-12: Inspection & Compliance Records. Uses the global 1mb body
  // limit — inspection `data` is a structured JSON blob (NCR / cube test /
  // material receipt) and can legitimately approach 1 MB.
  app.use('/api/inspection/sas-url', sasLimiter);
  app.use('/api/inspection', inspectionRoutes);
  app.use('/api/contact', contactLimiter, contactRoutes);
  // DR-017: admin storage health — orphan counts + on-demand sweep trigger.
  // Routes inside use requireAuth + requireFreshAdmin; the mount itself has
  // no extra middleware.
  app.use('/api/admin/storage', storageAdminRoutes);
  // SOL-P1#12: admin employee directory — powers the training bulk-assign
  // picker. Same requireAuth + requireFreshAdmin envelope.
  app.use('/api/admin', adminEmployeesRoutes);
  // Round-25: per-employee notification preferences + admin-only test send.
  app.use('/api/notifications', notificationsRoutes);
  // Round-25 (M2): daily digest cron endpoint. Gated by INTERNAL_API_TOKEN
  // (404 when unset, 403 when the header doesn't match) — same envelope as
  // the /version probe. Render Cron Job hits this at 02:30 UTC = 08:00 IST.
  const internalDigestRoutes = require('./routes/internal-digest');
  app.use('/api/internal/digest', internalDigestRoutes);
  // Round-26: admin-targeted training-overdue sweep. Same INTERNAL_API_TOKEN
  // gate. Render Cron Job hits this at 00:30 UTC = 06:00 IST.
  const internalTrainingOverdueRoutes = require('./routes/internal-training-overdue');
  app.use('/api/internal/training/overdue', internalTrainingOverdueRoutes);
  // Round-26: admin-targeted daily attendance digest. Same gate. Render
  // Cron Job hits this at 13:30 UTC = 19:00 IST.
  const internalAdminAttendanceRoutes = require('./routes/internal-admin-attendance');
  app.use('/api/internal/attendance/digest', internalAdminAttendanceRoutes);
  // Round-26.5: cold-start warm-up ping. Render Cron Job hits this every
  // 10 minutes (UTC) to keep the free-tier service above the 15-min idle
  // spin-down threshold. See backend/src/routes/internal-warmup.js for
  // the cost math + design rationale.
  const internalWarmupRoutes = require('./routes/internal-warmup');
  app.use('/api/internal/warmup', internalWarmupRoutes);
  // [S3-7] Durable upload-intent sweep. Same INTERNAL_API_TOKEN gate.
  // GH Actions cron (cron-upload-sweep.yml) hits this every 15 minutes.
  // This is the cron LPR-012's migration promised but never shipped —
  // until now, orphaned upload blobs were reclaimed only by an in-process
  // setTimeout that does not survive a restart. See
  // backend/src/routes/internal-upload-sweep.js for the three passes.
  const internalUploadSweepRoutes = require('./routes/internal-upload-sweep');
  app.use('/api/internal/upload', internalUploadSweepRoutes);

  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use((err, req, res, next) => {
    // DR-012: reuse the server-owned id minted by the request-id middleware so
    // the value logged here is the same one the client already received in the
    // `X-Request-Id` response header. The `??` fallback only fires if this
    // handler is somehow reached before that middleware ran.
    const requestId = req.id ?? randomUUID();
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
    } else if (err && err.type === 'entity.too.large' && err.status === 413) {
      // DR-014 (round-20): body-parser payload too large → 413 instead of 500.
      // The previous catch-all surfaced a 2 MB POST as 500, which looked like
      // a server bug rather than a "client overshot the 1 MB limit" message.
      // This was previously untested because the bodyParser.test.js test
      // mocks the error handler on a throwaway app; the mounted-app integration
      // suite (DR-014) is what surfaced it. The contract is: oversized
      // bodies are a CLIENT error, not a server error.
      status = 413;
      body = { error: 'Payload too large', code: 'PAYLOAD_TOO_LARGE', requestId };
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

  return { app, prisma, blobStorage };
}

// ─── Boot ──────────────────────────────────────────────────────────────────
// Everything below runs ONLY when this file is the process entrypoint
// (`node src/index.js`, which is what `npm start` and the Render start command
// do). Guarding it lets a test `require('../src/index')` and call `createApp`
// to assert against the real, fully-mounted app — the actual route table,
// not a hand-copied mirror of it — without opening a port, probing the DB,
// or hijacking the process's signal and exception handlers.
function startServer({ app, prisma }) {
  const PORT = (process.env.PORT && process.env.PORT !== '') ? process.env.PORT : 8080;
  const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean)
    : (process.env.FRONTEND_URL ? [process.env.FRONTEND_URL] : [])
  );

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

  // Single-tenant assumption (see TENANCY.md). If this counts more than
  // the documented ACS workforce, treat as a tenancy boundary violation
  // and refactor before adding the second org.
  prisma.employee.count()
    .then((count) => {
      console.log(`[tenancy] employees in DB: ${count} (single-tenant ACS; see TENANCY.md)`);
      // Soft guardrail: if the workforce size balloons past what one
      // construction-services org realistically employs, log a warning
      // so the operator notices before adding a second org without a
      // tenancy refactor. Threshold is deliberately loose so an
      // admin-onboarded contractor doesn't trip it; tighten when
      // multi-tenant onboarding is real.
      if (count > 1000) {
        console.warn(`[tenancy] WARNING: ${count} employees exceeds the single-tenant workforce expectation. ` +
          `Before adding a second organization, complete the pre-onboarding checklist in TENANCY.md.`);
      }
    })
    .catch((err) => {
      // Non-fatal: a missing table or unreadable DB shouldn't block boot
      // (the /ready endpoint will report DB=fail and Render will mark the
      // service unhealthy). Log and move on.
      console.error('[tenancy] employee count probe failed (non-fatal):', err?.message?.split('\n')[0] || err);
    });

  const server = app.listen(PORT, () => {
    console.log(`ACS Portal API listening on port ${PORT}`);
    console.log(`Allowed origins: ${ALLOWED_ORIGINS.join(', ') || '(none)'}`);
  });

  // R2 bucket CORS provisioning (round-13 → round-20 DR-017).
  //
  // Round-13: a one-shot CORS applier ran on every boot. Without it, the
  // browser preflight to the presigned PUT URL returned 403 with no
  // Access-Control-Allow-* headers and the browser aborted the upload
  // with "Network error during upload" before any bytes left.
  //
  // Round-20 (DR-017): canonical provisioning moved to
  // `scripts/provisionR2.js` (run once at deploy time as a preDeploy hook).
  // This boot-time call is now a NO-OP in production unless the env flag
  // `R2_CORS_SELF_HEAL=true` is set (dev convenience). The runtime IAM
  // key no longer needs `s3:PutBucketCors` / `s3:CreateBucket` — only the
  // much narrower `s3:PutObject` / `s3:GetObject` / `s3:DeleteObject` on
  // the bucket paths. See `scripts/README.md` for the deploy flow.
  const { applyR2Cors } = require('./lib/blobStorage');
  const r2SelfHeal = process.env.R2_CORS_SELF_HEAL === 'true';
  if (r2SelfHeal) {
    applyR2Cors(ALLOWED_ORIGINS).then((results) => {
      const failed = results.filter((r) => !r.ok && !r.skipped);
      if (failed.length === 0) {
        console.log(`[r2-cors] self-heal applied CORS policy to ${results.length} bucket(s): ${results.map((r) => r.Bucket).join(', ')}`);
      } else {
        console.error('[r2-cors] self-heal: some buckets failed:', JSON.stringify(failed));
      }
    }).catch((err) => {
      console.error('[r2-cors] self-heal apply failed (non-fatal):', err?.$metadata?.httpStatusCode || err?.message || err);
    });
  } else {
    // Confirm at boot so an operator who inspects Render logs can see
    // that the API deliberately skipped CORS provisioning. Canonical
    // provisioning is now a preDeploy script (see scripts/README.md).
    console.log('[r2-cors] boot-time provisioning disabled (default). Canonical provisioning via scripts/provisionR2.js. Set R2_CORS_SELF_HEAL=true to re-enable for dev.');
  }

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

  return server;
}

if (require.main === module) {
  // Production boot: real Prisma + real blobStorage, listen on PORT.
  const { app, prisma } = createApp();
  startServer({ app, prisma });
}

// DR-014 (round-20): backward-compat default export.
//
// The previous (pre-DR-014) index.js did `module.exports = app`, so tests
// like __tests__/diag.removed.test.js + __tests__/storage.test.js do
// `const app = require('../src/index');` and pass `app` straight into
// supertest. The factory refactor changed the export to
// `{ createApp, startServer }`, which broke those tests with
// "TypeError: app.address is not a function".
//
// To preserve BOTH contracts:
//   - `require('../src/index')` → the default app (Express), as before
//   - `require('../src/index').createApp` → the factory for production use
//     and the new mounted-app integration suite
//   - `require('../src/index').startServer` → the production entry point
//
// We materialize the default app once at module load (with mocked
// PrismaClient from jest.mock or real PrismaClient otherwise — the
// tests that depend on the default export all mock @prisma/client at
// the top of their file, so the real client is never instantiated).
//
// `module.exports = createApp();` returns the Express app; we then
// attach the factory + startServer as properties. Note: this is a
// function-shaped value (an Express app is a callable), but Express
// apps are also objects with properties — so adding `.createApp` and
// `.startServer` keeps `app.use(...)` and `request(app).get(...)`
// working while exposing the factory to the new tests.
const { app: defaultApp } = createApp();
defaultApp.createApp = createApp;
defaultApp.startServer = startServer;
module.exports = defaultApp;
