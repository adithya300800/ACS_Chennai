/**
 * api.js Idempotency-Key Forwarding — DR-012
 *
 * Guards against the regression where a NETWORK_ERROR retry from
 * api.js request() re-sent a POST with NO Idempotency-Key header, so
 * the backend couldn't dedupe the replay and would create a duplicate
 * row + duplicate admin notification email.
 *
 * Contract under test:
 *   - api.post(path, body, token, idempotencyKey) sends
 *     `Idempotency-Key: <key>` on the FIRST attempt.
 *   - A NETWORK_ERROR retry of the same call sends the SAME
 *     Idempotency-Key header (the retry preserves the key, since the
 *     same args flow back into request()).
 *   - api.createInspection(data, token, key) and api.createDpr(data,
 *     token, key) forward the key through to api.post().
 *   - Omitting idempotencyKey sends NO Idempotency-Key header (the
 *     gate is opt-in — existing callers that don't pass a key are
 *     unchanged).
 *
 * The backend test (dr012-inspection-idempotency.test.js) pins the
 * server-side dedupe; this file pins the wire-level contract that the
 * client and server agree on.
 */

const realFetch = global.fetch;

// Stub src/lib/env.js BEFORE requiring api.js. The real file uses
// `import.meta.env.VITE_API_URL` which throws SyntaxError in Jest's CJS
// environment.
jest.mock('../../src/lib/env.js', () => ({
  VITE_API_URL: process.env.VITE_API_URL || '',
}), { virtual: true });

describe('api.js — Idempotency-Key header forwarding (DR-012)', () => {
  let originalFetch;
  let originalStorage;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalStorage = global.localStorage;
    global.localStorage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
    };
    process.env.VITE_API_URL = 'https://api.example.test';
    jest.resetModules();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    global.localStorage = originalStorage;
    jest.useRealTimers();
  });

  it('sends Idempotency-Key header when api.post is called with a key', async () => {
    const fetchMock = jest.fn(() =>
      Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ id: 'insp-1' }) })
    );
    global.fetch = fetchMock;
    const { api } = require('../../src/lib/api.js');

    await api.post('/inspection', { projectName: 'A' }, 'tok', 'key-abc');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers['Idempotency-Key']).toBe('key-abc');
    // Other headers must still be present (regression pin).
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(opts.headers.Authorization).toBe('Bearer tok');
  });

  it('omits Idempotency-Key header when no key is provided (opt-in)', async () => {
    const fetchMock = jest.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
    );
    global.fetch = fetchMock;
    const { api } = require('../../src/lib/api.js');

    await api.post('/inspection', { projectName: 'A' }, 'tok');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers['Idempotency-Key']).toBeUndefined();
    // Sanity: the other headers still made it.
    expect(opts.headers['Content-Type']).toBe('application/json');
  });

  it('preserves Idempotency-Key across a NETWORK_ERROR retry', async () => {
    // First call rejects with NETWORK_ERROR; second succeeds. The key
    // MUST appear on BOTH calls so the backend's idempotency cache
    // can dedupe them to one logical intent.
    let callCount = 0;
    global.fetch = jest.fn(() => {
      callCount += 1;
      if (callCount === 1) return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ id: 'insp-retry' }) });
    });
    const { api } = require('../../src/lib/api.js');

    const result = await api.post('/inspection', { projectName: 'A' }, 'tok', 'key-retry');
    expect(result).toEqual({ id: 'insp-retry' });
    expect(callCount).toBe(2);

    const firstHeaders = global.fetch.mock.calls[0][1].headers;
    const secondHeaders = global.fetch.mock.calls[1][1].headers;
    expect(firstHeaders['Idempotency-Key']).toBe('key-retry');
    expect(secondHeaders['Idempotency-Key']).toBe('key-retry');
  });

  it('api.createInspection forwards the idempotencyKey through api.post', async () => {
    const fetchMock = jest.fn(() =>
      Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ id: 'insp-2' }) })
    );
    global.fetch = fetchMock;
    const { api } = require('../../src/lib/api.js');

    await api.createInspection({ projectName: 'B' }, 'tok', 'insp-key-xyz');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/inspection');
    expect(opts.headers['Idempotency-Key']).toBe('insp-key-xyz');
  });

  it('api.createDpr forwards the idempotencyKey through api.post', async () => {
    const fetchMock = jest.fn(() =>
      Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ id: 'dpr-1' }) })
    );
    global.fetch = fetchMock;
    const { api } = require('../../src/lib/api.js');

    await api.createDpr({ projectName: 'C' }, 'tok', 'dpr-key-xyz');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/dpr');
    expect(opts.headers['Idempotency-Key']).toBe('dpr-key-xyz');
  });

  it('api.put forwards the idempotencyKey (future-proofing)', async () => {
    const fetchMock = jest.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
    );
    global.fetch = fetchMock;
    const { api } = require('../../src/lib/api.js');

    await api.put('/inspection/123', { foo: 'bar' }, 'tok', 'put-key');

    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers['Idempotency-Key']).toBe('put-key');
  });

  it('api.delete forwards the idempotencyKey (future-proofing)', async () => {
    const fetchMock = jest.fn(() =>
      Promise.resolve({ ok: true, status: 204, json: () => Promise.resolve({}) })
    );
    global.fetch = fetchMock;
    const { api } = require('../../src/lib/api.js');

    await api.delete('/dpr/draft-1', 'tok', 'del-key');

    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers['Idempotency-Key']).toBe('del-key');
  });
});
