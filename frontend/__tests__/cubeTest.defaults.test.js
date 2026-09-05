/**
 * Cube-test API helpers — guards the wire contract of the round-29 (N5)
 * cube-test integration.
 *
 * The N5 spec says: "If user provided a DPR, also auto-link the
 * inspection as casting record" — i.e. when the form submits with a
 * DPR id we still expect the casting record to be wired in if the
 * caller picked one. This test guards the wrapper shape (the actual
 * auto-link behaviour lives in the page submit handler, which is
 * covered by the UI integration tests; here we lock the API method
 * signatures so a future refactor doesn't accidentally drop a query
 * param or method).
 */

jest.mock('../../src/lib/env.js', () => ({
  VITE_API_URL: process.env.VITE_API_URL || '',
}), { virtual: true });

function makeOk(body) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  });
}

describe('api.js — cube-test helpers (N5)', () => {
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
    process.env.VITE_API_URL = 'https://api.example.test';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    global.localStorage = originalStorage;
  });

  it('getCubeTests appends a query string for filters', async () => {
    global.fetch = jest.fn(() => makeOk({ tests: [] }));
    const { api } = require('../../src/lib/api.js');
    await api.getCubeTests({ status: 'PENDING', dueBefore: '2026-10-01' });
    const [url] = global.fetch.mock.calls[0];
    expect(url).toContain('/api/cube-tests?');
    expect(url).toContain('status=PENDING');
    expect(url).toContain('dueBefore=2026-10-01');
  });

  it('getCubeTests omits the "?" when called with no params', async () => {
    global.fetch = jest.fn(() => makeOk({ tests: [] }));
    const { api } = require('../../src/lib/api.js');
    await api.getCubeTests();
    const [url] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.example.test/api/cube-tests');
  });

  it('createCubeTest posts JSON to /api/cube-tests', async () => {
    global.fetch = jest.fn(() => makeOk({}));
    const { api } = require('../../src/lib/api.js');
    await api.createCubeTest({ pourLocation: 'Column C-3', concreteGrade: 'M25', expectedStrength: 25, castDate: '2026-09-05' });
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.example.test/api/cube-tests');
    expect(opts.method).toBe('POST');
    expect(opts.body).toContain('Column C-3');
    expect(opts.headers['Content-Type']).toBe('application/json');
  });

  it('getCubeTest hits /api/cube-tests/:id', async () => {
    global.fetch = jest.fn(() => makeOk({}));
    const { api } = require('../../src/lib/api.js');
    await api.getCubeTest('abc-123');
    const [url] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.example.test/api/cube-tests/abc-123');
  });

  it('updateCubeTest sends PATCH to /api/cube-tests/:id', async () => {
    global.fetch = jest.fn(() => makeOk({}));
    const { api } = require('../../src/lib/api.js');
    await api.updateCubeTest('abc-123', { sevenDayResult: 18.5 });
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.example.test/api/cube-tests/abc-123');
    expect(opts.method).toBe('PATCH');
    expect(opts.body).toContain('18.5');
  });

  it('getCubeTestsDueSoon uses a default days=7 when no arg is passed', async () => {
    global.fetch = jest.fn(() => makeOk({ tests: [] }));
    const { api } = require('../../src/lib/api.js');
    await api.getCubeTestsDueSoon();
    const [url] = global.fetch.mock.calls[0];
    expect(url).toContain('/api/cube-tests/due-soon?days=7');
  });

  it('getCubeTestsDueSoon honours a custom days value', async () => {
    global.fetch = jest.fn(() => makeOk({ tests: [] }));
    const { api } = require('../../src/lib/api.js');
    await api.getCubeTestsDueSoon(14);
    const [url] = global.fetch.mock.calls[0];
    expect(url).toContain('days=14');
  });

  it('getCubePourSummary hits /api/cube-tests/pour-summary/:dprId', async () => {
    global.fetch = jest.fn(() => makeOk({ counts: { cast: 0, passed: 0, pending: 0, failed: 0, overdue: 0 }, billingStatus: 'IN_PROGRESS', tests: [] }));
    const { api } = require('../../src/lib/api.js');
    await api.getCubePourSummary('dpr-uuid');
    const [url] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.example.test/api/cube-tests/pour-summary/dpr-uuid');
  });
});
