/**
 * resolveLanding — DR-015 post-auth landing picker.
 *
 * Background: ProtectedRoute captures the original target into
 * `location.state.from` when it redirects an unauthenticated user to
 * /portal/login. PortalLogin must honor `from` so an email-CTA link
 * opened while signed out lands on the intended record/preferences
 * page after sign-in. (Audit acceptance: "a generated email link
 * opened while logged out ends at the intended record/preferences
 * page after sign-in. Check the rendered page and record, not only
 * HTTP 200.")
 *
 * This file pins the three guards in src/lib/loginRedirect.js:
 *
 *   1. Admin/employee role fallback (manual login has no `from`).
 *   2. Portal-path-only guard — an attacker who can inject router
 *      state MUST NOT be able to navigate() the user to an external
 *      origin or to a non-portal path (e.g. /). Anything that does
 *      not start with `/portal/` collapses to the role fallback.
 *   3. Auth-loop guard — `from` pointing at /portal/login itself
 *      must collapse to the role fallback, otherwise an unauthenticated
 *      bounce would loop.
 *
 * Search-round-trip: when `from.search` is captured, the resolved
 * landing must re-attach it so deep-links like /portal/dpr/all?id=...
 * round-trip end-to-end (HashRouter strips it from pathname;
 * pathname + search is the round-trip-safe form).
 */

describe('resolveLanding — DR-015 post-auth landing picker', () => {
  let resolveLanding;

  beforeAll(() => {
    // Pure helper — no env, no router, no fetch. require() is fine
    // (the surrounding suite uses CJS via babel-jest; the helper file
    // has no imports so it loads cleanly).
    ({ resolveLanding } = require('../../src/lib/loginRedirect.js'));
  });

  const employee = { id: 'emp-1', name: 'Ada', isAdmin: false };
  const admin = { id: 'adm-1', name: 'Admin', isAdmin: true };

  describe('A. Role fallback (manual login has no `from`)', () => {
    test('A1. employee + no `from` → /portal/dashboard', () => {
      expect(resolveLanding(undefined, employee)).toBe('/portal/dashboard');
    });

    test('A2. admin + no `from` → /portal/admin', () => {
      expect(resolveLanding(undefined, admin)).toBe('/portal/admin');
    });

    test('A3. employee + null `from` → /portal/dashboard', () => {
      expect(resolveLanding(null, employee)).toBe('/portal/dashboard');
    });

    test('A4. employee + non-object `from` (string) → fallback', () => {
      // Defensive — router state can be hand-crafted in dev tools.
      expect(resolveLanding('/portal/dpr/my', employee)).toBe('/portal/dashboard');
    });

    test('A5. no employee → /portal/dashboard (unauthenticated manual nav)', () => {
      expect(resolveLanding(undefined, undefined)).toBe('/portal/dashboard');
    });
  });

  describe('B. Portal-path-only guard', () => {
    test('B1. attacker-supplied `from` pointing at "//evil.com" → fallback', () => {
      // An attacker who can inject router state MUST NOT be able to
      // navigate() the user to an external origin. Note: react-router
      // navigate('//evil.com') is treated as a protocol-relative URL
      // and would redirect off-site — so we must collapse it to the
      // safe fallback.
      expect(resolveLanding({ pathname: '//evil.com' }, employee)).toBe('/portal/dashboard');
    });

    test('B2. attacker-supplied `from` pointing at "/" → fallback', () => {
      expect(resolveLanding({ pathname: '/' }, employee)).toBe('/portal/dashboard');
    });

    test('B3. attacker-supplied `from` pointing at "/login" → fallback', () => {
      expect(resolveLanding({ pathname: '/login' }, employee)).toBe('/portal/dashboard');
    });

    test('B4. `from` with non-string pathname → fallback', () => {
      expect(resolveLanding({ pathname: 42 }, employee)).toBe('/portal/dashboard');
      expect(resolveLanding({ pathname: null }, employee)).toBe('/portal/dashboard');
      expect(resolveLanding({}, employee)).toBe('/portal/dashboard');
    });
  });

  describe('C. Auth-loop guard', () => {
    test('C1. `from` === /portal/login → fallback (avoids bounce loop)', () => {
      expect(resolveLanding({ pathname: '/portal/login' }, employee)).toBe('/portal/dashboard');
      expect(resolveLanding({ pathname: '/portal/login' }, admin)).toBe('/portal/admin');
    });
  });

  describe('D. Honor `from` for portal paths', () => {
    test('D1. /portal/dpr/my → /portal/dpr/my', () => {
      expect(resolveLanding({ pathname: '/portal/dpr/my' }, employee)).toBe('/portal/dpr/my');
    });

    test('D2. /portal/inspection/:id → /portal/inspection/:id (parametric)', () => {
      expect(resolveLanding({ pathname: '/portal/inspection/insp-abc' }, employee))
        .toBe('/portal/inspection/insp-abc');
    });

    test('D3. /portal/training/:id for an admin → /portal/training/:id', () => {
      // Admin visiting a deep training link from an email still bounces
      // to that record, not to /portal/admin (the role landing would
      // be wrong for "click → see specific record" flow).
      expect(resolveLanding({ pathname: '/portal/training/te-7' }, admin))
        .toBe('/portal/training/te-7');
    });

    test('D4. trailing-slash normalization: /portal/admin/ → /portal/admin', () => {
      expect(resolveLanding({ pathname: '/portal/admin/' }, employee))
        .toBe('/portal/admin');
    });
  });

  describe('E. Search-round-trip (deep links)', () => {
    test('E1. /portal/dpr/all + ?id=dpr-123 → /portal/dpr/all?id=dpr-123', () => {
      // The canonical DR-015 acceptance: clicking an email CTA while
      // logged out opens the DPR detail modal on the list page after
      // sign-in. The path stays /portal/dpr/all; the id rides along
      // as a query param so DprAll.jsx can read it via useSearchParams
      // and open the detail modal.
      expect(resolveLanding(
        { pathname: '/portal/dpr/all', search: '?id=dpr-123' },
        employee,
      )).toBe('/portal/dpr/all?id=dpr-123');
    });

    test('E2. /portal/notifications/preferences + ?tab=email → round-trips', () => {
      expect(resolveLanding(
        { pathname: '/portal/notifications/preferences', search: '?tab=email' },
        admin,
      )).toBe('/portal/notifications/preferences?tab=email');
    });

    test('E3. empty search → no trailing "?"', () => {
      // HashRouter captures pathname only when there were no params;
      // we must not introduce a stray "?".
      expect(resolveLanding(
        { pathname: '/portal/dashboard', search: '' },
        employee,
      )).toBe('/portal/dashboard');
    });
  });
});
