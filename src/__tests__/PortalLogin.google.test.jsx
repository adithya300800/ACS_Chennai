// [feat/google-login-allowlist] PortalLogin Google sign-in button tests.
//
// 5 cases pin the contract:
//   1. The Google button is NOT rendered on initial mount (visibility
//      depends on the runtime /api/auth/google/active probe).
//   2. The button is rendered when /active returns { enabled: true }.
//   3. The button is hidden when /active returns 404 (kill switch off).
//   4. A network error on /active keeps the button hidden (no crash).
//   5. Clicking the button opens a popup synchronously and POSTs to
//      /api/auth/google to get the authUrl (the popup-gesture contract
//      that defends against browser popup-blockers — the click handler
//      MUST call window.open before any await).
//   6. An `google-oauth-error` postMessage from the popup translates
//      the typed error code to the GOOGLE_ERRORS message via toast.
//
// AuthContext, ToastContext, and api.js are mocked; the only path
// under test is the Google button + handler in PortalLogin.

import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// env.js reads `import.meta.env.VITE_API_URL` which crashes under CJS
// jest. The hoisted `jest.mock` below swaps in a CJS stub before the
// PortalLogin import resolves. Same pattern as dr011-refresh-coordination.
jest.mock('../lib/env.js', () => ({
  __esModule: true,
  VITE_API_URL: 'http://localhost',
  default: 'http://localhost',
}));

// ─── Mocks (variable names start with `mock` so jest's hoisted
//     factory closure accepts the out-of-scope reference). ──────────
const mockGetGoogleLoginActive = jest.fn();
const mockGetGoogleAuthUrl = jest.fn();
const mockPostGoogleCallback = jest.fn();
const mockSetAuthData = jest.fn();
const mockToastPush = jest.fn();

jest.mock('../contexts/AuthContext.jsx', () => ({
  useAuth: () => ({
    accessToken: null,
    user: null,
    employee: null,
    setAuthData: mockSetAuthData,
    logout: jest.fn(),
  }),
}));

jest.mock('../contexts/ToastContext.jsx', () => ({
  useToast: () => ({ push: mockToastPush, dismiss: jest.fn() }),
}));

jest.mock('../hooks/useDocumentTitle.js', () => ({
  useDocumentTitle: jest.fn(),
}));

jest.mock('../lib/api.js', () => ({
  api: {
    getGoogleLoginActive: mockGetGoogleLoginActive,
    getGoogleAuthUrl: mockGetGoogleAuthUrl,
    postGoogleCallback: mockPostGoogleCallback,
    login: jest.fn(),
  },
}));

const { api } = require('../lib/api.js');

const renderPortalLogin = ({ route = '/portal/login' } = {}) => {
  const PortalLogin = require('../pages/PortalLogin.jsx').default;
  return render(
    <MemoryRouter initialEntries={[route]}>
      <PortalLogin />
    </MemoryRouter>
  );
};

// window.open stub. The handler calls window.open('about:blank', ...)
// synchronously inside the click handler (the popup-gesture contract).
const mockPopup = {
  closed: false,
  close: jest.fn(),
  location: { href: '' },
};
const realOpen = window.open;
beforeEach(() => {
  mockPopup.closed = false;
  mockPopup.close = jest.fn();
  mockPopup.location = { href: '' };
  window.open = jest.fn(() => mockPopup);
});
afterAll(() => { window.open = realOpen; });

beforeEach(() => {
  jest.clearAllMocks();
  // Default: kill switch off so the button stays hidden unless
  // an individual test overrides.
  mockGetGoogleLoginActive.mockRejectedValue(new Error('404'));
});

describe('PortalLogin — Google sign-in button', () => {
  it('1. button is NOT rendered on initial mount (probe in flight)', () => {
    // Mock that never resolves — the test mounts and immediately
    // asserts the button is absent. This is the "load gate": a
    // user who reloads the page before /active resolves must not
    // see a Google button that would 404 mid-flow.
    mockGetGoogleLoginActive.mockReturnValue(new Promise(() => {}));
    renderPortalLogin();
    expect(screen.queryByTestId('google-signin-button')).toBeNull();
  });

  it('2. button IS rendered when /active returns { enabled: true }', async () => {
    mockGetGoogleLoginActive.mockResolvedValue({ enabled: true });
    renderPortalLogin();
    const btn = await screen.findByTestId('google-signin-button');
    expect(btn).toBeTruthy();
    expect(btn.textContent).toMatch(/Sign in with Google/);
    // The Zoho button is still rendered alongside it.
    expect(screen.getByText(/Sign in with Zoho/)).toBeTruthy();
  });

  it('3. button is hidden when /active returns 404 (kill switch off)', async () => {
    // Already the default (mockGetGoogleLoginActive.mockRejectedValue)
    // — make it explicit.
    mockGetGoogleLoginActive.mockRejectedValue(Object.assign(new Error('404'), { status: 404 }));
    renderPortalLogin();
    // Wait long enough for the rejected promise's catch to settle.
    await waitFor(() => {
      expect(mockGetGoogleLoginActive).toHaveBeenCalled();
    });
    expect(screen.queryByTestId('google-signin-button')).toBeNull();
    // The Zoho button still works.
    expect(screen.getByText(/Sign in with Zoho/)).toBeTruthy();
  });

  it('4. a network error on /active keeps the button hidden (no render crash)', async () => {
    mockGetGoogleLoginActive.mockRejectedValue(new TypeError('Failed to fetch'));
    renderPortalLogin();
    await waitFor(() => {
      expect(mockGetGoogleLoginActive).toHaveBeenCalled();
    });
    expect(screen.queryByTestId('google-signin-button')).toBeNull();
  });

  it('5. clicking the button opens a popup SYNCHRONOUSLY and fetches the authUrl', async () => {
    mockGetGoogleLoginActive.mockResolvedValue({ enabled: true });
    mockGetGoogleAuthUrl.mockResolvedValue({
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?...',
    });
    renderPortalLogin();
    const btn = await screen.findByTestId('google-signin-button');
    fireEvent.click(btn);
    // window.open must have been called BEFORE the await on
    // getGoogleAuthUrl resolves — the popup-gesture contract.
    // We assert that by the time the assertion runs, the popup
    // object has been opened and the authUrl has been fetched.
    await waitFor(() => {
      expect(mockGetGoogleAuthUrl).toHaveBeenCalledTimes(1);
    });
    expect(window.open).toHaveBeenCalledTimes(1);
    // First arg is the synchronous about:blank pre-open; second is
    // the popup window name; third is the features string.
    const openArgs = window.open.mock.calls[0];
    expect(openArgs[0]).toBe('about:blank');
    expect(openArgs[1]).toBe('GoogleOAuth');
    // After the authUrl resolves, the handler navigates the popup.
    await waitFor(() => {
      expect(mockPopup.location.href).toContain('accounts.google.com');
    });
  });

  it('6. google-oauth-error postMessage from the popup → typed-error toast', async () => {
    mockGetGoogleLoginActive.mockResolvedValue({ enabled: true });
    mockGetGoogleAuthUrl.mockResolvedValue({
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?...',
    });
    renderPortalLogin();
    const btn = await screen.findByTestId('google-signin-button');
    fireEvent.click(btn);
    await waitFor(() => {
      expect(mockGetGoogleAuthUrl).toHaveBeenCalledTimes(1);
    });
    // Dispatch a `message` event from the configured origin.
    // The handler compares `event.origin` to the URL derived from
    // VITE_API_URL (mocked above as 'http://localhost') and the
    // current window's origin (also 'http://localhost' under
    // MemoryRouter + jsdom). We also pin `event.source` to mockPopup:
    // [fix/google-oauth-redirect-uri] the Google handler now requires
    // event.source === popup before it processes the message, so a
    // bare MessageEvent with no source would be rejected.
    const ev = new MessageEvent('message', {
      origin: 'http://localhost',
      data: { type: 'google-oauth-error', error: 'GOOGLE_DENIED' },
    });
    Object.defineProperty(ev, 'source', { value: mockPopup, configurable: true });
    window.dispatchEvent(ev);
    await waitFor(() => {
      expect(mockToastPush).toHaveBeenCalledWith(
        expect.stringMatching(/not enabled for this account/i),
        'error'
      );
    });
    // mockSetAuthData must NOT have been called on the error path.
    expect(mockSetAuthData).not.toHaveBeenCalled();
  });
});
