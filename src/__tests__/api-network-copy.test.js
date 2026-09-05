// SOL S5 — user-facing network/timeout copy.
//
// The audit flagged that api.js used developer-oriented copy on the
// two failures users actually see most often:
//
//   - "Network error — is the server running?"  (fetch threw TypeError)
//   - "Request timed out — please try again."   (AbortController fired)
//   - "Download timed out — please try again."  (download fetch)
//
// These reach the toast/snackbar layer as `err.message`, so the user
// reads them directly. The previous copy told them the developer's
// mental model, not theirs.
//
// This test pins:
//   - the new user-facing strings
//   - the unchanged internal codes ('NETWORK_ERROR', 'TIMEOUT') that
//     downstream retry branches (e.g. cold-start self-heal at
//     api.js:request()) key on
//   - both the regular request path and the download path
//
// Like the other api.js tests in this repo, we re-require the module
// after resetting it so module-level singletons don't leak between
// tests. env.js is mocked to dodge the import.meta shim.

import { jest } from '@jest/globals';

jest.mock('../lib/env.js', () => ({
  __esModule: true,
  VITE_API_URL: 'http://test.local',
  default: 'http://test.local',
}));

function loadApiFresh() {
  jest.resetModules();
  return require('../lib/api.js').api;
}

describe('SOL S5 — network/timeout copy is user-facing, codes preserved', () => {
  let originalFetch;
  let api;

  beforeEach(() => {
    originalFetch = global.fetch;
    api = loadApiFresh();
    localStorage.clear();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  // ── Network error path ────────────────────────────────────────────────────
  // A fetch that rejects with a TypeError is what the browser surfaces
  // when the socket dies (DNS fail, TLS fail, TCP reset, Render cold
  // start). fetchWithTimeout converts that into the NETWORK_ERROR
  // ApiError we throw into the call chain.
  test('N1. fetch TypeError → user-facing network copy + NETWORK_ERROR code', async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(api.get('/whoami')).rejects.toMatchObject({
      status: 0,
      code: 'NETWORK_ERROR',
      message: "Couldn't reach the server. Check your internet connection and try again.",
    });
  });

  test('N2. fetch TypeError copy does NOT contain the old developer-oriented phrase', async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    const err = await api.get('/whoami').catch((e) => e);
    expect(err.message).not.toMatch(/is the server running/i);
    expect(err.message).not.toMatch(/developer|dev-server|dev server/i);
  });

  test('N3. fetch TypeError on download path uses the same copy + code', async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    const err = await api.download('/export').catch((e) => e);
    expect(err).toMatchObject({
      status: 0,
      code: 'NETWORK_ERROR',
      message: "Couldn't reach the server. Check your internet connection and try again.",
    });
  });

  // ── Timeout path ─────────────────────────────────────────────────────────
  // fetchWithTimeout converts AbortError (from setTimeout-controlled
  // AbortController.abort()) into the TIMEOUT ApiError. To pin the copy
  // without waiting 30s for the real abort timer, we hand fetch an already-
  // rejected AbortError promise — fetchWithTimeout only checks err.name,
  // not the cause.
  function abortedPromise() {
    const err = new Error('Aborted');
    err.name = 'AbortError';
    return Promise.reject(err);
  }

  test('T1. AbortError → user-facing timeout copy + TIMEOUT code (request)', async () => {
    global.fetch = jest.fn().mockImplementation(() => abortedPromise());

    const err = await api.get('/whoami').catch((e) => e);
    expect(err).toMatchObject({
      status: 0,
      code: 'TIMEOUT',
      message: 'The request took too long. Please try again.',
    });
  });

  test('T2. request timeout copy does NOT use the developer "fetch" framing', async () => {
    global.fetch = jest.fn().mockImplementation(() => abortedPromise());

    const err = await api.get('/whoami').catch((e) => e);
    expect(err.message).not.toMatch(/Network error/i);
    expect(err.message.toLowerCase()).toContain('try again');
  });

  // ── Retry branch contract ────────────────────────────────────────────────
  // The cold-start self-heal at api.js:request() keys on
  // err.code === 'NETWORK_ERROR'. If we ever rename the code or
  // refactor it away, that retry silently stops firing. Pin the
  // code stays as a constant.
  test('R1. NETWORK_ERROR code stays a stable string for the cold-start retry', async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    // First attempt fails, second attempt (mutating verb) should retry.
    // We assert that the second call lands by counting fetch calls.
    let calls = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      calls += 1;
      if (calls === 1) return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({}),
      });
    });

    const out = await api.post('/dpr', { hello: 'world' });
    expect(out).toEqual({});
    expect(calls).toBe(2); // initial + ONE retry
  });
});
