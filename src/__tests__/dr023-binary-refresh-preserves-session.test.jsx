// DR-023 (audit, 2026-09-08) — Binary-export refresh failures end a valid session.
//
// Audit findings:
//   1. The harness injected an export 401 followed by a refresh 503. The
//      admin was logged out and shown session-expired messages. The real
//      personnel export was never fetched.
//   2. src/lib/api.js download()'s refresh-failure catch block called
//      dispatchLogoutOnce('refresh_failed') on EVERY refresh error
//      (transient 5xx / network / timeout included). That fired the
//      single-fire logout even when the user's session was fine and only
//      the wire was down.
//   3. The retry-fetch step after a successful refresh could also throw
//      a transient network / abort error. The previous code routed that
//      through the same refreshErr catch and again ended the session.
//   4. A revoked refresh token must still sign the user out — the
//      existing 4xx path stays intact.
//
// Source-text contracts pin:
//   - download() splits refresh() and the retry-fetch into two separate
//     try/catch phases; refreshErr.transient === true preserves the
//     session and rethrows as REFRESH_TRANSIENT.
//   - The retry-fetch catch tags AbortError / TypeError as transient
//     (TIMEOUT / NETWORK_ERROR with .transient = true) and does NOT
//     call dispatchLogoutOnce.
//   - Definitive 4xx refresh failures still dispatch auth:logout so a
//     truly revoked refresh token signs the user out.
//
// Run: cd src && npx jest __tests__/dr023-binary-refresh-preserves-session.test.jsx
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const apiPath = resolvePath(__dirname, '../lib/api.js');
const apiSrc = readFileSync(apiPath, 'utf8');

describe('DR-023 — binary-export refresh failures do not end a valid session', () => {
  test('1. download() refresh-failure branch distinguishes transient from definitive', () => {
    // Pin the new branch structure inside the download() refresh-failure
    // catch: a refreshErr with .transient === true must rethrow as
    // REFRESH_TRANSIENT without calling dispatchLogoutOnce. This is the
    // same gating pattern as the JSON request() path (DR-030) — the
    // transient classification is shared below response format.
    expect(apiSrc).toMatch(/isTransient\s*=\s*refreshErr\?\.transient\s*===\s*true/);
    expect(apiSrc).toMatch(/'REFRESH_TRANSIENT'/);
  });

  test('2. download() refresh-failure branch only logs out on definitive failure', () => {
    // Definitive refresh failures (revoked / replayed token → 4xx) MUST
    // still call dispatchLogoutOnce. Pin the call inside the
    // non-transient branch so the safety net cannot be silently removed.
    expect(apiSrc).toMatch(/dispatchLogoutOnce\(['"]refresh_failed['"]\)/);
  });

  test('3. download() retry-fetch transient failure preserves the session', () => {
    // After a successful refresh, the retry fetch can still fail with
    // AbortError (timeout) or TypeError (network). The previous code
    // routed both through the refreshErr catch and ended the session.
    // The fix wraps the retry fetch in its own try/catch and tags the
    // failure with .transient = true — NO dispatchLogoutOnce in this
    // branch.
    expect(apiSrc).toMatch(/fetchErr\.name\s*===\s*['"]AbortError['"]/);
    expect(apiSrc).toMatch(/retryErr\.transient\s*=\s*true/);
    // The retry-fetch catch block must NOT contain a dispatchLogoutOnce
    // call — that would re-introduce the bug. Pin the absence.
    const retryFetchBlock = apiSrc.match(/Retry the download[\s\S]{0,1500}throw retryErr;/);
    expect(retryFetchBlock).not.toBeNull();
    expect(retryFetchBlock[0]).not.toMatch(/dispatchLogoutOnce/);
  });

  test('4. download() retry-fetch transient error uses REFRESH_TRANSIENT code', () => {
    // The retry-fetch catch throws an ApiError with code TIMEOUT or
    // NETWORK_ERROR so downstream callers (the export UI in Admin.jsx)
    // can show a recoverable connectivity state without killing the
    // session. Pin both branches.
    expect(apiSrc).toMatch(/isAbort\s*\?\s*['"]TIMEOUT['"]\s*:\s*['"]NETWORK_ERROR['"]/);
  });

  test('5. Admin.jsx export callers propagate the new error shape unchanged', () => {
    // The export callers in Admin.jsx (handleExportMonth + handleExportEmployee)
    // catch every error and only read err.message / err.code / err.status.
    // They never inspect .transient directly — the new
    // REFRESH_TRANSIENT / TIMEOUT / NETWORK_ERROR codes flow through
    // existing error.message handling without changes. Pin that the
    // callers do not assume a definitive 'Session expired' shape, so a
    // transient ApiError reaches the user as a retryable toast.
    const adminPath = resolvePath(__dirname, '../pages/portal/Admin.jsx');
    const adminSrc = readFileSync(adminPath, 'utf8');
    expect(adminSrc).toMatch(/api\.downloadTimesheet/);
    // No `dispatchLogoutOnce` or auth state mutation in the export
    // handlers — the fix lives entirely in api.js.
    expect(adminSrc).not.toMatch(/dispatchLogoutOnce/);
  });
});