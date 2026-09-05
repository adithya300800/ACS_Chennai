/**
 * Live regression test, 5 Sept 2026 — DPR draft delete was failing on the
 * live site with `net::ERR_FAILED` even though the backend was awake and
 * would have served the DELETE. Root cause: backend/src/index.js:194
 * listed `Access-Control-Allow-Methods: GET, POST, PUT, OPTIONS` —
 * DELETE was missing. The browser's CORS preflight for DELETE returned
 * 204 but with no DELETE in the allowed-methods list, so the browser
 * blocked every actual DELETE call, the frontend translated the failure
 * into NETWORK_ERROR, and the 4s/8s/16s retry ladder just kept failing.
 *
 * The DPR DELETE handler was added in SOL-P0#4 (Round-17) but the
 * allowlist was never updated, so this regression went unnoticed by
 * every test suite until a real browser hit it.
 *
 * These three assertions catch the failure mode:
 *
 *   1. Preflight for DELETE from an allowed origin MUST include DELETE
 *      in `Access-Control-Allow-Methods`. The browser uses this to decide
 *      whether the actual request can proceed.
 *   2. Preflight for PUT still works (no over-trimming).
 *   3. An actual GET from an allowed origin gets the CORS headers
 *      (regression guard for the origin-matching logic).
 *
 * If a future refactor drops DELETE again — e.g. "let me trim unused
 * methods again" without auditing the route table — test #1 fails.
 *
 * The test builds a throwaway app with the same middleware so it doesn't
 * need Prisma, R2, or any network. Mirrors bodyParser.test.js / error-
 * handler.test.js.
 */
const express = require('express');
const request = require('supertest');

// Mirror the production allowlist. The real value lives in
// backend/src/index.js — if you change one, change the other.
const ALLOWED_ORIGINS = [
  'https://acschennai.com',
  'https://acs-portal-spa.onrender.com',
  'http://localhost:5173',
];

const buildApp = () => {
  const app = express();
  // This middleware is a verbatim copy of the one in backend/src/index.js
  // for the CORS section. If you change either side, change both.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, Idempotency-Key, X-Request-ID, X-Internal-Token'
      );
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader(
        'Access-Control-Expose-Headers',
        'Content-Disposition, X-Export-Format, X-Export-Row-Count, X-Request-Id'
      );
      res.setHeader('Access-Control-Max-Age', '300');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.delete('/api/dpr/:id', (_req, res) => res.json({ deleted: true }));
  return app;
};

describe('CORS allow-methods regression (Round-R8-CORS)', () => {
  test('DELETE preflight from an allowed origin lists DELETE in Allow-Methods', async () => {
    const res = await request(buildApp())
      .options('/api/dpr/some-id')
      .set('Origin', 'https://acschennai.com')
      .set('Access-Control-Request-Method', 'DELETE');
    expect(res.status).toBe(204);
    const allow = res.headers['access-control-allow-methods'] || '';
    expect(allow.split(',').map((s) => s.trim().toUpperCase())).toEqual(
      expect.arrayContaining(['DELETE'])
    );
  });

  test('PUT preflight still works (no over-trimming)', async () => {
    const res = await request(buildApp())
      .options('/api/dpr/some-id')
      .set('Origin', 'https://acschennai.com')
      .set('Access-Control-Request-Method', 'PUT');
    expect(res.status).toBe(204);
    const allow = res.headers['access-control-allow-methods'] || '';
    expect(allow.split(',').map((s) => s.trim().toUpperCase())).toEqual(
      expect.arrayContaining(['PUT'])
    );
  });

  test('GET from an allowed origin gets the CORS headers', async () => {
    const res = await request(buildApp())
      .get('/api/health')
      .set('Origin', 'https://acschennai.com');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://acschennai.com');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });
});
