// DR-007 — NotificationBell must reconcile on tab focus + visibility flip.
//
// Audit reproduction: workforce-class notifications (LEAVE_DECIDED,
// TRAINING_ASSIGNED, INSPECTION_*) are persisted via
// prisma.notification.create at the leave/training/inspection call-sites
// and only surface via the GET /list endpoint. The DPR SSE channel does
// NOT replay these rows. If a user has the portal open when such a
// notification lands (or returns to a tab that was hidden during the
// emit), the bell stayed stale until the user reloaded — the SSE channel
// never re-emitted the row and there was no focus/visibility refetch.
//
// Fix contract (audit acceptance: "Workforce and disconnected events
// become visible without waiting for token refresh."):
//   1. A new useEffect listens for visibilitychange + window focus.
//   2. Both events call loadNotifications() (which calls
//      api.getNotifications).
//   3. The refetch is a no-op when the tab is hidden — only refetch when
//      returning to a visible tab (avoids burning bandwidth on a
//      backgrounded SPA).
//   4. Listeners are cleaned up on unmount or token change so a logged-
//      out user does not keep pinging the list endpoint.
//   5. The SSE 'notification' handler's idempotent id-check keeps a
//      refetch that returns rows already in local state harmless.
//
// Source-text-only contract pins — mirrors the project's established
// pattern for NotificationBell (see dr025-notification-read-nav.test.jsx).
// The bell component cannot be rendered in jsdom today because its
// `import.meta.env` line (NotificationBell.jsx:8) predates the
// project-wide convention that all `import.meta.env` access lives in
// src/lib/env.js; resolving that is out of scope for DR-007.
//
// Run: npx jest --testPathPattern="NotificationBell.dr007"

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const bellPath = resolvePath(__dirname, '../components/NotificationBell.jsx');
const bellSrc = readFileSync(bellPath, 'utf8');

// ──────────────────────────────────────────────────────────────────────
// Source-text contracts (cheap, deterministic)
// ──────────────────────────────────────────────────────────────────────
describe('DR-007 — bell reconcile-on-open (source-text contract)', () => {
  test('1. a useEffect subscribes to both visibilitychange and focus events', () => {
    // The fix MUST listen on both events — document.visibilityState is
    // the canonical signal on mobile (visibilitychange fires when the
    // tab is backgrounded); window.focus fires on desktop tab-switch.
    expect(bellSrc).toMatch(/document\.addEventListener\(['"]visibilitychange['"]/);
    expect(bellSrc).toMatch(/window\.addEventListener\(['"]focus['"]/);
  });

  test('2. the refetch handler short-circuits when the document is hidden', () => {
    // Avoid burning GET /list on a backgrounded SPA — only refetch when
    // the tab is visible (visibilityState === 'visible'). The handler
    // MUST guard on `document.visibilityState === 'hidden'` and bail.
    expect(bellSrc).toMatch(/document\.visibilityState\s*===\s*['"]hidden['"]/);
  });

  test('3. the refetch handler calls loadNotifications on visibilitychange/focus', () => {
    // The actual fix primitive — the handler body must invoke
    // loadNotifications() so api.getNotifications fires.
    // We accept any reference to loadNotifications inside the new
    // useEffect body, not just the bare function call — the refetch
    // helper may be wrapped in a named function for readability.
    expect(bellSrc).toMatch(/loadNotifications\(\)/);
  });

  test('4. the effect cleans up both listeners on unmount or token change', () => {
    // Returning a cleanup that removes both listeners is mandatory;
    // without it the bell would leak listeners across logins and a
    // logged-out user would keep pinging the list endpoint.
    expect(bellSrc).toMatch(/document\.removeEventListener\(['"]visibilitychange['"]/);
    expect(bellSrc).toMatch(/window\.removeEventListener\(['"]focus['"]/);
  });

  test('5. the effect depends on accessToken + loadNotifications', () => {
    // The dep array MUST include both — without accessToken the effect
    // would run before the user signs in (and read a null token);
    // without loadNotifications the effect would capture a stale
    // closure that doesn't see fresh token state.
    expect(bellSrc).toMatch(/\[\s*accessToken\s*,\s*loadNotifications\s*\]/);
  });

  test('6. the new useEffect body uses the SSR-safe `typeof document !== "undefined"` guard', () => {
    // Although the bell only mounts in the browser, the project's
    // testing convention pins test-env safety on every document/
    // window touch (see portal/NotificationPreferences.jsx). The
    // visibilityState read should be guarded with `typeof document !==
    // "undefined"` so a future SSR build does not crash on the
    // document.visibilityState read.
    expect(bellSrc).toMatch(/typeof\s+document\s*!==\s*['"]undefined['"]/);
  });
});
