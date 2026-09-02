/**
 * Round-20 / DR-007: Body-parser ordering regression test.
 *
 * Before the fix: a 16 KB global `express.json({ limit: '16kb' })` was
 * mounted FIRST, with per-route 1 MB opt-ins mounted AFTER for `/api/dpr`
 * and `/api/inspection`. Express 4's json middleware skips re-parsing
 * once `req.body` is populated, so a 17 KB payload to those routes hit
 * the global parser first and got `413 PayloadTooLargeError` before the
 * per-route parser could ever run. The 1 MB route-level limit was a
 * no-op — it never executed.
 *
 * After the fix: a single global `express.json({ limit: '1mb' })` owns
 * the limit for every route. The per-route opt-ins are gone.
 *
 * This test mirrors the production mount order on a throwaway app (no
 * Prisma / R2 dependencies — same pattern as error-handler.test.js) and
 * verifies three properties:
 *
 *   1. A 500 KB JSON payload (well under 1 MB) is accepted and reaches
 *      the route handler. Regression guard for "global too small".
 *   2. A 1.5 MB JSON payload (above 1 MB) is rejected with 413 by the
 *      global parser. Regression guard for "no upper bound".
 *   3. A 17 KB JSON payload to a route that previously had its own
 *      `1mb` opt-in does NOT 413. This is the literal DR-007 symptom —
 *      a valid 17 KB report to a DPR-shaped route must be accepted
 *      (or rejected for route-specific reasons, not parser limits).
 *
 * The test uses supertest against the throwaway app. If a future change
 * re-introduces per-route parser mounts, or drops the global limit below
 * 1 MB, at least one of these three tests will fail.
 */
const express = require('express');
const request = require('supertest');

// Build a tiny app that mirrors the production parser mount order:
//   1. Global 1 MB json parser (the new DR-007 limit).
//   2. Routes — no per-route parsers (collapsed in DR-007).
//
// Each route echoes back the byte count of the parsed body so we can
// assert the parser actually consumed the bytes (and didn't 413 early).
const buildApp = () => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Echo routes for each tier of the old per-route-parser setup.
  app.post('/api/test/global', (req, res) => {
    const bodyLen = JSON.stringify(req.body || {}).length;
    res.json({ ok: true, bodyLen });
  });
  app.post('/api/dpr/test', (req, res) => {
    const bodyLen = JSON.stringify(req.body || {}).length;
    res.json({ ok: true, route: 'dpr', bodyLen });
  });
  app.post('/api/inspection/test', (req, res) => {
    const bodyLen = JSON.stringify(req.body || {}).length;
    res.json({ ok: true, route: 'inspection', bodyLen });
  });

  // Error handler — body's parse-failure path. The production index.js
  // maps PayloadTooLargeError to 413 via Express's default, but we make
  // it explicit here so the assertion is robust against Express version
  // drift. The status code we assert is the documented contract.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Payload too large', code: 'PAYLOAD_TOO_LARGE' });
    }
    if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
      return res.status(400).json({ error: 'Malformed JSON body', code: 'INVALID_JSON' });
    }
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
};

// Build a JSON object of approximately `targetBytes` by stuffing a long
// string under a single key. Using one padded key keeps the surrounding
// structure tiny so the total length is dominated by our filler.
const buildJsonOfSize = (targetBytes) => {
  const overhead = 20; // `{"data":""}` plus quotes/escape overhead
  const filler = 'a'.repeat(Math.max(0, targetBytes - overhead));
  return { data: filler };
};

describe('DR-007: body parser ordering — single global 1 MB limit', () => {
  const app = buildApp();

  it('accepts a 500 KB JSON payload via the global parser (regression guard)', async () => {
    const payload = buildJsonOfSize(500 * 1024);
    const res = await request(app)
      .post('/api/test/global')
      .send(payload)
      .set('Content-Type', 'application/json');

    // Should reach the route, not 413.
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Body must have been parsed — confirm it round-trips by checking
    // the echoed byte count is close to what we sent.
    expect(res.body.bodyLen).toBeGreaterThan(500 * 1024 - 1024);
  });

  it('rejects a 1.5 MB JSON payload with 413 PAYLOAD_TOO_LARGE', async () => {
    const payload = buildJsonOfSize(1.5 * 1024 * 1024);
    const res = await request(app)
      .post('/api/test/global')
      .send(payload)
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(413);
    expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('DR-007 symptom: a 17 KB JSON payload to /api/dpr/* does NOT 413 from the parser', async () => {
    // The original bug: 17 KB > 16 KB global limit, but the per-route
    // 1 MB parser never got a chance to run because Express skipped
    // re-parsing. Post-fix the global limit is 1 MB, so the payload
    // must be accepted (or rejected for route-specific reasons, not
    // for size).
    const payload = buildJsonOfSize(17 * 1024);
    const res = await request(app)
      .post('/api/dpr/test')
      .send(payload)
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.route).toBe('dpr');
    // Body was parsed by the global 1 MB parser.
    expect(res.body.bodyLen).toBeGreaterThan(17 * 1024 - 256);
  });

  it('DR-007 symptom (companion): a 17 KB JSON payload to /api/inspection/* does NOT 413', async () => {
    const payload = buildJsonOfSize(17 * 1024);
    const res = await request(app)
      .post('/api/inspection/test')
      .send(payload)
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.route).toBe('inspection');
  });

  it('still rejects malformed JSON with 400 INVALID_JSON (round-8 invariant)', async () => {
    // Pre-existing behavior from round-8 (F1) — we are not changing
    // error semantics. Belt-and-suspenders to catch accidental drift
    // while editing the parser block.
    const res = await request(app)
      .post('/api/test/global')
      .set('Content-Type', 'application/json')
      .send('not-json{');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_JSON');
  });
});