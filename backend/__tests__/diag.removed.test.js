/**
 * Round-20 / DR-012: the diagnostic mutation routes are gone, the health
 * probes are not.
 *
 * What was wrong: `backend/src/routes/diag.js` mounted two admin-gated debug
 * routes that survived long past the round-8 incident they were written for.
 *
 *   POST /api/diag/dpr-create — called `prisma.dPR.create` directly with
 *     caller-supplied `workType`, `status`, `version`, `workEntries` and
 *     friends, bypassing every validator the real POST /api/dpr handler runs.
 *     Any still-valid admin token could write nonconforming DPRs straight
 *     into the table. On failure it returned `err.code`, `err.name`,
 *     `err.meta`, three lines of `err.message` and ten frames of `err.stack`.
 *   POST /api/diag/schema — ran `$queryRawUnsafe` against
 *     information_schema and returned the deployed table/column layout.
 *
 * Both are removed and `routes/diag.js` is deleted.
 *
 * Why this suite asserts against the REAL app: the sibling suites
 * (error-handler, bodyParser) build a throwaway app that mirrors the
 * production mount order, which is the right call when the thing under test
 * is a middleware's behaviour. It is the wrong call here — a mirror app would
 * keep passing after someone re-added `app.use('/api/diag', ...)` to
 * index.js, which is the single regression this file exists to catch. So we
 * require `../src/index` and probe the actual route table. `src/index.js`
 * only boots (listen / tenancy probe / signal handlers) when it is the
 * process entrypoint, so requiring it here is side-effect free.
 *
 * The two external dependencies index.js touches at require time are stubbed
 * below so the suite stays hermetic and fast — no Postgres, no R2.
 */

// Deploy metadata for the /version positive control. Read per-request by the
// handler, but set here before the require for clarity.
process.env.INTERNAL_API_TOKEN = 'test-internal-token-dr012';
process.env.DEPLOY_SHA = 'abc1234def5678';
process.env.DEPLOY_TIME = '2026-09-02T00:00:00Z';

// `new PrismaClient()` in index.js — stub it so /ready's `SELECT 1` resolves
// without a live Postgres. index.js is the only module in src/ that requires
// @prisma/client directly; the route modules all read `req.app.get('prisma')`.
jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    $queryRaw: jest.fn().mockResolvedValue([{ ok: 1 }]),
    $queryRawUnsafe: jest.fn().mockResolvedValue([]),
    $disconnect: jest.fn().mockResolvedValue(undefined),
    employee: { count: jest.fn().mockResolvedValue(0) },
  })),
}));

// /ready HeadBuckets every entry in REQUIRED_BUCKETS. Stub the S3 client so
// the probe resolves instead of retrying against a bogus R2 endpoint (which
// is what makes an unmocked /ready test take ~30s). requireActual keeps the
// real REQUIRED_BUCKETS list and the helpers the route modules import.
jest.mock('../src/lib/blobStorage', () => {
  const actual = jest.requireActual('../src/lib/blobStorage');
  return {
    ...actual,
    getClient: jest.fn(() => ({ send: jest.fn().mockResolvedValue({}) })),
    applyR2Cors: jest.fn().mockResolvedValue([]),
  };
});

const fs = require('fs');
const path = require('path');
const request = require('supertest');

const app = require('../src/index');

// Every path that routes/diag.js ever exposed, plus the bare mount and an
// unknown child — a re-mounted router would answer at least one of these.
const REMOVED_DIAG_PATHS = [
  '/api/diag/dpr-create',
  '/api/diag/schema',
  '/api/diag',
  '/api/diag/anything',
];

describe('DR-012 — health/readiness/version positive controls survive', () => {
  it('GET /health → 200', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.timestamp).toEqual(expect.any(String));
  });

  it('GET /health does not leak deploy metadata (that lives on /version)', async () => {
    const res = await request(app).get('/health');
    expect(res.body).not.toHaveProperty('deploySha');
    expect(res.body).not.toHaveProperty('nodeEnv');
  });

  it('GET /ready → 200 when its dependency probes pass', async () => {
    const res = await request(app).get('/ready');
    // 503 is a legitimate answer when a dependency is genuinely down; both
    // shapes must carry a per-check breakdown so an operator can act on it.
    expect([200, 503]).toContain(res.status);
    expect(res.body.checks).toBeDefined();
    expect(res.body.checks.db).toBeDefined();
    expect(res.body.checks.blob).toBeDefined();
    // With both dependencies stubbed healthy, the probe must report ready —
    // this is what distinguishes "endpoint kept working" from "endpoint kept
    // returning 503 for an unrelated reason".
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    expect(res.body.checks.db).toBe('ok');
  });

  it('GET /version → 200 with a commit-ish field, given the internal token', async () => {
    const res = await request(app)
      .get('/version')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.deploySha).toBe('abc1234def5678');
    expect(res.body.deployTime).toBe('2026-09-02T00:00:00Z');
  });

  it('GET /version stays token-gated (403 without the header)', async () => {
    const res = await request(app).get('/version');
    expect(res.status).toBe(403);
    expect(res.body).not.toHaveProperty('deploySha');
  });
});

describe('DR-012 — diagnostic mutation routes are unmounted', () => {
  it.each(REMOVED_DIAG_PATHS)('POST %s → 404', async (p) => {
    const res = await request(app).post(p).send({ projectName: 'x' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  it.each(REMOVED_DIAG_PATHS)('GET %s → 404', async (p) => {
    const res = await request(app).get(p);
    expect(res.status).toBe(404);
  });

  it('POST /api/diag/dpr-create returns the generic 404 body — no Prisma internals', async () => {
    const res = await request(app)
      .post('/api/diag/dpr-create')
      .send({ projectName: 'p', workType: 'NOT_A_REAL_ENUM', status: 'APPROVED', version: 99 });

    expect(res.status).toBe(404);
    // The old handler leaked these on its 500 path. The 404 body must be the
    // flat catch-all, with no error/schema fragments of any kind.
    const raw = JSON.stringify(res.body);
    for (const leak of ['code', 'meta', 'stack', 'prisma', 'dPR.create', 'P2', 'column']) {
      expect(raw.toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });

  it('the diag route module is deleted from disk', () => {
    const diagPath = path.join(__dirname, '..', 'src', 'routes', 'diag.js');
    expect(fs.existsSync(diagPath)).toBe(false);
  });

  it('index.js contains no /api/diag mount', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
    // Comments may mention the removal; an actual mount may not exist.
    expect(source).not.toMatch(/app\.use\(\s*['"`]\/api\/diag/);
    expect(source).not.toMatch(/require\(\s*['"`]\.\/routes\/diag['"`]\s*\)/);
  });
});

describe('DR-012 — every response carries a server-owned X-Request-Id', () => {
  it('sets the header on a 200', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-request-id']).toEqual(expect.any(String));
    expect(res.headers['x-request-id'].length).toBeGreaterThan(0);
  });

  it('sets the header on a 404', async () => {
    const res = await request(app).post('/api/diag/dpr-create').send({});
    expect(res.headers['x-request-id']).toEqual(expect.any(String));
  });

  it('sets the header on the CORS preflight short-circuit', async () => {
    const res = await request(app)
      .options('/api/dpr')
      .set('Origin', 'http://localhost:3000')
      .set('Access-Control-Request-Method', 'POST');
    expect(res.status).toBe(204);
    expect(res.headers['x-request-id']).toEqual(expect.any(String));
  });

  it('generates a distinct id per request when the client sends none', async () => {
    const a = await request(app).get('/health');
    const b = await request(app).get('/health');
    expect(a.headers['x-request-id']).not.toBe(b.headers['x-request-id']);
    // randomUUID shape — guards against falling back to a weak Math.random id.
    expect(a.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('echoes a well-formed inbound id so an edge-started trace survives', async () => {
    const res = await request(app).get('/health').set('X-Request-Id', 'edge-trace-01');
    expect(res.headers['x-request-id']).toBe('edge-trace-01');
  });

  it('replaces a malformed inbound id instead of echoing it', async () => {
    // A CRLF in the value would make res.setHeader throw ERR_INVALID_CHAR and
    // turn a malformed header into a 500; an over-long value would let a
    // caller pad the server log line. Both must be discarded.
    for (const bad of ['bad\r\nX-Injected: 1', 'x'.repeat(200), 'has spaces', '']) {
      const res = await request(app).get('/health').set('X-Request-Id', bad);
      expect(res.status).toBe(200);
      expect(res.headers['x-request-id']).not.toBe(bad);
      expect(res.headers['x-injected']).toBeUndefined();
    }
  });

  it('exposes X-Request-Id to browser JS via CORS', async () => {
    const res = await request(app).get('/health').set('Origin', 'http://localhost:3000');
    expect(res.headers['access-control-expose-headers']).toContain('X-Request-Id');
  });
});
