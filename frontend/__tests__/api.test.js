/**
 * api.js Timeout Tests
 *
 * Guards against the regression that caused the Aug 29 2026
 * "stuck forever" bugs on DPR submit, attendance check-in, and
 * photo upload. The contract under test: every fetch() inside api.js
 * is wrapped with an AbortController timeout so a hung server cannot
 * pin a UI button in the "submitting" state indefinitely.
 *
 * We don't test the SDK call shape — we test the timeout enforcement,
 * the ApiError code that gets surfaced, and the cancellation behavior.
 */

const realFetch = global.fetch;
const realLocation = global.location;

// Stub src/lib/env.js BEFORE requiring api.js. The real file uses
// `import.meta.env.VITE_API_URL` which throws SyntaxError in Jest's CJS
// environment. The stub reads from process.env instead — which is what
// the test files set above each test.
//
// We use `virtual: true` because the module IS in src/ but babel-jest
// can't even parse it (the SyntaxError comes from babel-jest's parse
// step, before module resolution). virtual:true short-circuits the
// resolution.
jest.mock('../../src/lib/env.js', () => ({
  VITE_API_URL: process.env.VITE_API_URL || '',
}), { virtual: true });

function setEnv(url) {
  process.env.VITE_API_URL = url;
  // Vite reads this at import time, so we need jest.resetModules + require
}

describe('api.js — fetch timeout enforcement', () => {
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
    jest.resetModules();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    global.localStorage = originalStorage;
    jest.useRealTimers();
    if (realFetch) global.fetch = realFetch;
    if (realLocation) global.location = realLocation;
  });

  it('throws ApiError with code TIMEOUT when fetch never resolves', async () => {
    process.env.VITE_API_URL = 'https://api.example.test';
    // A fetch that never resolves, but DOES observe the AbortSignal —
    // this is how real fetch() behaves. (A `new Promise(() => {})`
    // ignores the signal, which would never let the abort fire.)
    global.fetch = jest.fn((url, opts = {}) => new Promise((resolve, reject) => {
      opts.signal?.addEventListener('abort', () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      });
    }));

    jest.useFakeTimers({ legacyFakeTimers: false });
    const { api, ApiError } = require('../../src/lib/api.js');

    const pending = api.get('/dpr');

    // Advance time past the 30s default timeout. Real fetch implementations
    // listen for the AbortSignal — our mock does too — so the abort fires
    // the rejection.
    await Promise.resolve(); // flush microtasks so fetch is called
    jest.advanceTimersByTime(31_000);
    // Let microtasks drain so the AbortError is caught and wrapped.
    await Promise.resolve();
    await Promise.resolve();

    await expect(pending).rejects.toBeInstanceOf(ApiError);
    await expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('throws ApiError with code NETWORK_ERROR when fetch itself rejects', async () => {
    process.env.VITE_API_URL = 'https://api.example.test';
    // A fetch that rejects immediately (DNS failure, offline, etc.)
    global.fetch = jest.fn(() => Promise.reject(new TypeError('Failed to fetch')));

    const { api, ApiError } = require('../../src/lib/api.js');
    const result = api.get('/dpr');
    await expect(result).rejects.toBeInstanceOf(ApiError);
    await expect(result).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('returns the parsed response body on success', async () => {
    process.env.VITE_API_URL = 'https://api.example.test';
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ hello: 'world' }),
      })
    );
    const { api } = require('../../src/lib/api.js');
    const data = await api.get('/dpr');
    expect(data).toEqual({ hello: 'world' });
  });

  it('throws ApiError with the server-supplied message on non-2xx', async () => {
    process.env.VITE_API_URL = 'https://api.example.test';
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: 'Bad date format', code: 'BAD_DATE' }),
      })
    );
    const { api, ApiError } = require('../../src/lib/api.js');
    const result = api.post('/dpr', { reportDate: 'oops' });
    await expect(result).rejects.toBeInstanceOf(ApiError);
    await expect(result).rejects.toMatchObject({
      status: 400,
      code: 'BAD_DATE',
      message: 'Bad date format',
    });
  });

  it('passes the request body as JSON when method is POST', async () => {
    process.env.VITE_API_URL = 'https://api.example.test';
    const fetchMock = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      })
    );
    global.fetch = fetchMock;
    const { api } = require('../../src/lib/api.js');
    await api.post('/attendance/check-in', { lat: 1, lng: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/attendance/check-in');
    expect(opts.method).toBe('POST');
    expect(opts.body).toBe(JSON.stringify({ lat: 1, lng: 2 }));
  });

  it('sends Authorization header when a token is provided', async () => {
    process.env.VITE_API_URL = 'https://api.example.test';
    const fetchMock = jest.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
    );
    global.fetch = fetchMock;
    const { api } = require('../../src/lib/api.js');
    await api.get('/dpr', 'jwt-abc-123');
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers.Authorization).toBe('Bearer jwt-abc-123');
  });
});
