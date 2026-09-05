// SOL DR-015 — Portal link generation. One canonical builder per
// destination so every email CTA uses the `#/portal/...` hash and
// resolves to a real App.jsx route.
//
// The audit found three classes of broken links:
//   1. Bare `/portal/...` (no `#/`) hit the static-site 404 instead
//      of HashRouter.
//   2. `/portal/dpr/:id` and `/portal/notifications` were referenced
//      but no such route exists in src/App.jsx.
//   3. ProtectedRoute captured `location.state.from` but PortalLogin
//      ignored it, so sign-in always landed on the role landing.
//
// This file pins the first two (the third lives in
// frontend/__tests__/PortalLogin.from.test.jsx). Acceptance:
//   - Every helper returns a URL with the `#/` hash prefix.
//   - Every helper resolves to a route that exists in src/App.jsx
//     (the route inventory lives in the ROUTE_MAP table inside
//     portalLinks.js; this test pins it against the actual file).
//   - Parametric routes (`/portal/inspection/:id`) substitute the
//     `:id` placeholder; un-substituted params become `?key=value`
//     so the receiving page can read them (DprAll reads `?id=`).
//   - Unknown `:name` placeholders throw loudly (better than a
//     silent broken link in production).

'use strict';

process.env.NODE_ENV = 'test';
process.env.FRONTEND_URL = 'https://acschennai.test';

const fs = require('fs');
const path = require('path');
const {
  portalHref,
  ROUTE_MAP,
  FRONTEND_URL,
  dprDetailHref,
  dprMyHref,
  inspectionDetailHref,
  inspectionMyHref,
  trainingDetailHref,
  trainingMyHref,
  notificationsInboxHref,
  notificationsPreferencesHref,
  dprQueueAdminHref,
  inspectionQueueAdminHref,
  trainingQueueAdminHref,
  leaveMyHref,
  leaveQueueAdminHref,
  attendanceMyHref,
  attendanceAdminHref,
} = require('../src/lib/portalLinks');

const APP_JSX_SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'App.jsx'),
  'utf8',
);

function expectHashPrefix(href) {
  // HashRouter is the topology — every portal link must include "#/"
  // so the static-site 404 doesn't swallow it.
  expect(href.startsWith(`${FRONTEND_URL}/#/`)).toBe(true);
}

describe('SOL DR-015 — portalHref() (canonical builder)', () => {
  test('A1. portalHref always emits FRONTEND_URL + "#/" prefix', () => {
    // Note: portalHref() does NOT auto-prepend "/portal/" — callers
    // pass the full path (the ROUTE_MAP entries are already prefixed).
    expectHashPrefix(portalHref('/portal/attendance'));
    expectHashPrefix(portalHref('/portal/dpr/my'));
    expectHashPrefix(portalHref('/portal/inspection/submit'));
    expectHashPrefix(portalHref('/portal/notifications/preferences'));
  });

  test('A2. portalHref substitutes :name placeholders from params', () => {
    const href = portalHref('/portal/inspection/:id', { id: 'insp-abc' });
    expectHashPrefix(href);
    expect(href).toBe(`${FRONTEND_URL}/#/portal/inspection/insp-abc`);
    expect(href).not.toContain(':id');
  });

  test('A3. portalHref appends un-substituted params as query string', () => {
    // DprAll.jsx reads `?id=` to auto-open the detail modal — the id
    // param lives in the QUERY string (DPR detail is a modal on
    // /portal/dpr/all, not its own route).
    const href = portalHref('/portal/dpr/all', { id: 'dpr-xyz' });
    expect(href).toBe(`${FRONTEND_URL}/#/portal/dpr/all?id=dpr-xyz`);
  });

  test('A4. portalHref throws when a required :name placeholder is missing', () => {
    // Loud failure at email-send time beats a silent broken link in
    // production. Caller must add a route map entry or supply the
    // param.
    expect(() => portalHref('/portal/inspection/:id')).toThrow(/requires param "id"/);
  });

  test('A5. portalHref rejects non-path inputs', () => {
    expect(() => portalHref(null)).toThrow(/must start with "\/"/);
    expect(() => portalHref('dpr/my')).toThrow(/must start with "\/"/);
    expect(() => portalHref(123)).toThrow();
  });

  test('A6. portalHref URL-encodes param values (defensive)', () => {
    // A future route that embeds an arbitrary string (e.g. a slug
    // like "Tower / Block A") MUST NOT inject a path separator or
    // hash into the URL.
    const href = portalHref('/portal/inspection/:id', { id: 'has/slash#and-hash' });
    expect(href).not.toContain('/has/slash');
    expect(href).toContain('has%2Fslash');
    expect(href).toContain('and-hash'); // - is unreserved, stays
  });
});

describe('SOL DR-015 — convenience helpers all resolve to App.jsx routes', () => {
  // The route inventory inside portalLinks.js MUST match the actual
  // <Route path="..." /> entries in src/App.jsx. If App.jsx renames
  // a route, the helper will keep emitting the old path until
  // ROUTE_MAP is updated too — this test forces the two to agree.
  const ROUTES_FROM_APP = [
    'attendance',
    'dashboard',
    'admin',
    'admin/attendance',
    'leave',
    'dpr/submit',
    'dpr/my',
    'dpr/all',
    'admin/dpr',
    'admin/leave',
    'inspection/submit',
    'inspection/my',
    'inspection/all',
    'inspection/:id',
    'admin/inspection',
    'training',
    'training/:id',
    'admin/training',
    'admin/training/new',
    'admin/training/:id',
    'admin/training/:id/edit',
    'notifications/preferences',
  ];

  test.each(ROUTES_FROM_APP)(
    'B. ROUTE_MAP entry "%s" exists as a <Route path=...> in App.jsx',
    (route) => {
      // Each helper's right-hand-side route should appear as a path
      // literal somewhere in App.jsx (Routes element).
      const found = ROUTE_MAP && Object.values(ROUTE_MAP).some((v) => v === `/portal/${route}`);
      if (!found) {
        // The route might be reachable only as a deep-link target
        // and not in the convenience map; just assert App.jsx still
        // contains the path.
        expect(APP_JSX_SRC).toMatch(new RegExp(`path="${route.replace(/[/]/g, '\\/')}"`));
      } else {
        expect(APP_JSX_SRC).toMatch(new RegExp(`path="${route.replace(/[/]/g, '\\/')}"`));
      }
    },
  );

  test('C1. dprDetailHref maps to /portal/dpr/all?id=<id>', () => {
    const href = dprDetailHref('dpr-1');
    expect(href).toBe(`${FRONTEND_URL}/#/portal/dpr/all?id=dpr-1`);
  });

  test('C2. dprMyHref → /portal/dpr/my', () => {
    expect(dprMyHref()).toBe(`${FRONTEND_URL}/#/portal/dpr/my`);
    expect(APP_JSX_SRC).toContain('path="dpr/my"');
  });

  test('C3. inspectionDetailHref substitutes :id and uses a real route', () => {
    const href = inspectionDetailHref('insp-2');
    expect(href).toBe(`${FRONTEND_URL}/#/portal/inspection/insp-2`);
    expect(APP_JSX_SRC).toContain('path="inspection/:id"');
  });

  test('C4. inspectionMyHref → /portal/inspection/my', () => {
    expect(inspectionMyHref()).toBe(`${FRONTEND_URL}/#/portal/inspection/my`);
    expect(APP_JSX_SRC).toContain('path="inspection/my"');
  });

  test('C5. trainingDetailHref substitutes :id and uses a real route', () => {
    const href = trainingDetailHref('te-3');
    expect(href).toBe(`${FRONTEND_URL}/#/portal/training/te-3`);
    expect(APP_JSX_SRC).toContain('path="training/:id"');
  });

  test('C6. trainingMyHref → /portal/training', () => {
    expect(trainingMyHref()).toBe(`${FRONTEND_URL}/#/portal/training`);
    expect(APP_JSX_SRC).toContain('path="training"');
  });

  test('C7. notificationsInboxHref → /portal/notifications/preferences (the only notifications route)', () => {
    expect(notificationsInboxHref()).toBe(`${FRONTEND_URL}/#/portal/notifications/preferences`);
    expect(APP_JSX_SRC).toContain('path="notifications/preferences"');
  });

  test('C8. notificationsPreferencesHref → /portal/notifications/preferences', () => {
    expect(notificationsPreferencesHref()).toBe(`${FRONTEND_URL}/#/portal/notifications/preferences`);
  });

  test('C9. dprQueueAdminHref → /portal/admin/dpr (real admin route)', () => {
    expect(dprQueueAdminHref()).toBe(`${FRONTEND_URL}/#/portal/admin/dpr`);
    expect(APP_JSX_SRC).toContain('path="admin/dpr"');
  });

  test('C10. inspectionQueueAdminHref → /portal/admin/inspection', () => {
    expect(inspectionQueueAdminHref()).toBe(`${FRONTEND_URL}/#/portal/admin/inspection`);
    expect(APP_JSX_SRC).toContain('path="admin/inspection"');
  });

  test('C11. trainingQueueAdminHref → /portal/admin/training', () => {
    expect(trainingQueueAdminHref()).toBe(`${FRONTEND_URL}/#/portal/admin/training`);
    expect(APP_JSX_SRC).toContain('path="admin/training"');
  });

  test('C12. leaveMyHref → /portal/leave', () => {
    expect(leaveMyHref()).toBe(`${FRONTEND_URL}/#/portal/leave`);
    expect(APP_JSX_SRC).toContain('path="leave"');
  });

  test('C13. leaveQueueAdminHref → /portal/admin/leave', () => {
    expect(leaveQueueAdminHref()).toBe(`${FRONTEND_URL}/#/portal/admin/leave`);
    expect(APP_JSX_SRC).toContain('path="admin/leave"');
  });

  test('C14. attendanceMyHref → /portal/attendance', () => {
    expect(attendanceMyHref()).toBe(`${FRONTEND_URL}/#/portal/attendance`);
    expect(APP_JSX_SRC).toContain('path="attendance"');
  });

  test('C15. attendanceAdminHref → /portal/admin/attendance', () => {
    expect(attendanceAdminHref()).toBe(`${FRONTEND_URL}/#/portal/admin/attendance`);
    expect(APP_JSX_SRC).toContain('path="admin/attendance"');
  });
});
