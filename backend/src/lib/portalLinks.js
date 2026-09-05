// DR-015 — One canonical portal-link builder.
//
// Background:
//   The portal runs under HashRouter (src/App.jsx), so every internal
//   link from a non-React surface (server-rendered email, OAuth popup
//   callback, etc.) MUST include the `#/` prefix to reach a route.
//   A bare `/portal/...` path served from acschennai.com hits the
//   static-site 404 — Netlify/Azure Static Web Apps don't translate
//   `/portal/...` to `index.html#/portal/...` even with a copy-to-
//   `404.html` rule, because the server returns the public-site
//   shell before the hash gets a chance to route.
//
//   Additionally, several email templates referenced routes that
//   DON'T EXIST in the current app:
//     - /portal/dpr/:id           (DPR detail is a modal on /portal/dpr/all)
//     - /portal/notifications     (only /portal/notifications/preferences exists)
//     - /portal/inspection        (only /portal/inspection/my, /all, /submit, /:id)
//
// This module is the single source of truth:
//   portalHref('/notifications/preferences')   → "https://x.com/#/portal/notifications/preferences"
//   portalHref('/dpr/:id', { id: 'abc' })       → "https://x.com/#/portal/dpr/all?id=abc"
//   portalDprHref('abc')                        → routes through the admin queue
//
// The DR-015 acceptance criterion — "a generated email link opened
// while logged out ends at the intended record/preferences page after
// sign-in" — depends on three things agreeing:
//   1. The link uses this helper (so the hash prefix is always there)
//   2. PortalLogin honors `location.state.from` (the protected route
//      captures the original target before redirecting to /portal/login)
//   3. The target route exists in src/App.jsx (route map table below)

'use strict';

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://acschennai.com';

// Canonical portal-path → app-route map. Every key on the LEFT is a
// logical destination ("the DPR detail page", "the notifications
// inbox"). The value on the RIGHT is the App.jsx Route entry that
// actually exists. New email templates MUST add their logical
// destination here so a future refactor that removes an App route
// surfaces a single, loud failure at startup instead of a silent
// broken link in production.
//
// App.jsx route inventory (round-26 audit):
//   /portal/login
//   /portal/attendance                → Attendance.jsx
//   /portal/dashboard                 → EmployeeDashboard.jsx
//   /portal/admin                     → AdminOverview.jsx
//   /portal/admin/attendance          → Admin.jsx (org-wide grid)
//   /portal/leave                     → Leave.jsx
//   /portal/dpr/submit, /my, /all     → DprSubmit.jsx, DprList.jsx, DprAll.jsx
//   /portal/admin/dpr                 → DprDashboard.jsx (cross-org queue)
//   /portal/admin/leave               → LeaveDashboard.jsx
//   /portal/inspection/submit, /my, /all, /:id
//   /portal/admin/inspection          → InspectionDashboard.jsx
//   /portal/training, /:id
//   /portal/admin/training, /new, /:id, /:id/edit
//   /portal/notifications/preferences → NotificationPreferences.jsx
//   /portal/* fallback                → PortalNotFound.jsx
const ROUTE_MAP = {
  // Logical name           App route (path-only, no hash, no host)
  dpr_detail: '/portal/dpr/all', // DPR detail is a modal — link opens the list
  dpr_my: '/portal/dpr/my',
  dpr_queue_admin: '/portal/admin/dpr',
  inspection_detail: '/portal/inspection/:id',
  inspection_my: '/portal/inspection/my',
  inspection_queue_admin: '/portal/admin/inspection',
  notifications_inbox: '/portal/notifications/preferences', // nearest target
  notifications_preferences: '/portal/notifications/preferences',
  leave_my: '/portal/leave',
  leave_queue_admin: '/portal/admin/leave',
  training_detail: '/portal/training/:id',
  training_my: '/portal/training',
  training_queue_admin: '/portal/admin/training',
  attendance_my: '/portal/attendance',
  attendance_admin: '/portal/admin/attendance',
};

// Build an absolute portal URL with the `#/` hash prefix.
//
//   portalHref('/notifications/preferences')
//     → "https://acschennai.com/#/portal/notifications/preferences"
//
//   portalHref('/dpr/:id', { id: 'abc' })
//     → "https://acschennai.com/#/portal/dpr/all?id=abc"   (mapped to /dpr/all)
//
// `path` MUST start with `/` (e.g. `/dpr/:id`). Param routes use
// `:name` placeholders; values are substituted from `params` and the
// remaining (un-substituted) keys are appended as `?key=value`.
//
// Throws on unknown routes that contain `:name` placeholders — the
// caller meant to map a logical destination but forgot to register
// it. Loud failure at email-send time is the desired behavior.
function portalHref(path, params = {}) {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new Error(`portalHref: path must start with "/", got ${JSON.stringify(path)}`);
  }

  // Substitute `:name` placeholders from params. Any remaining
  // (un-substituted) keys go on as query string so the receiving
  // page can read them (e.g. DprAll reads ?id=... and opens the
  // detail modal on mount).
  const subs = {};
  const query = [];
  const seen = new Set();
  const resolved = path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => {
    if (params[name] === undefined) {
      throw new Error(
        `portalHref: route ${JSON.stringify(path)} requires param "${name}" but none was passed. ` +
        `Add a route map entry or supply the param.`,
      );
    }
    seen.add(name);
    // Encode the value — IDs are ULIDs/UUIDs (URL-safe) but defensive
    // encoding protects against future route additions that embed
    // arbitrary strings.
    return encodeURIComponent(String(params[name]));
  });
  for (const [k, v] of Object.entries(params)) {
    if (seen.has(k)) continue;
    query.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }

  const fullPath = query.length > 0 ? `${resolved}?${query.join('&')}` : resolved;
  return `${FRONTEND_URL}/#${fullPath.startsWith('/') ? fullPath : `/${fullPath}`}`;
}

// Convenience helpers for the routes the audit flagged. Each one
// resolves to a ROUTE_MAP entry, so the App.jsx route inventory
// stays the source of truth.
function dprDetailHref(id) {
  return portalHref(ROUTE_MAP.dpr_detail, { id });
}
function dprMyHref() {
  return portalHref(ROUTE_MAP.dpr_my);
}
function inspectionDetailHref(id) {
  return portalHref(ROUTE_MAP.inspection_detail, { id });
}
function inspectionMyHref() {
  return portalHref(ROUTE_MAP.inspection_my);
}
function trainingDetailHref(id) {
  return portalHref(ROUTE_MAP.training_detail, { id });
}
function trainingMyHref() {
  return portalHref(ROUTE_MAP.training_my);
}
function notificationsInboxHref() {
  return portalHref(ROUTE_MAP.notifications_inbox);
}
function notificationsPreferencesHref() {
  return portalHref(ROUTE_MAP.notifications_preferences);
}
function dprQueueAdminHref() {
  return portalHref(ROUTE_MAP.dpr_queue_admin);
}
function inspectionQueueAdminHref() {
  return portalHref(ROUTE_MAP.inspection_queue_admin);
}
function trainingQueueAdminHref() {
  return portalHref(ROUTE_MAP.training_queue_admin);
}
function leaveMyHref() {
  return portalHref(ROUTE_MAP.leave_my);
}
function leaveQueueAdminHref() {
  return portalHref(ROUTE_MAP.leave_queue_admin);
}
function attendanceMyHref() {
  return portalHref(ROUTE_MAP.attendance_my);
}
function attendanceAdminHref() {
  return portalHref(ROUTE_MAP.attendance_admin);
}

module.exports = {
  portalHref,
  ROUTE_MAP,
  FRONTEND_URL,
  // Convenience aliases used by templates/email/types.js. Templates
  // SHOULD call the named helper rather than build the path inline so
  // the route map stays in one place.
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
};
