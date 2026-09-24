// DR-006 — failed baseline load MUST NOT silently enable a save that
// overwrites the user's saved opt-outs / type mutes with placeholder defaults.
//
// Audit reproduction: when the initial GET to /api/notifications/preferences
// fails, the previous page mounted with the in-memory default prefs
// (emailEnabled:true, digestEnabled:true, digestHourLocal:8, typeMutes:{}).
// `baselineRef.current` was ALSO initialized to that same JSON-stringified
// default, so the dirty check `JSON.stringify(prefs) !== baselineRef.current`
// was false at mount. The user could then tweak the hour field from 8 → 9
// and the dirty check would flip true, enabling Save — which PUT an
// emailEnabled:true / digestEnabled:true / clean typeMutes over whatever
// their actual saved opt-outs and mutes were.
//
// Fix contract (audit acceptance: "Failed GET + attempted hour change
// cannot silently enable mail or clear mutes. A successful retry restores
// the actual saved baseline before editing."):
//   1. A distinct `baselineLoaded` state gates the Save button.
//   2. On baseline failure: Save stays disabled, an inline error + Retry
//      affordance surfaces, and a subsequent hour change does NOT trigger
//      a PUT.
//   3. On baseline success: prefs populate from the real server payload
//      AND Save becomes editable per the existing dirty-check rules.
//
// Run: cd src && npx jest --testPathPattern="NotificationPreferences.dr006"

import React from 'react';
import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// Source-text read for the contract pins (cheaper + deterministic than
// full RTL renders; covers the load-bearing edits).
const pagePath = resolvePath(__dirname, '../pages/portal/NotificationPreferences.jsx');
const pageSrc = readFileSync(pagePath, 'utf8');

// ──────────────────────────────────────────────────────────────────────
// Source-text contracts (cheap, deterministic)
// ──────────────────────────────────────────────────────────────────────
describe('DR-006 — baselineLoaded gate (source-text contract)', () => {
  test('1. distinct baselineLoaded state exists and is initialised to false', () => {
    // A Boolean held in state is the load-bearing primitive for the
    // fix. Without it, the Save button sees no signal that the page
    // has a real baseline (vs the placeholder default).
    expect(pageSrc).toMatch(/useState\(false\)/);
    expect(pageSrc).toMatch(/baselineLoaded/);
  });

  test('2. the initial GET flips baselineLoaded=true on success', () => {
    // The success branch of the load effect MUST mark the baseline
    // loaded. Without this line the Save button stays gated forever.
    expect(pageSrc).toMatch(/setBaselineLoaded\(true\)/);
  });

  test('3. the initial GET failure path flips baselineLoaded=false AND records loadFailed', () => {
    // The failure branch must keep baselineLoaded=false AND surface
    // loadFailed so the page renders the inline error + Retry.
    expect(pageSrc).toMatch(/setBaselineLoaded\(false\)/);
    expect(pageSrc).toMatch(/setLoadFailed\(true\)/);
  });

  test('4. Save button is gated on baselineLoaded', () => {
    // The disabled expression must include the baselineLoaded guard
    // so a missing baseline truly blocks submission.
    expect(pageSrc).toMatch(/disabled=\{saving\s*\|\|\s*!anyDirty\s*\|\|\s*!baselineLoaded\}/);
  });

  test('5. inline error banner carries role=alert + aria-live + Retry button', () => {
    // The page must surface the failure so the user knows the form is
    // placeholder defaults, not their saved baseline.
    expect(pageSrc).toMatch(/role="alert"/);
    expect(pageSrc).toMatch(/aria-live="polite"/);
    expect(pageSrc).toMatch(/notification-pref-retry-btn/);
    // Retry must re-invoke the load (not just setLoading(true) — the GET
    // has to actually run again or the page stays blank).
    expect(pageSrc).toMatch(/onClick=\{?\(\)\s*=>\s*\{\s*setLoading\(true\);\s*loadPrefs\(\);\s*\}\}?/);
  });

  test('6. loadPrefs is extracted as a reusable callback so Retry can re-fire the GET', () => {
    // The original useEffect was a one-shot IIFE; Retry had no handle
    // to re-run the load. The fix pulls it into a useCallback.
    expect(pageSrc).toMatch(/const\s+loadPrefs\s*=\s*React\.useCallback/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Behaviour tests (RTL — exercise the actual wiring)
// ──────────────────────────────────────────────────────────────────────
const mockGetNotificationPreferences = jest.fn();
const mockUpdateNotificationPreferences = jest.fn();

jest.mock('../lib/api.js', () => ({
  api: {
    getNotificationPreferences: (...args) => mockGetNotificationPreferences(...args),
    updateNotificationPreferences: (...args) => mockUpdateNotificationPreferences(...args),
    sendTestEmail: jest.fn(),
  },
}));

jest.mock('../contexts/AuthContext.jsx', () => ({
  useAuth: () => ({
    accessToken: 'test-token',
    employee: { isAdmin: false },
  }),
}));

// Stable push reference — mirrors the real ToastContext's useCallback.
// Without this, the mock would return a new jest.fn() every render and
// thrash the [token, push] dep on the page's useCallback(loadPrefs),
// which in turn re-fires the useEffect cleanup (cancelling every load).
const mockPush = jest.fn();
jest.mock('../contexts/ToastContext.jsx', () => ({
  useToast: () => ({ push: mockPush }),
}));

jest.mock('../hooks/useDocumentTitle.js', () => ({
  useDocumentTitle: jest.fn(),
}));

const renderPrefs = () => {
  const NotificationPreferences = require('../pages/portal/NotificationPreferences.jsx').default;
  return render(<NotificationPreferences />);
};

beforeEach(() => {
  mockGetNotificationPreferences.mockReset();
  mockUpdateNotificationPreferences.mockReset();
  // Default: never let a PUT go through; tests that want it will
  // explicitly opt in via mockUpdateNotificationPreferences.mockResolvedValueOnce.
  mockUpdateNotificationPreferences.mockResolvedValue({
    preferences: { emailEnabled: true, digestEnabled: true, digestHourLocal: 8, typeMutes: {} },
  });
});

describe('DR-006 — baseline-gate behaviour (RTL)', () => {
  test('7. failed-GET-keeps-save-disabled: Save button stays disabled when the initial GET fails', async () => {
    mockGetNotificationPreferences.mockRejectedValueOnce(new Error('Network down'));

    renderPrefs();

    // Wait for the load effect to settle — error banner surfaces,
    // Save button is in the tree (since `loading` flips false on
    // failure too), but disabled.
    await waitFor(() => screen.getByRole('alert'));
    const saveBtn = screen.getByRole('button', { name: /save preferences/i });
    expect(saveBtn).toBeDisabled();

    // Hammer the audit's exact bypass attempt: even after an hour
    // change, Save stays disabled. The hour select's `<select>` value
    // updates via React state — dirty flips true, but Save must NOT
    // become enabled because baselineLoaded is still false.
    const hourSelect = screen.getByLabelText(/digest delivery hour/i);
    fireEvent.change(hourSelect, { target: { value: '9' } });
    expect(saveBtn).toBeDisabled();

    // Make sure no PUT escaped. A successful save would call
    // api.updateNotificationPreferences; that mock is still
    // untouched (mockResolvedValue is default, but zero calls).
    expect(mockUpdateNotificationPreferences).not.toHaveBeenCalled();
  });

  test('8. success-GET-enables-save: a successful GET populates prefs AND enables Save once the user edits', async () => {
    // Server returns a non-default baseline: email off, a digest hour
    // of 7, and one explicit type mute. The page must adopt that as
    // the dirty baseline.
    mockGetNotificationPreferences.mockResolvedValueOnce({
      preferences: {
        emailEnabled: false,
        digestEnabled: true,
        digestHourLocal: 7,
        typeMutes: { DPR_APPROVED: true },
      },
      types: [
        { type: 'DPR_APPROVED', label: 'DPR approved', channel: 'IMMEDIATE', description: 'desc' },
      ],
    });

    renderPrefs();

    await waitFor(() => screen.getByRole('button', { name: /save preferences/i }));
    const saveBtn = screen.getByRole('button', { name: /save preferences/i });
    // Baseline now matches prefs exactly — nothing has been edited yet.
    expect(saveBtn).toBeDisabled();

    // Edit the hour field. Server baseline is 7, user sets to 12 —
    // baselineLoaded is true, so dirty becomes true, Save is enabled.
    const hourSelect = screen.getByLabelText(/digest delivery hour/i);
    fireEvent.change(hourSelect, { target: { value: '12' } });
    expect(saveBtn).toBeEnabled();
  });

  test('9. retry-after-failure: clicking Retry re-invokes the GET and, on success, unlocks Save', async () => {
    // First GET fails; second GET (Retry) succeeds with the real
    // baseline. The save button must transition disabled → enabled
    // after the retry resolves.
    mockGetNotificationPreferences
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({
        preferences: {
          emailEnabled: true,
          digestEnabled: false,
          digestHourLocal: 14,
          typeMutes: {},
        },
        types: [],
      });

    renderPrefs();

    // First GET failed — alert banner visible, Save disabled.
    await waitFor(() => screen.getByRole('alert'));
    expect(screen.getByRole('button', { name: /save preferences/i })).toBeDisabled();

    // Click Retry — the banner's Retry button. setLoading(true) fires
    // and loadPrefs re-runs, so the page briefly shows the
    // "Loading preferences…" splash before the second GET resolves.
    fireEvent.click(screen.getByRole('button', { name: /^retry$/i }));

    // Wait for the second GET to settle. The Retry button + alert
    // banner vanish once loadFailed flips back to false; the page
    // may sit on the loading splash for a moment, then renders the
    // form again. Wait specifically for the Save button to come back
    // — that's the load-complete signal.
    const saveBtn = await screen.findByRole('button', { name: /save preferences/i });
    // Baseline == prefs (both reflect the just-loaded server payload),
    // so dirty is false → Save disabled until the user edits.
    expect(saveBtn).toBeDisabled();

    // Now an edit unlocks Save — proof baselineLoaded flipped true.
    const hourSelect = screen.getByLabelText(/digest delivery hour/i);
    fireEvent.change(hourSelect, { target: { value: '15' } });
    expect(saveBtn).toBeEnabled();

    // Two GETs landed across the lifecycle.
    expect(mockGetNotificationPreferences).toHaveBeenCalledTimes(2);
  });

  test('10. hour-change-without-baseline-doesnt-submit: a failed baseline + hour change MUST NOT call the PUT endpoint', async () => {
    // Tighter behaviour pin than test 7: even if a test runner somehow
    // missed the disabled attribute, the PUT count MUST stay at zero.
    mockGetNotificationPreferences.mockRejectedValueOnce(new Error('Network down'));

    renderPrefs();
    await waitFor(() => screen.getByRole('alert'));

    const hourSelect = screen.getByLabelText(/digest delivery hour/i);
    fireEvent.change(hourSelect, { target: { value: '10' } });
    fireEvent.change(hourSelect, { target: { value: '11' } });
    fireEvent.change(hourSelect, { target: { value: '12' } });

    // No matter how many toggles the user attempts, ZERO PUTs escaped.
    expect(mockUpdateNotificationPreferences).not.toHaveBeenCalled();
  });

  test('11. success-baseline-submitted-correctly: after a successful load, Save PUTs the user-edited prefs', async () => {
    mockGetNotificationPreferences.mockResolvedValueOnce({
      preferences: {
        emailEnabled: true,
        digestEnabled: true,
        digestHourLocal: 8,
        typeMutes: {},
      },
      types: [],
    });

    renderPrefs();
    await waitFor(() => screen.getByRole('button', { name: /save preferences/i }));

    // Flip digest hour + email off; baseline==loaded, dirty becomes
    // true, Save is enabled, click PUTs the full local prefs.
    fireEvent.change(screen.getByLabelText(/digest delivery hour/i), { target: { value: '17' } });
    // The Email notifications master toggle lives in a <label className="toggle-switch">
    // wrapping a checkbox. getByLabelText matches the aria-label.
    fireEvent.click(screen.getByLabelText(/toggle email notifications/i));

    const saveBtn = screen.getByRole('button', { name: /save preferences/i });
    await waitFor(() => expect(saveBtn).toBeEnabled());

    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(mockUpdateNotificationPreferences).toHaveBeenCalledTimes(1);
    });
    // The first arg is the partial prefs the user intended to send.
    // After the load, baseline { 8, emailEnabled:true } became prefs;
    // two edits above mutated digestHourLocal to 17 and emailEnabled
    // to false. The PUT must carry exactly that, NOT the defaults.
    const sentBody = mockUpdateNotificationPreferences.mock.calls[0][0];
    expect(sentBody.emailEnabled).toBe(false);
    expect(sentBody.digestEnabled).toBe(true);
    expect(sentBody.digestHourLocal).toBe(17);
  });
});
