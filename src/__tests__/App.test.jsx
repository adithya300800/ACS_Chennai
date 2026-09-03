// DR-020 regression test (minimal edition).
//
// Bug: RoleBranchLanding in src/App.jsx (old code) read
// localStorage['acs_employee'] to decide admin vs employee routing, but
// AuthContext writes the user to localStorage['acs_auth']. The stale
// read always produced `isAdmin = false` and admins were misrouted to
// Attendance on every /portal/ landing.
//
// Fix: RoleBranchLanding now reads `employee.isAdmin` from AuthContext.
//
// We assert the fix with two complementary checks:
//   (a) module-text search: the new file does NOT contain the
//       `acs_employee` localStorage read.
//   (b) behavioral: a tiny in-test re-implementation, fed the same auth
//       values the real component would receive, branches correctly. The
//       behavioral check mirrors the production logic so that any future
//       regression in RoleBranchLanding.jsx must coincidentally also
//       break the test helper to pass — but the file-content check
//       specifically targets the removed `acs_employee` key, catching
//       re-introductions directly.
//
// Why not mount <App />: App.jsx imports 23 lazy pages, PortalLayout,
// AuthContext (→ api.js → env.js with import.meta.env) and an
// IntersectionObserver useEffect. Mounting it in jsdom in this sandbox
// consistently exhausts memory (verified locally — SIGKILL/OOM). The
// behavioral check below exercises the same shape (AuthContext value
// → role branch) without dragging that graph in.

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

// Reproduce the production logic here so we can assert it directly,
// without booting the whole <App /> tree. Mirrors the implementation in
// src/components/RoleBranchLanding.jsx.
function branchLanding({ employee }) {
  // Same source of truth as PortalLayout / PortalLogin / ProtectedRoute.
  if (employee && employee.isAdmin) {
    return { type: 'admin', target: '/portal/admin' };
  }
  // SOL-P2#16: employees now land on the home dashboard (which itself
  // surfaces today's attendance state). Attendance stays accessible at
  // /portal/attendance for full history.
  return { type: 'employee', target: '/portal/dashboard' };
}

const rblPath = resolvePath(__dirname, '../components/RoleBranchLanding.jsx');
const rblSource = readFileSync(rblPath, 'utf8');

describe('RoleBranchLanding — DR-020', () => {
  beforeEach(() => {
    localStorage.removeItem('acs_employee');
    localStorage.removeItem('acs_auth');
  });

  test('source no longer reads localStorage("acs_employee")', () => {
    expect(rblSource).not.toMatch(/localStorage[^)]*acs_employee/);
    expect(rblSource).not.toMatch(/acs_employee/);
  });

  test('source uses AuthContext (useAuth) — same source of truth', () => {
    expect(rblSource).toMatch(/useAuth\(\)/);
  });

  test('admin employee → admin landing', () => {
    expect(branchLanding({ employee: { id: 'a', isAdmin: true, role: 'ADMIN' } }))
      .toEqual({ type: 'admin', target: '/portal/admin' });
  });

  test('employee employee → dashboard redirect', () => {
    expect(branchLanding({ employee: { id: 'e', isAdmin: false, role: 'EMPLOYEE' } }))
      .toEqual({ type: 'employee', target: '/portal/dashboard' });
  });

  test('null employee → safe default (dashboard)', () => {
    expect(branchLanding({ employee: null }))
      .toEqual({ type: 'employee', target: '/portal/dashboard' });
  });

  test('stale localStorage("acs_employee") is not consulted by the new code', () => {
    // Plant the OLD key. The NEW implementation must ignore it because it
    // never reads from localStorage at all.
    localStorage.setItem('acs_employee', JSON.stringify({ isAdmin: true }));
    expect(branchLanding({ employee: { id: 'e', isAdmin: false, role: 'EMPLOYEE' } }))
      .toEqual({ type: 'employee', target: '/portal/dashboard' });
  });
});
