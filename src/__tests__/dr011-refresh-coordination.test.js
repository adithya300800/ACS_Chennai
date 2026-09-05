// SOL DR-011 — refresh rotation has a single coordinator + publication.
//
// Acceptance criteria from SOL DR-011:
//
//   A. `api.refreshToken()` is the ONE coordinator for refresh. Every
//      refresh initiator — timer-fired preemptive (AuthContext), 401-
//      fired reactive inside request()/download(), and any manual
//      caller — serializes on the same single-flight slot. Pre-fix,
//      AuthContext had its OWN refresh implementation that bypassed
//      `refreshingPromise`, so two parallel refreshes (timer + 401)
//      could race on the same rotating refresh token.
//
//   B. `api.bumpRefreshEpoch()` invalidates any in-flight refresh. The
//      session-identity guard inside doRefresh drops a late response
//      whose epoch doesn't match the current epoch at landing time.
//      Pre-fix there was no such guard — a logout-then-login in the
//      same page lifetime could let a stale response overwrite the
//      freshly-installed access token.
//
//   C. api.js dispatches `auth:token-refreshed` AND AuthContext
//      subscribes to it so React state mirrors whichever path ran.
//      Pre-fix, no provider subscribed, so the api.js path's
//      localStorage write was the only publication and React state
//      drifted out of sync for the lifetime of the page.
//
//   D. The CustomEvent detail carries `epoch` so a late listener can
//      drop a stale event without crashing if the bundle already
//      shipped without the epoch-aware dispatcher.
//
// Why static-text tests (E1-E4) for AuthContext wiring instead of a
// mounted component test: the project's existing App.test.jsx (DR-020)
// documents that mounting <App /> exhausts memory in jsdom because
// AuthContext → api.js → env.js drags in the import.meta env shim.
// The same applies to AuthContext alone. The static-text checks pin
// the same wiring contract without the mounting cost.
//
// Note: env.js is imported via a jest moduleNameMapper shim defined
// inline below so the test stays self-contained — no jest.config edit
// required. See `jest.mock('../lib/env.js', ...)` at the top.

import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';

// env.js uses import.meta.env which crashes under CJS jest. Stub it
// before the api.js import resolves. The mock moduleFactory must be
// hoisted before any require that resolves env.js, which means it
// runs before this file's import statements in jest's babel-jest
// transform — but jest.mock calls are explicitly hoisted, so this
// ordering is safe.
jest.mock('../lib/env.js', () => ({
  __esModule: true,
  VITE_API_URL: 'http://test.local',
  default: 'http://test.local',
}));

// We deliberately do NOT `import { api } from '../lib/api.js'` at the
// top of the file: api.js carries module-level state (refreshingPromise,
// refreshEpoch) that would leak between tests. Each test re-requires
// the module after resetting the module registry so the closure is
// fresh. This mirrors the behavior of a fresh page load.
function loadApiFresh() {
  jest.resetModules();
  // babel-jest transforms ESM `export const api` into
  // `exports.api = ...`, so the require returns an object whose
  // `.api` field is the singleton. We unwrap here so the rest of
  // the test reads naturally.
  // eslint-disable-next-line global-require
  return require('../lib/api.js').api;
}

describe('SOL DR-011 — single coordinator for refresh', () => {
  let originalFetch;
  let refreshCalls;
  let api;

  beforeEach(() => {
    refreshCalls = 0;
    originalFetch = global.fetch;
    api = loadApiFresh();
    localStorage.clear();
    localStorage.setItem('acs_refresh', 'old-refresh-token');
    localStorage.setItem('acs_auth', JSON.stringify({ accessToken: 'old-access' }));
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('A1. api.refreshToken() is exposed and is the public entry point', () => {
    expect(typeof api.refreshToken).toBe('function');
    expect(api.refreshToken.length).toBe(0);
  });

  test('A2. parallel api.refreshToken() calls collapse to ONE /auth/refresh fetch', async () => {
    global.fetch = jest.fn().mockImplementation(() => {
      refreshCalls += 1;
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            ok: true,
            status: 200,
            json: async () => ({
              accessToken: 'new-access',
              refreshToken: 'rotated-refresh',
            }),
          });
        }, 30);
      });
    });

    const results = await Promise.all([
      api.refreshToken(),
      api.refreshToken(),
      api.refreshToken(),
      api.refreshToken(),
      api.refreshToken(),
    ]);
    expect(refreshCalls).toBe(1);
    expect(results).toEqual(Array(5).fill('new-access'));
  });

  test('A3. a 401 inside request() routes through the SHARED single-flight slot', async () => {
    refreshCalls = 0;
    let dprCalls = 0;
    global.fetch = jest.fn().mockImplementation((url) => {
      if (url.includes('/auth/refresh')) {
        refreshCalls += 1;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            accessToken: 'fresh-access',
            refreshToken: 'fresh-refresh',
          }),
        });
      }
      if (url.includes('/api/dpr')) {
        dprCalls += 1;
        if (dprCalls === 1) {
          return Promise.resolve({
            ok: false,
            status: 401,
            json: async () => ({ error: 'Token expired', code: 'TOKEN_EXPIRED' }),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ dprs: [] }),
        });
      }
      return Promise.reject(new Error('unexpected URL ' + url));
    });

    const result = await api.get('/dpr', 'old-access');
    expect(result).toEqual({ dprs: [] });
    expect(dprCalls).toBe(2);
    expect(refreshCalls).toBe(1);
  });

  test('A4. concurrent request() 401s share the same refresh (no duplicate POSTs)', async () => {
    let refreshCount = 0;
    let dprAttempts = 0;
    global.fetch = jest.fn().mockImplementation((url, opts = {}) => {
      if (url.includes('/auth/refresh')) {
        refreshCount += 1;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            accessToken: 'new-access',
            refreshToken: 'rotated-refresh',
          }),
        });
      }
      if (url.includes('/api/dpr')) {
        dprAttempts += 1;
        const isRetried = opts?.headers?.Authorization === 'Bearer new-access';
        if (isRetried) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ ok: dprAttempts }),
          });
        }
        return Promise.resolve({
          ok: false,
          status: 401,
          json: async () => ({ error: 'Token expired', code: 'TOKEN_EXPIRED' }),
        });
      }
      return Promise.reject(new Error('unexpected URL ' + url));
    });

    const results = await Promise.all([
      api.get('/dpr', 'old-access'),
      api.get('/dpr', 'old-access'),
      api.get('/dpr', 'old-access'),
      api.get('/dpr', 'old-access'),
    ]);
    expect(refreshCount).toBe(1);
    expect(results).toHaveLength(4);
  });

  test('B1. api.bumpRefreshEpoch() invalidates an in-flight refresh (epoch-mismatch drops the response)', async () => {
    let resolveRefresh;
    global.fetch = jest.fn().mockImplementation(() => {
      return new Promise((resolve) => {
        resolveRefresh = resolve;
      });
    });

    const epochBefore = api.getRefreshEpoch();
    const refreshPromise = api.refreshToken();
    api.bumpRefreshEpoch();
    api.bumpRefreshEpoch();
    const epochAfter = api.getRefreshEpoch();
    expect(epochAfter).toBeGreaterThan(epochBefore);

    resolveRefresh({
      ok: true,
      status: 200,
      json: async () => ({ accessToken: 'stale-token', refreshToken: 'stale-refresh' }),
    });

    await expect(refreshPromise).rejects.toMatchObject({
      code: 'SESSION_CHANGED',
    });
  });

  test('B2. api.bumpRefreshEpoch() bumps the epoch on each call', () => {
    const e0 = api.getRefreshEpoch();
    api.bumpRefreshEpoch();
    const e1 = api.getRefreshEpoch();
    api.bumpRefreshEpoch();
    const e2 = api.getRefreshEpoch();
    expect(e1).toBe(e0 + 1);
    expect(e2).toBe(e0 + 2);
  });

  test('C1. auth:token-refreshed is dispatched with the new accessToken', async () => {
    let received = null;
    const handler = (e) => { received = e.detail; };
    window.addEventListener('auth:token-refreshed', handler);

    global.fetch = jest.fn().mockImplementation(() => Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ accessToken: 'dispatched-access', refreshToken: 'dispatched-refresh' }),
    }));

    await api.refreshToken();

    expect(received).toBeTruthy();
    expect(received.accessToken).toBe('dispatched-access');
    expect(typeof received.epoch).toBe('number');
    window.removeEventListener('auth:token-refreshed', handler);
  });

  test('C2. auth:token-refreshed fires exactly ONCE even for parallel refreshes', async () => {
    let fireCount = 0;
    const handler = () => { fireCount += 1; };
    window.addEventListener('auth:token-refreshed', handler);

    global.fetch = jest.fn().mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve({
        ok: true,
        status: 200,
        json: async () => ({ accessToken: 'new', refreshToken: 'new-r' }),
      }), 20);
    }));

    await Promise.all([api.refreshToken(), api.refreshToken(), api.refreshToken()]);
    expect(fireCount).toBe(1);
    window.removeEventListener('auth:token-refreshed', handler);
  });

  test('D1. auth:token-refreshed detail carries the epoch', async () => {
    let received = null;
    const handler = (e) => { received = e.detail; };
    window.addEventListener('auth:token-refreshed', handler);

    global.fetch = jest.fn().mockImplementation(() => Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ accessToken: 'with-epoch', refreshToken: 'rot' }),
    }));

    const epochBefore = api.getRefreshEpoch();
    await api.refreshToken();
    expect(received.epoch).toBe(epochBefore);

    window.removeEventListener('auth:token-refreshed', handler);
  });

  test('D2. logout-shaped flow: bumpRefreshEpoch then refresh → SESSION_CHANGED', async () => {
    let firstResolve;
    const first = new Promise((resolve) => { firstResolve = resolve; });
    let secondResolve;
    const second = new Promise((resolve) => { secondResolve = resolve; });
    let refreshCount = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      refreshCount += 1;
      if (refreshCount === 1) return first;
      return second;
    });

    const staleRefresh = api.refreshToken();
    api.bumpRefreshEpoch();
    api.bumpRefreshEpoch();
    firstResolve({
      ok: true,
      status: 200,
      json: async () => ({ accessToken: 'old-account-token', refreshToken: 'old-r' }),
    });
    await expect(staleRefresh).rejects.toMatchObject({ code: 'SESSION_CHANGED' });

    // Wait a tick for .finally() to clear refreshingPromise.
    await new Promise((r) => setTimeout(r, 5));
    const fresh = api.refreshToken();
    secondResolve({
      ok: true,
      status: 200,
      json: async () => ({ accessToken: 'new-account-token', refreshToken: 'new-r' }),
    });
    await expect(fresh).resolves.toBe('new-account-token');
  });
});

describe('SOL DR-011 — AuthContext coordinates with api.js (single source of truth)', () => {
  test('E1. AuthContext uses api.refreshToken() — no second refresh implementation', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'contexts', 'AuthContext.jsx'),
      'utf8',
    );
    const code = src
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n');
    expect(code).toMatch(/api\.refreshToken\(\)/);
    expect(code).not.toMatch(/api\.post\(\s*['"]\/auth\/refresh['"]/);
  });

  test('E2. AuthContext subscribes to auth:token-refreshed', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'contexts', 'AuthContext.jsx'),
      'utf8',
    );
    expect(src).toMatch(/addEventListener\(\s*['"]auth:token-refreshed['"]/);
    expect(src).toMatch(/removeEventListener\(\s*['"]auth:token-refreshed['"]/);
  });

  test('E3. AuthContext.login bumps the refresh epoch', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'contexts', 'AuthContext.jsx'),
      'utf8',
    );
    expect(src).toMatch(/api\.bumpRefreshEpoch\(\)/);
  });

  test('E4. AuthContext.logout bumps the refresh epoch', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'contexts', 'AuthContext.jsx'),
      'utf8',
    );
    const matches = src.match(/api\.bumpRefreshEpoch\(\)/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});

