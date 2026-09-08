// DR-025 (audit, 2026-09-08) — Notifications are delivered, but read /
// navigation handoffs are incomplete.
//
// Audit findings:
//   1. Clicking a "DPR rejected" notification navigated to
//      /portal/dpr/my with location.state.selectedDprId, but the
//      destination page never consumed that state. The list rendered
//      as if nothing happened (no modal opening).
//   2. Individual reads were optimistic-only — the server still
//      considered the row unread, so the next /list returned
//      isRead: false and the badge never converged.
//   3. The notification payload carried `dprId` but no typed
//      `targetType` / `targetId` for INSPECTION / LEAVE / TRAINING
//      events (audit says navigation was incomplete because the
//      target types were not enumerated in the typed payload).
//
// Source-text contracts pin:
//   - DprList reads location.state.selectedDprId and opens the modal
//     in a useEffect (mirroring NotificationBell's navigate pattern).
//   - Backend exposes PUT /notifications/:notifId/read with owner scope
//     and idempotency.
//   - SPA api.js wires a markNotificationRead(notifId, token) method.
//   - NotificationBell persists the read via the new endpoint and
//     rolls back the optimistic flip on failure.
//
// Run: cd src && npx jest __tests__/dr025-notification-read-nav.test.jsx
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const dprListPath = resolvePath(__dirname, '../pages/portal/DprList.jsx');
const apiPath = resolvePath(__dirname, '../lib/api.js');
const bellPath = resolvePath(__dirname, '../components/NotificationBell.jsx');
const dprBackendPath = resolvePath(__dirname, '../../backend/src/routes/dpr.js');

const dprListSrc = readFileSync(dprListPath, 'utf8');
const apiSrc = readFileSync(apiPath, 'utf8');
const bellSrc = readFileSync(bellPath, 'utf8');
const dprBackendSrc = readFileSync(dprBackendPath, 'utf8');

describe('DR-025 — notification read / nav handoff (SPA)', () => {
  test('1. DprList imports useLocation to consume notification state', () => {
    expect(dprListSrc).toMatch(/import\s*\{[^}]*useLocation[^}]*\}\s*from\s*['"]react-router-dom['"]/);
  });

  test('2. DprList reads location.state.selectedDprId and triggers handleRowClick', () => {
    // Single-source-of-truth pin: the consumer must call handleRowClick
    // with the resolved id so the modal opens with the same code path
    // as a normal row click.
    expect(dprListSrc).toMatch(/const\s+selectedDprId\s*=\s*location\.state\?\.selectedDprId/);
    expect(dprListSrc).toMatch(/handleRowClick\(\{\s*id:\s*selectedDprId\s*\}\)/);
    // And the effect dep array must include the state key so a
    // subsequent notification click (after a re-mount) re-triggers it.
    expect(dprListSrc).toMatch(/location\.state\?\.selectedDprId/);
  });

  test('3. DprList clears the location state after consuming so a refresh / back-forward does not re-fire', () => {
    expect(dprListSrc).toMatch(/navigate\(location\.pathname\s*\+\s*location\.search,\s*\{\s*replace:\s*true,\s*state:\s*null\s*\}\)/);
  });

  test('4. api.js exposes markNotificationRead(notifId, token)', () => {
    expect(apiSrc).toMatch(/markNotificationRead:\s*\(notifId,\s*token\)/);
    expect(apiSrc).toMatch(/api\.put\(`\/dpr\/notifications\/\$\{notifId\}\/read`,\s*\{\},\s*token\)/);
  });

  test('5. NotificationBell persists the read via api.markNotificationRead', () => {
    expect(bellSrc).toMatch(/api\.markNotificationRead\(notif\.id,\s*accessToken\)/);
    // Optimistic update is preserved for snappy UI.
    expect(bellSrc).toMatch(/isRead:\s*true/);
    // On failure we roll the optimistic flip back so the badge is honest.
    expect(bellSrc).toMatch(/isRead:\s*false/);
  });

  test('6. NotificationBell hands the typed target (dprId) to the destination', () => {
    expect(bellSrc).toMatch(/navigate\(['"]\/portal\/dpr\/my['"],\s*\{\s*state:\s*\{\s*selectedDprId:\s*notif\.dprId\s*\}\s*\}\)/);
  });
});

describe('DR-025 — notification read / nav handoff (backend)', () => {
  test('7. PUT /notifications/:notifId/read is registered on the dpr router', () => {
    expect(dprBackendSrc).toMatch(/router\.put\(['"]\/notifications\/:notifId\/read['"]/);
  });

  test('8. The endpoint enforces owner scope (employeeId === req.employeeId)', () => {
    // 403 when the row's owner differs from req.employeeId — prevents
    // users from marking each other's notifications as read.
    expect(dprBackendSrc).toMatch(/if\s*\(\s*existing\.employeeId\s*!==\s*req\.employeeId\s*\)/);
    expect(dprBackendSrc).toMatch(/403/);
  });

  test('9. The endpoint is idempotent — re-marking a read row is a 200 no-op', () => {
    expect(dprBackendSrc).toMatch(/existing\.isRead\s*\?\s*existing/);
  });

  test('10. The endpoint 404s on an unknown notification id', () => {
    // findUnique → null → 404 — never expose existence of another
    // user's notifications by varying the response.
    expect(dprBackendSrc).toMatch(/if\s*\(\s*!existing\s*\)\s*\{[\s\S]{0,200}?status\(404\)/);
  });
});
