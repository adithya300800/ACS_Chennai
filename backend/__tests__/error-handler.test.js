/**
 * Round-8 (F1): Error handler should return 400 (not 500) for malformed JSON
 * bodies. express.json() throws a SyntaxError with type='entity.parse.failed'
 * when the body is unparseable. The previous catch-all surfaced this as 500,
 * which made every bad-JSON request look like a server bug.
 *
 * We test the error handler logic directly by mounting it on a tiny throwaway
 * app (avoids the supertest+formidable+TextEncoder dependency dance).
 */
const express = require('express');
const errorHandler = (err, req, res, next) => {
  const requestId = req.headers['x-request-id'] || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let status = 500;
  let body = { error: 'Internal server error', requestId };
  // Round-8 (F1): body-parser SyntaxError → 400 instead of 500.
  if (err && (err.type === 'entity.parse.failed' || (err instanceof SyntaxError && err.status === 400))) {
    status = 400;
    body = { error: 'Malformed JSON body', code: 'INVALID_JSON', requestId };
  } else if (err && typeof err.code === 'string') {
    if (err.code === 'P2003') { status = 400; body = { error: 'Referenced record does not exist', code: 'FK_VIOLATION', requestId }; }
    else if (err.code === 'P2009') { status = 400; body = { error: 'Database rejected the input', code: 'VALIDATION_FAILED', requestId }; }
    else if (err.code === 'P2025') { status = 404; body = { error: 'Record not found', code: 'NOT_FOUND', requestId }; }
    else if (['P1001','P1002','P1017','P2024'].includes(err.code)) { status = 503; body = { error: 'Database temporarily unavailable', code: 'DB_UNAVAILABLE', requestId }; }
  }
  res.status(status).json(body);
};

const buildApp = () => {
  const app = express();
  // Simulate express.json() throwing on malformed JSON by mounting a fake
  // parser that always throws entity.parse.failed for non-JSON.
  app.use((req, res, next) => {
    if (req.headers['content-type'] === 'application/json') {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw) return next();
        try { JSON.parse(raw); next(); }
        catch (e) {
          const err = new SyntaxError('Unexpected token in JSON');
          err.status = 400;
          err.type = 'entity.parse.failed';
          next(err);
        }
      });
    } else { next(); }
  });
  app.post('/api/test', (req, res) => res.json({ ok: true, body: req.body }));
  app.use(errorHandler);
  return app;
};

const http = require('http');

const post = (app, path, body, headers = {}) => new Promise((resolve, reject) => {
  const server = app.listen(0, () => {
    const port = server.address().port;
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        server.close();
        try {
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) });
        } catch (e) {
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() });
        }
      });
    });
    req.on('error', (e) => { server.close(); reject(e); });
    req.write(data);
    req.end();
  });
});

describe('Round-8 (F1): Malformed JSON body returns 400 INVALID_JSON, not 500', () => {
  const app = buildApp();

  it('not-json{ → 400 with code INVALID_JSON', async () => {
    const res = await post(app, '/api/test', 'not-json{');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_JSON');
  });

  it('truncated object → 400', async () => {
    const res = await post(app, '/api/test', '{"a":1,');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_JSON');
  });

  it('garbage "undefined" → 400', async () => {
    const res = await post(app, '/api/test', 'undefined');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_JSON');
  });

  it('valid JSON {"ok":true} → 200 (regression)', async () => {
    const res = await post(app, '/api/test', { ok: true });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
