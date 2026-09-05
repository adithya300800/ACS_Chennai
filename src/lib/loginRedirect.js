// DR-015 — Pure helper for picking the post-auth landing.
//
// Background: ProtectedRoute captures the original target into
// `location.state.from` when it redirects an unauthenticated user to
// /portal/login. Previously PortalLogin ignored `from` and always
// landed on the role landing. This breaks the audit's acceptance
// criterion: "a generated email link opened while logged out ends at
// the intended record/preferences page after sign-in".
//
// This module is pure (no React, no router) so it can be unit-tested
// in isolation. Guards:
//
//   - Only consider `from` if it looks like a portal path (an attacker
//     who can inject router state MUST NOT be able to bounce the user
//     to an external origin via navigate()).
//   - Skip /portal/login itself to avoid an auth loop.
//   - Re-attach the search portion so /portal/dpr/all?id=dpr-123
//     round-trips end-to-end (HashRouter strips it from pathname;
//     pathname + search is the round-trip-safe form).
//   - Trailing slashes are normalized so /portal/admin and
//     /portal/admin/ land identically.
//
// `from` is whatever `useLocation().state.from` produced. ProtectedRoute
// sets it from the Location object (pathname + search + hash). We
// ignore `hash` (HashRouter reads the live `location.hash`, and the
// audit never depends on hash-based deep links).

export function resolveLanding(from, employee) {
  const fallback = employee?.isAdmin ? '/portal/admin' : '/portal/dashboard';
  if (!from || typeof from !== 'object') return fallback;
  const rawPath = from.pathname;
  if (typeof rawPath !== 'string') return fallback;
  // Normalize trailing slashes (except for the bare "/" path, which
  // would never pass the `/portal/` check anyway).
  const pathname = rawPath.length > 1 && rawPath.endsWith('/')
    ? rawPath.slice(0, -1)
    : rawPath;
  if (!pathname.startsWith('/portal/')) return fallback;
  if (pathname === '/portal/login') return fallback;
  // Re-attach the search portion if ProtectedRoute captured it.
  const search = typeof from.search === 'string' && from.search.length > 0 ? from.search : '';
  return search ? `${pathname}${search}` : pathname;
}

export default resolveLanding;
