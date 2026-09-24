// DR-023 (audit, 2026-09-24) — Variation transitions lost Authorization
// and put a token in the version field.
//
// Audit findings:
//   1. The detail page called submit/approve/reject with `(id, accessToken)`
//      but the api.js wrappers expected `(id, expectedVersion, token)`. The
//      token ended up in the `expectedVersion` slot and `token` was
//      undefined, so the server returned 401 Authorization required and
//      dispatched auth:logout on what was actually a valid session.
//   2. The new draft was created successfully at V0, then Submit returned
//      401 and redirected the administrator to login. Evidence file:
//      cycle2-variation-submit-result.json.
//
// Resolution:
//   - Refactor the three wrappers (submit/approve/reject) in src/lib/api.js
//     to take a single named-options object `{ id, expectedVersion, token
//     [, reason] }` instead of positional args.
//   - Update the three call sites in src/pages/VariationOrderDetail.jsx to
//     pass `expectedVersion: variation.version` and `token: accessToken`
//     via the named-options shape.
//   - Preserve server authentication and stale-version rejection — do not
//     weaken either.
//
// Tests pin:
//   - the wrapper signature change (named-options, not positional)
//   - the wire payload shape (expectedVersion forwarded correctly)
//   - the page call sites pass named-options with the displayed version
//     and the authenticated token
//   - the Bearer Authorization header is present (preserved)
//   - stale-version rejection surfaces 409 to the page without logging
//     out a healthy session
//
// Run: cd src && npx jest __tests__/dr023-variation-transitions-named-options.test.jsx

import { jest } from '@jest/globals';
import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const apiPath = resolvePath(__dirname, '../lib/api.js');
const apiSrc = readFileSync(apiPath, 'utf8');
const pagePath = resolvePath(__dirname, '../pages/VariationOrderDetail.jsx');
const pageSrc = readFileSync(pagePath, 'utf8');

jest.mock('../lib/env.js', () => ({
  __esModule: true,
  VITE_API_URL: 'http://test.local',
  default: 'http://test.local',
}));

function loadApiFresh() {
  jest.resetModules();
  return require('../lib/api.js').api;
}

describe('DR-023 — variation transition wrappers use named-options', () => {
  test('1. submitVariation / approveVariation / rejectVariation destructure a single options object', () => {
    // The audit fix moves from positional `(id, expectedVersion, token)` to
    // named-options `({ id, expectedVersion, token })`. Pin the destructured
    // shape on all three so a future revert to positional args fails the
    // test instead of silently re-introducing the bug.
    expect(apiSrc).toMatch(/submitVariation\s*:\s*\(\s*\{\s*id\s*,\s*expectedVersion\s*,\s*token\s*\}\s*\)/);
    expect(apiSrc).toMatch(/approveVariation\s*:\s*\(\s*\{\s*id\s*,\s*expectedVersion\s*,\s*token\s*\}\s*\)/);
    expect(apiSrc).toMatch(
      /rejectVariation\s*:\s*\(\s*\{\s*id\s*,\s*expectedVersion\s*,\s*token\s*,\s*reason\s*\}\s*\)/,
    );
  });

  test('2. wrappers do NOT accept positional (id, expectedVersion, token) anymore', () => {
    // The exact buggy shape — must be gone.
    expect(apiSrc).not.toMatch(/submitVariation\s*:\s*\(\s*id\s*,\s*expectedVersion\s*,\s*token\s*\)/);
    expect(apiSrc).not.toMatch(/approveVariation\s*:\s*\(\s*id\s*,\s*expectedVersion\s*,\s*token\s*\)/);
    expect(apiSrc).not.toMatch(
      /rejectVariation\s*:\s*\(\s*id\s*,\s*\{\s*reason\s*\}\s*,\s*expectedVersion\s*,\s*token\s*\)/,
    );
  });

  test('3. submitVariation forwards expectedVersion (the displayed version) on the wire', async () => {
    // Run-time assertion: the wrapper passes whatever expectedVersion was
    // supplied in the named-options shape straight through to the POST body.
    // Pin the wire payload so the server's 409 VERSION_CONFLICT gate
    // (backend/src/routes/variations.js:606-622) actually fires when the
    // user is stale.
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'vo-1', status: 'SUBMITTED', version: 1 }),
    });
    global.fetch = fetchMock;
    const api = loadApiFresh();

    await api.submitVariation({ id: 'vo-1', expectedVersion: 7, token: 'tok-abc' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledOpts] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe('http://test.local/api/variations/vo-1/submit');
    expect(calledOpts.method).toBe('POST');
    expect(calledOpts.headers.Authorization).toBe('Bearer tok-abc');
    expect(JSON.parse(calledOpts.body)).toEqual({ expectedVersion: 7 });
  });

  test('4. approveVariation forwards expectedVersion AND the Bearer token', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'vo-1', status: 'APPROVED', version: 2 }),
    });
    global.fetch = fetchMock;
    const api = loadApiFresh();

    await api.approveVariation({ id: 'vo-1', expectedVersion: 3, token: 'admin-tok' });

    const [calledUrl, calledOpts] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe('http://test.local/api/variations/vo-1/approve');
    expect(calledOpts.headers.Authorization).toBe('Bearer admin-tok');
    expect(JSON.parse(calledOpts.body)).toEqual({ expectedVersion: 3 });
  });

  test('5. rejectVariation forwards reason AND expectedVersion AND the Bearer token', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'vo-1', status: 'REJECTED', version: 2 }),
    });
    global.fetch = fetchMock;
    const api = loadApiFresh();

    await api.rejectVariation({
      id: 'vo-1',
      expectedVersion: 4,
      token: 'admin-tok',
      reason: 'out of scope',
    });

    const [calledUrl, calledOpts] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe('http://test.local/api/variations/vo-1/reject');
    expect(calledOpts.headers.Authorization).toBe('Bearer admin-tok');
    expect(JSON.parse(calledOpts.body)).toEqual({
      expectedVersion: 4,
      reason: 'out of scope',
    });
  });
});

describe('DR-023 — VariationOrderDetail call sites use named-options', () => {
  test('6. handleSubmit calls api.submitVariation with named-options', () => {
    // Source pin: the handler must destructure and pass an object literal
    // — not `(id, accessToken)` (the bug). The version comes from
    // `variation.version` (the displayed number), not the token.
    expect(pageSrc).toMatch(
      /api\.submitVariation\(\s*\{\s*id\s*,\s*expectedVersion\s*:\s*variation\.version\s*,\s*token\s*:\s*accessToken\s*\}\s*\)/,
    );
  });

  test('7. handleApprove calls api.approveVariation with named-options', () => {
    expect(pageSrc).toMatch(
      /api\.approveVariation\(\s*\{\s*id\s*,\s*expectedVersion\s*:\s*variation\.version\s*,\s*token\s*:\s*accessToken\s*\}\s*\)/,
    );
  });

  test('8. handleReject calls api.rejectVariation with named-options including reason', () => {
    expect(pageSrc).toMatch(
      /api\.rejectVariation\(\s*\{[\s\S]*?id\s*,[\s\S]*?expectedVersion\s*:\s*variation\.version\s*,[\s\S]*?token\s*:\s*accessToken\s*,[\s\S]*?reason\s*:\s*rejectReason\.trim\(\s*\)[\s\S]*?\}\s*\)/,
    );
  });

  test('9. VariationOrderDetail does NOT call any variation wrapper with positional (id, token)', () => {
    // The exact buggy shape — must be gone from the call sites too.
    expect(pageSrc).not.toMatch(/api\.submitVariation\(\s*id\s*,\s*accessToken\s*\)/);
    expect(pageSrc).not.toMatch(/api\.approveVariation\(\s*id\s*,\s*accessToken\s*\)/);
    expect(pageSrc).not.toMatch(
      /api\.rejectVariation\(\s*id\s*,\s*\{\s*reason\s*:\s*rejectReason/,
    );
  });
});

describe('DR-023 — stale-version rejection surfaces without logging out', () => {
  // The audit's acceptance criterion: "A real stale version produces a
  // conflict without logging out a healthy session." The api.js path for
  // 409 must NOT call dispatchLogoutOnce (which only fires on
  // TOKEN_INVALID / no-token / 401 + 4xx refresh failure). Pin the
  // absence here so a future refactor can't accidentally re-introduce
  // the 401-on-409 -> logout cascade.
  test('10. 409 VERSION_CONFLICT from the server is not routed through dispatchLogoutOnce', () => {
    // dispatchLogoutOnce is invoked in api.js for definitive auth failures.
    // Pin the call sites are confined to the 401 branches.
    const authFailureCalls = (apiSrc.match(/dispatchLogoutOnce\(/g) || []).length;
    expect(authFailureCalls).toBeGreaterThan(0); // still wired for real 401s
    // No 409-specific dispatch — VERSION_CONFLICT is a client error, not auth.
    // The path must rethrow the ApiError with status=409 + code='VERSION_CONFLICT'
    // and let the page handle it as a recoverable "refresh and retry".
    expect(apiSrc).not.toMatch(/409[\s\S]{0,200}dispatchLogoutOnce/);
  });

  test('11. submitVariation propagates a 409 VERSION_CONFLICT up to the caller (no silent re-throw)', async () => {
    // When the server returns 409 with code=VERSION_CONFLICT, the api.js
    // request() path rethrows an ApiError with that code intact. The page's
    // catch block can then push a "refresh and retry" toast — without ever
    // dispatching auth:logout.
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: 'This variation was modified by another action. Please refresh and try again.',
        code: 'VERSION_CONFLICT',
        currentVersion: 5,
      }),
    });
    global.fetch = fetchMock;
    const api = loadApiFresh();

    // Spy on dispatchEvent so we can confirm auth:logout is NOT fired for
    // a 409 conflict. AuthContext's listener is the only place that
    // handles the event — if we never dispatch it, no logout happens.
    const dispatchSpy = jest.spyOn(window, 'dispatchEvent');

    const err = await api
      .submitVariation({ id: 'vo-1', expectedVersion: 3, token: 'tok-abc' })
      .catch((e) => e);

    expect(err.status).toBe(409);
    expect(err.code).toBe('VERSION_CONFLICT');
    const authLogoutFired = dispatchSpy.mock.calls.some(
      ([evt]) => evt && evt.type === 'auth:logout',
    );
    expect(authLogoutFired).toBe(false);

    dispatchSpy.mockRestore();
  });
});
