// DR-030 (audit, 2026-09-08) — A transient refresh outage is treated
// as invalid authentication.
//
// Audit findings:
//   1. The auth endpoint distinguishes a retryable 503 from invalid
//      credentials, but the shared client logged out on EVERY refresh
//      failure (backend/src/routes/auth.js:661-665 returns 503 on
//      infrastructure failure; src/lib/api.js threw a generic
//      ApiError which the request() catch path treated as session-
//      invalid).
//   2. A temporary infra incident could force a re-login and orphan
//      any draft the user was editing mid-submit.
//
// Source-text contracts pin:
//   - doRefresh() tags the ApiError with `transient = true` for any
//     5xx response (or zero / network error), distinguishing a
//     transient outage from a definitive 4xx (revoked / replayed
//     refresh token).
//   - fetchWithTimeout() tags timeout and NETWORK_ERROR errors as
//     transient — the user's identity is fine, only the wire is down.
//   - request()'s refresh-failure catch path preserves the session
//     when the error is transient and rethrows as REFRESH_TRANSIENT
//     instead of dispatching auth:logout. Only a 4xx from
//     /api/auth/refresh ends the session.
//
// Run: cd src && npx jest __tests__/dr030-transient-refresh.test.jsx
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const apiPath = resolvePath(__dirname, '../lib/api.js');
const apiSrc = readFileSync(apiPath, 'utf8');

describe('DR-030 — transient refresh outage is not a logout trigger', () => {
  test('1. doRefresh tags refresh failures with .transient when status is 5xx', () => {
    // The 5xx branch wraps the ApiError and sets transient = true so the
    // caller (request()) can preserve the session. Pin both the gate
    // (status >= 500 OR === 0 for off-line) and the tag.
    expect(apiSrc).toMatch(/const\s+transient\s*=\s*res\.status\s*>=\s*500\s*\|\|\s*res\.status\s*===\s*0/);
    expect(apiSrc).toMatch(/if\s*\(\s*transient\s*\)\s*err\.transient\s*=\s*true/);
  });

  test('2. fetchWithTimeout tags network / timeout errors as transient', () => {
    // Pin the helper that tags every fetchWithTimeout error as transient.
    expect(apiSrc).toMatch(/const\s+transientErr\s*=\s*\(msg,\s*code\)\s*=>/);
    expect(apiSrc).toMatch(/e\.transient\s*=\s*true/);
    // Both the AbortError (timeout) and NETWORK_ERROR (offline / DNS)
    // branches route through the same helper.
    expect(apiSrc).toMatch(/AbortError[\s\S]{0,200}throw\s+transientErr/);
    expect(apiSrc).toMatch(/NETWORK_ERROR[\s\S]{0,100}transientErr/);
  });

  test('3. request()\'s refresh-failure catch path branches on transient and preserves the session', () => {
    // Verify the new branch structure: when refreshErr.transient === true,
    // we DO NOT call dispatchLogoutOnce. We rethrow as REFRESH_TRANSIENT
    // so the calling widget can show a recoverable connectivity state.
    expect(apiSrc).toMatch(/isTransient\s*=\s*refreshErr\?\.transient\s*===\s*true/);
    expect(apiSrc).toMatch(/if\s*\(\s*isTransient\s*\)/);
    expect(apiSrc).toMatch(/'REFRESH_TRANSIENT'/);
  });

  test('4. Definitive 4xx (non-transient) still triggers auth:logout', () => {
    // Regression guard — the old behavior must remain for true 4xx
    // failures (revoked / replayed / unknown refresh tokens).
    expect(apiSrc).toMatch(/dispatchLogoutOnce\(['"]refresh_failed['"]\)/);
  });
});
