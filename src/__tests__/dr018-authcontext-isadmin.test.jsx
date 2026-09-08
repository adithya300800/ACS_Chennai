// DR-018 (live-sweep regression, 2026-09-08) — AuthContext never exposed
// `isAdmin`, so <ProtectedRoute requireAdmin>'s `requireAdmin && !isAdmin`
// check always evaluated to `true` for admins too, bouncing the admin off
// every admin-labelled route (e.g. /portal/admin/billing-certifications)
// to /portal/dashboard. The structural tests pinned the route wrapper,
// but never asserted the AuthContext value exposed `isAdmin`.
//
// Source-text contracts pin:
//   - AuthContext.Provider's value object contains `isAdmin` so the
//     destructured useAuth() in ProtectedRoute can branch correctly.
//   - The `isAdmin` expression reads from the context's `employee` record
//     (the same source of truth as `isAuthenticated: !!accessToken`).
//   - The default for a non-authenticated call is `false` (don't leak the
//     privilege to a logged-out visitor who somehow mounts the provider).
//
// Run: cd src && npx jest __tests__/dr018-authcontext-isadmin.test.jsx
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const authContextSrc = readFileSync(
  resolvePath(__dirname, '../contexts/AuthContext.jsx'),
  'utf8',
);

describe('DR-018 — AuthContext exposes isAdmin for ProtectedRoute', () => {
  test('1. The AuthContext.Provider value object includes isAdmin', () => {
    // Extract the value object body so the positive pin doesn't match
    // a stray `isAdmin` reference elsewhere in the file.
    const valueMatch = authContextSrc.match(
      /<AuthContext\.Provider\s+value=\{\{([\s\S]*?)\}\}>/,
    );
    expect(valueMatch).not.toBeNull();
    expect(valueMatch[1]).toMatch(/isAdmin\s*:/);
  });

  test('2. isAdmin derives from `employee && employee.isAdmin` (not a stale ref)', () => {
    const valueMatch = authContextSrc.match(
      /<AuthContext\.Provider\s+value=\{\{([\s\S]*?)\}\}>/,
    );
    expect(valueMatch).not.toBeNull();
    expect(valueMatch[1]).toMatch(
      /isAdmin\s*:\s*!!\(\s*employee\s*&&\s*employee\.isAdmin\s*\)/,
    );
  });

  test('3. ProtectedRoute still destructures isAdmin from useAuth()', () => {
    const protectedSrc = readFileSync(
      resolvePath(__dirname, '../components/ProtectedRoute.jsx'),
      'utf8',
    );
    expect(protectedSrc).toMatch(/const\s*\{\s*isAuthenticated\s*,\s*isAdmin\s*,\s*loading\s*\}\s*=\s*useAuth\(\)/);
    expect(protectedSrc).toMatch(/requireAdmin\s*&&\s*!isAdmin/);
  });
});
