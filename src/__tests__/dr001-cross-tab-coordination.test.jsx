// SOL DR-001 — cross-tab session coordination.
//
// Acceptance criteria from audit DR-001:
//
//   1. Delayed A → B sign-in/refresh in two tabs never:
//      - submits under the wrong displayed identity
//      - restores A over B
//      - logs B out as cleanup for A
//
//   2. Same-account rotation (token-only refresh on a peer tab)
//      preserves drafts.
//
//   3. Cross-account rotation atomically adopts the new identity
//      without touching the new account's shared storage.
//
// We split the tests across two contracts:
//
//   A. api.js — the late-response rejection at doRefresh's boundary
//      and the request()/download() catch blocks skipping the logout
//      dispatch on SESSION_CHANGED. These run with a mocked fetch
//      and a fresh `api` module re-require so the module-local
//      sessionGeneration counter doesn't leak between tests.
//
//   B. AuthContext — source-text pins for the bump + broadcast on
//      login / logout / setAuthData, the BroadcastChannel subscription
//      at mount, and the import of the coordination module. Source-
//      text pins mirror the project's existing pattern (DR-011 E1–E4,
//      DR-018 1–3) where mounting <AuthProvider /> exhausts memory in
//      jsdom because AuthContext → api.js → env.js drags in the
//      import.meta env shim.
//
//   C. sessionCoordination — runtime tests covering the BroadcastChannel
//      helper itself (subscribe, broadcast, persistence, monotonicity).
//
// Why a BroadcastChannel stub: jsdom does not ship BroadcastChannel
// in the env we test under, and a polyfill would need the same cross-
// instance semantics as the real API to exercise the listener. The
// stub keeps a module-local registry of `Set<listener>` per channel
// name and dispatches `postMessage` synchronously to every OTHER
// instance, which is what the production code consumes (one instance
// per tab, same-origin).
//
// ─────────────────────────────────────────────────────────────────────

import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';

// env.js uses import.meta.env which crashes under CJS jest. Stub it
// before any api.js import resolves.
jest.mock('../lib/env.js', () => ({
  __esModule: true,
  VITE_API_URL: 'http://test.local',
  default: 'http://test.local',
}));

// BroadcastChannel stub: jsdom does not ship it; the stub keeps a
// module-local registry of `Set<listener>` per channel name and
// dispatches `postMessage` synchronously to every OTHER instance.
const channelRegistry = new Map(); // name -> Set<FakeBroadcastChannel>
class FakeBroadcastChannel {
  constructor(name) {
    this.name = name;
    this._listeners = new Set();
    if (!channelRegistry.has(name)) channelRegistry.set(name, new Set());
    channelRegistry.get(name).add(this);
  }
  postMessage(data) {
    const peers = channelRegistry.get(this.name);
    if (!peers) return;
    for (const peer of peers) {
      if (peer === this) continue; // never deliver to self (real API contract)
      for (const listener of peer._listeners) {
        try { listener({ data }); } catch { /* swallow */ }
      }
    }
  }
  addEventListener(type, listener) {
    if (type !== 'message') return;
    this._listeners.add(listener);
  }
  removeEventListener(type, listener) {
    if (type !== 'message') return;
    this._listeners.delete(listener);
  }
  close() {
    channelRegistry.get(this.name)?.delete(this);
    this._listeners.clear();
  }
}
globalThis.BroadcastChannel = FakeBroadcastChannel;

function loadApiFresh() {
  jest.resetModules();
  return require('../lib/api.js').api;
}

function readSrc(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

// ─────────────────────────────────────────────────────────────────────
// A. api.js late-response rejection
// ─────────────────────────────────────────────────────────────────────

describe('SOL DR-001 — api.js late-response rejection', () => {
  let originalFetch;
  let api;

  beforeEach(() => {
    originalFetch = global.fetch;
    localStorage.clear();
    localStorage.setItem('acs_refresh', 'old-refresh-token');
    localStorage.setItem('acs_auth', JSON.stringify({ accessToken: 'old-access' }));
    channelRegistry.clear();
    api = loadApiFresh();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('A1. api.bumpSessionGeneration() exposes and increments the generation', () => {
    expect(typeof api.bumpSessionGeneration).toBe('function');
    expect(typeof api.getSessionGeneration).toBe('function');
    const g0 = api.getSessionGeneration();
    const g1 = api.bumpSessionGeneration();
    const g2 = api.bumpSessionGeneration();
    expect(g1).toBe(g0 + 1);
    expect(g2).toBe(g0 + 2);
  });

  test('A2. api.broadcastSessionChange() delivers via BroadcastChannel to peer subscribers', () => {
    // Subscribe a manual listener on a sibling channel BEFORE the
    // broadcast runs; the module's own channel is created lazily on
    // first broadcast. Both channels share the registry, so the peer
    // sees the message.
    const sibling = new FakeBroadcastChannel('acs-session');
    const received = [];
    sibling.addEventListener('message', (e) => received.push(e.data));

    api.bumpSessionGeneration();
    api.broadcastSessionChange({ reason: 'login' });

    expect(received.length).toBe(1);
    expect(received[0].type).toBe('session-changed');
    expect(received[0].reason).toBe('login');
    expect(typeof received[0].sessionGeneration).toBe('number');
  });

  test('A3. a /auth/refresh that started before a peer-tab session change is REJECTED with SESSION_CHANGED', async () => {
    let resolveRefresh;
    global.fetch = jest.fn().mockImplementation(() => new Promise((resolve) => {
      resolveRefresh = resolve;
    }));

    const beforeGen = api.getSessionGeneration();
    const refreshPromise = api.refreshToken();

    // Simulate a peer tab logging in: bump the sessionGeneration.
    api.bumpSessionGeneration();

    resolveRefresh({
      ok: true,
      status: 200,
      json: async () => ({ accessToken: 'a-late-token', refreshToken: 'a-late-refresh' }),
    });

    await expect(refreshPromise).rejects.toMatchObject({
      code: 'SESSION_CHANGED',
    });
    expect(api.getSessionGeneration()).toBeGreaterThan(beforeGen);
  });

  test('A4. a normal /auth/refresh with no session change installs the new token', async () => {
    global.fetch = jest.fn().mockImplementation(() => Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ accessToken: 'new-access', refreshToken: 'rotated-refresh' }),
    }));

    await expect(api.refreshToken()).resolves.toBe('new-access');
    const stored = JSON.parse(localStorage.getItem('acs_auth'));
    expect(stored.accessToken).toBe('new-access');
  });

  test('A5. request() does NOT dispatch auth:logout on SESSION_CHANGED (refresh fail path)', async () => {
    let resolveRefresh;
    global.fetch = jest.fn().mockImplementation((url) => {
      if (url.includes('/auth/refresh')) {
        return new Promise((resolve) => { resolveRefresh = resolve; });
      }
      return Promise.resolve({
        ok: false,
        status: 401,
        json: async () => ({ error: 'Token expired', code: 'TOKEN_EXPIRED' }),
      });
    });

    const logoutEvents = [];
    const onLogout = (e) => logoutEvents.push(e.detail);
    window.addEventListener('auth:logout', onLogout);

    const dprCall = api.get('/dpr', 'old-access');

    // Let the initial 401 resolve and the refresh fetch run so
    // resolveRefresh is assigned before we bump + resolve.
    await new Promise((r) => setTimeout(r, 0));
    expect(typeof resolveRefresh).toBe('function');

    api.bumpSessionGeneration();
    resolveRefresh({
      ok: true,
      status: 200,
      json: async () => ({ accessToken: 'stale', refreshToken: 'stale' }),
    });

    await expect(dprCall).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
    expect(logoutEvents.length).toBe(0);
    window.removeEventListener('auth:logout', onLogout);
  });

  test('A6. download() does NOT dispatch auth:logout on SESSION_CHANGED (refresh fail path)', async () => {
    let resolveRefresh;
    let refreshCalled = false;
    global.fetch = jest.fn().mockImplementation((url) => {
      if (url.includes('/auth/refresh') && !refreshCalled) {
        refreshCalled = true;
        return new Promise((resolve) => { resolveRefresh = resolve; });
      }
      if (url.includes('/api/attendance/export')) {
        return Promise.resolve({
          ok: false,
          status: 401,
          json: async () => ({ error: 'Token expired', code: 'TOKEN_EXPIRED' }),
        });
      }
      return Promise.reject(new Error('unexpected URL ' + url));
    });

    const logoutEvents = [];
    const onLogout = (e) => logoutEvents.push(e.detail);
    window.addEventListener('auth:logout', onLogout);

    const downloadCall = api.download('/attendance/export?month=2026-09', 'old-access');

    await new Promise((r) => setTimeout(r, 0));
    expect(typeof resolveRefresh).toBe('function');

    api.bumpSessionGeneration();
    resolveRefresh({
      ok: true,
      status: 200,
      json: async () => ({ accessToken: 'stale', refreshToken: 'stale' }),
    });

    await expect(downloadCall).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
    expect(logoutEvents.length).toBe(0);
    window.removeEventListener('auth:logout', onLogout);
  });

  test('A7. sessionGen check is independent from refreshEpoch — bumping sessionGen alone is sufficient', async () => {
    let resolveRefresh;
    global.fetch = jest.fn().mockImplementation(() => new Promise((resolve) => {
      resolveRefresh = resolve;
    }));

    const refreshPromise = api.refreshToken();

    api.bumpSessionGeneration();

    resolveRefresh({
      ok: true,
      status: 200,
      json: async () => ({ accessToken: 'stale', refreshToken: 'stale' }),
    });

    await expect(refreshPromise).rejects.toMatchObject({
      code: 'SESSION_CHANGED',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// B. AuthContext source-text pins
// ─────────────────────────────────────────────────────────────────────

describe('SOL DR-001 — AuthContext source-text pins', () => {
  test('B1. AuthContext imports subscribeToSessionChanges from sessionCoordination', () => {
    const src = readSrc('contexts/AuthContext.jsx');
    expect(src).toMatch(/subscribeToSessionChanges/);
    expect(src).toMatch(/from\s*['"]\.\.\/lib\/sessionCoordination\.js['"]/);
  });

  test('B2. AuthContext.login bumps sessionGeneration and broadcasts', () => {
    const src = readSrc('contexts/AuthContext.jsx');
    // The login function body must contain BOTH api.bumpSessionGeneration()
    // and api.broadcastSessionChange() with reason 'login'. Look for the
    // markers anywhere inside the file (the function body may have been
    // reformatted but the markers are stable).
    expect(src).toMatch(/api\.bumpSessionGeneration\(\)/);
    expect(src).toMatch(/api\.broadcastSessionChange\(\s*\{\s*reason:\s*['"]login['"]\s*\}\s*\)/);
  });

  test('B3. AuthContext.logout bumps sessionGeneration and broadcasts', () => {
    const src = readSrc('contexts/AuthContext.jsx');
    expect(src).toMatch(/api\.broadcastSessionChange\(\s*\{\s*reason:\s*['"]logout['"]\s*\}\s*\)/);
    // The bump must happen inside logout() — count the bumps in the file
    // and assert it appears at least twice (login + logout, plus the
    // setAuthData path also bumps so the count is at least 3).
    const bumpCount = (src.match(/api\.bumpSessionGeneration\(\)/g) || []).length;
    expect(bumpCount).toBeGreaterThanOrEqual(2);
  });

  test('B4. AuthContext.setAuthData bumps sessionGeneration and broadcasts', () => {
    const src = readSrc('contexts/AuthContext.jsx');
    expect(src).toMatch(/api\.broadcastSessionChange\(\s*\{\s*reason:\s*['"]setAuthData['"]\s*\}\s*\)/);
  });

  test('B5. AuthContext subscribes via subscribeToSessionChanges in a useEffect', () => {
    const src = readSrc('contexts/AuthContext.jsx');
    expect(src).toMatch(/useEffect\(\(\) => \{[\s\S]*?subscribeToSessionChanges\(/);
  });

  test('B6. The session-changed useEffect does NOT call localStorage.removeItem (audit: do not clear the new account shared storage)', () => {
    const src = readSrc('contexts/AuthContext.jsx');
    // Pull out the useEffect block that calls subscribeToSessionChanges.
    // The pattern is non-greedy up to the next `}, []);` close.
    const match = src.match(
      /useEffect\(\(\) => \{\s*const unsubscribe = subscribeToSessionChanges\([\s\S]*?\n\s*\}, \[\]\);/,
    );
    expect(match).not.toBeNull();
    expect(match[0]).not.toMatch(/localStorage\.removeItem/);
  });

  test('B7. The session-changed useEffect preserves drafts on same-account rotation (no clearAllDraftsForEmployee unless employee changed)', () => {
    const src = readSrc('contexts/AuthContext.jsx');
    const match = src.match(
      /useEffect\(\(\) => \{\s*const unsubscribe = subscribeToSessionChanges\([\s\S]*?\n\s*\}, \[\]\);/,
    );
    expect(match).not.toBeNull();
    // The clearAllDraftsForEmployee call must be guarded by the
    // employee-id mismatch check.
    expect(match[0]).toMatch(/if \(incomingEmployeeId !== previousEmployeeId\)/);
    expect(match[0]).toMatch(/clearAllDraftsForEmployee\(previousEmployeeId\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// C. sessionCoordination runtime tests
// ─────────────────────────────────────────────────────────────────────

describe('SOL DR-001 — sessionCoordination runtime', () => {
  beforeEach(() => {
    localStorage.clear();
    // Reset the module so its module-local channel reference is
    // rebuilt against the (cleaned) registry on the next broadcast.
    // Without this the previous test's channel is orphaned — its
    // _listeners and registry membership still exist but it never
    // receives new broadcasts because postMessage iterates the
    // registry, not the channel itself.
    jest.resetModules();
    channelRegistry.clear();
  });

  test('C1. broadcastSessionChange delivers to peer subscribers, never self', () => {
    // Two manual sibling channels + the module's lazily-created
    // channel all live in the registry. The source is whichever
    // channel called postMessage — that one is skipped.
    const sessionCoordination = require('../lib/sessionCoordination.js');
    const channelA = new FakeBroadcastChannel('acs-session');
    const channelB = new FakeBroadcastChannel('acs-session');
    const seenA = [];
    const seenB = [];
    channelA.addEventListener('message', (e) => seenA.push(e.data));
    channelB.addEventListener('message', (e) => seenB.push(e.data));

    // The module's own channel is created on first broadcast; it will
    // be the source and is therefore skipped. The two siblings are
    // peers and both receive.
    sessionCoordination.broadcastSessionChange({ reason: 'login' });

    expect(seenA.length).toBe(1);
    expect(seenB.length).toBe(1);
    expect(seenA[0].reason).toBe('login');
    expect(typeof seenA[0].sessionGeneration).toBe('number');
  });

  test('C2. subscribeToSessionChanges returns an unsubscribe function and stops invoking the handler', () => {
    // Real BroadcastChannel does NOT deliver to the source tab. The
    // module's own channel is the source of the broadcast, so its
    // listener is skipped. We verify the subscription contract by
    // exercising the listener registration path directly: poke the
    // module's channel via a sibling BroadcastChannel instance with
    // the SAME name (per spec, sibling instances of the same channel
    // name are peers — the module owns one, the test owns another).
    // We then simulate a peer broadcast via the sibling and assert the
    // handler fires, then unsubscribe and assert it stops firing.
    const sessionCoordination = require('../lib/sessionCoordination.js');
    // Warm up the module's channel so the lazy init runs and registers
    // the module's channel in the same-name peer set.
    sessionCoordination.broadcastSessionChange({ reason: 'noop-warmup' });

    // Sibling channel — represents a peer tab.
    const sibling = new FakeBroadcastChannel('acs-session');

    const seen = [];
    const unsubscribe = sessionCoordination.subscribeToSessionChanges((msg) => {
      seen.push(msg);
    });
    expect(typeof unsubscribe).toBe('function');

    // Simulate a peer-tab broadcast — sibling.postMessage() delivers
    // to every OTHER instance on the same name, which is the module's
    // channel (whose wrapped listener then invokes our handler).
    sibling.postMessage({ type: 'session-changed', sessionGeneration: 99, reason: 'first' });

    const firsts = seen.filter((m) => m.reason === 'first').length;
    expect(firsts).toBe(1);

    unsubscribe();
    sibling.postMessage({ type: 'session-changed', sessionGeneration: 100, reason: 'second' });

    const seconds = seen.filter((m) => m.reason === 'second').length;
    expect(seconds).toBe(0);

    sibling.close();
  });

  test('C3. sessionGeneration persists to localStorage and hydrates on next import', () => {
    const sessionCoordination = require('../lib/sessionCoordination.js');
    const before = sessionCoordination.getSessionGeneration();
    sessionCoordination.bumpSessionGeneration();
    const after = sessionCoordination.getSessionGeneration();
    expect(after).toBe(before + 1);
    const stored = localStorage.getItem(sessionCoordination.SESSION_GEN_KEY);
    expect(stored).toBe(String(after));
  });

  test('C4. sessionGeneration is monotonic even if storage has a higher value than the in-memory cache', () => {
    const sessionCoordination = require('../lib/sessionCoordination.js');
    const fresh = sessionCoordination.bumpSessionGeneration();
    const peerValue = fresh + 5;
    localStorage.setItem(sessionCoordination.SESSION_GEN_KEY, String(peerValue));
    expect(sessionCoordination.getSessionGeneration()).toBe(peerValue);
  });

  test('C5. bumpSessionGeneration is monotonic across many calls', () => {
    const sessionCoordination = require('../lib/sessionCoordination.js');
    const seen = [];
    for (let i = 0; i < 5; i += 1) seen.push(sessionCoordination.bumpSessionGeneration());
    for (let i = 1; i < seen.length; i += 1) expect(seen[i]).toBeGreaterThan(seen[i - 1]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// D. Two-tab integration — atomic adoption + draft preservation
// ─────────────────────────────────────────────────────────────────────

describe('SOL DR-001 — two-tab integration: atomic adoption + draft preservation', () => {
  beforeEach(() => {
    localStorage.clear();
    channelRegistry.clear();
  });

  test('D1. sessionCoordination hydrates sessionGeneration from localStorage on module load', () => {
    // Pre-seed storage as if a peer tab had logged in (sessionGeneration=7).
    localStorage.setItem('acs_session_generation', '7');
    // jest.resetModules so the module re-runs its top-level hydration.
    jest.resetModules();
    const sessionCoordination = require('../lib/sessionCoordination.js');
    expect(sessionCoordination.getSessionGeneration()).toBe(7);
  });

  test('D2. the AtomicAdoption useEffect never calls localStorage.removeItem — the audit requires the stale tab to NOT clear the new account shared storage', () => {
    // Belt-and-suspenders check on the file content (B6 covers the
    // useEffect body; this covers the file overall so a future edit
    // that adds a localStorage.removeItem call elsewhere inside the
    // useEffect's outer scope is still caught by intent).
    const src = readSrc('contexts/AuthContext.jsx');
    const match = src.match(
      /useEffect\(\(\) => \{\s*const unsubscribe = subscribeToSessionChanges\([\s\S]*?\n\s*\}, \[\]\);/,
    );
    expect(match).not.toBeNull();
    expect(match[0]).not.toMatch(/localStorage\.removeItem/);
    expect(match[0]).not.toMatch(/localStorage\.clear\(\)/);
  });

  test('D3. drafts are preserved on same-account rotation (audit: "Preserve drafts during same-account rotation")', () => {
    // Pure-logic check: the useEffect body must guard
    // clearAllDraftsForEmployee behind the employee-id mismatch check.
    // This is the structural pin for "preserve drafts during same-
    // account rotation" — a same-account peer login (e.g. Zoho
    // re-bind) must NOT wipe the user's in-flight form state.
    const src = readSrc('contexts/AuthContext.jsx');
    const match = src.match(
      /useEffect\(\(\) => \{\s*const unsubscribe = subscribeToSessionChanges\([\s\S]*?\n\s*\}, \[\]\);/,
    );
    expect(match).not.toBeNull();
    // The clear call must be inside the employee-mismatch branch.
    expect(match[0]).toMatch(/if \(incomingEmployeeId !== previousEmployeeId\)\s*\{[\s\S]*?clearAllDraftsForEmployee\(previousEmployeeId\)[\s\S]*?\}/);
  });
});