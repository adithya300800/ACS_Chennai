// [fix/google-oauth-redirect-uri] postMessage origin-allowlist + event.source
// tests for the Google handler, plus a regression test that pins the Zoho
// handler's allowlist as byte-identical (i.e. it does NOT accept
// GOOGLE_CALLBACK_ORIGIN).
//
// Why these tests exist: the Google OAuth callback page is served on
// https://api.acschennai.com (a CNAME'd custom domain registered as
// GOOGLE_REDIRECT_URI so Google accepts it as an "owned" domain). The
// popup's postMessage carries event.origin = that host. The pre-fix
// SPA allowlist was [VITE_API_URL.origin, window.location.origin] — which
// did not include api.acschennai.com — so the Google login flow silently
// did nothing on the login page. This file pins the post-fix contract:
//
//   1. Google success from api.acschennai.com reaches setAuthData.
//   2. A zoho-oauth-success message from api.acschennai.com does NOT reach
//      setAuthData via the Zoho handler — the Zoho allowlist is unchanged
//      and does not include the Google callback origin. Pins the security
//      boundary: a future refactor that shares an allowlist between the
//      two handlers would (a) widen the trust surface and (b) let a
//      same-origin forge a zoho-oauth-success. This test catches that.
//   3. A google-oauth-success from a different origin (not in the
//      allowlist) is rejected even when event.source is the popup.
//   4. A google-oauth-success from the right origin but with the wrong
//      event.source (a window other than the popup this click opened)
//      is rejected. Pins the new event.source defense-in-depth check.
//
// Mocks mirror PortalLogin.google.test.jsx: env.js (VITE_API_URL is mocked
// to http://localhost), AuthContext, ToastContext, api.js, useDocumentTitle.

import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

jest.mock('../lib/env.js', () => ({
  __esModule: true,
  VITE_API_URL: 'http://localhost',
  default: 'http://localhost',
}));

const mockGetGoogleLoginActive = jest.fn();
const mockGetGoogleAuthUrl = jest.fn();
const mockGetZohoAuthUrl = jest.fn();
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
    getZohoAuthUrl: mockGetZohoAuthUrl,
    postGoogleCallback: jest.fn(),
    postZohoCallback: jest.fn(),
    login: jest.fn(),
  },
}));

const renderPortalLogin = ({ route = '/portal/login' } = {}) => {
  const PortalLogin = require('../pages/PortalLogin.jsx').default;
  return render(
    <MemoryRouter initialEntries={[route]}>
      <PortalLogin />
    </MemoryRouter>
  );
};

// One popup mock for the Google popup, a separate one for the Zoho
// popup. The handler closes over the popup reference it created, so
// each click handler's "this popup" check is distinct — the Google
// event.source test uses googleMockPopup and the Zoho test uses
// zohoMockPopup.
const googleMockPopup = {
  closed: false,
  close: jest.fn(),
  location: { href: '' },
};
const zohoMockPopup = {
  closed: false,
  close: jest.fn(),
  location: { href: '' },
};
const realOpen = window.open;
beforeEach(() => {
  googleMockPopup.closed = false;
  googleMockPopup.close = jest.fn();
  googleMockPopup.location = { href: '' };
  zohoMockPopup.closed = false;
  zohoMockPopup.close = jest.fn();
  zohoMockPopup.location = { href: '' };
  // The click handler calls window.open synchronously; return whichever
  // popup ref matches the window-name argument. Each handler passes
  // its own window name (GoogleOAuth / ZohoOAuth) so we can disambiguate.
  window.open = jest.fn((url, name) => {
    if (name === 'GoogleOAuth') return googleMockPopup;
    if (name === 'ZohoOAuth') return zohoMockPopup;
    return null;
  });
});
afterAll(() => { window.open = realOpen; });

beforeEach(() => {
  jest.clearAllMocks();
  // Default: Google kill switch on, both popup authUrl calls resolve.
  mockGetGoogleLoginActive.mockResolvedValue({ enabled: true });
  mockGetGoogleAuthUrl.mockResolvedValue({
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?...',
  });
  mockGetZohoAuthUrl.mockResolvedValue({
    authUrl: 'https://accounts.zoho.com/oauth/v2/auth?...',
  });
});

// Helper: build a MessageEvent with a real `event.source` (MessageEvent
// has a read-only `source` getter on its prototype, so direct assignment
// throws in strict mode — Object.defineProperty is the documented escape
// hatch used in browser tests and works in jsdom).
function messageWithSource({ origin, source, data }) {
  const ev = new MessageEvent('message', { origin, data });
  Object.defineProperty(ev, 'source', { value: source, configurable: true });
  return ev;
}

describe('PortalLogin — Google handler postMessage allowlist (fix/google-oauth-redirect-uri)', () => {
  it('1. google-oauth-success from https://api.acschennai.com with event.source = popup reaches setAuthData', async () => {
    renderPortalLogin();
    const btn = await screen.findByTestId('google-signin-button');
    fireEvent.click(btn);
    await waitFor(() => {
      expect(mockGetGoogleAuthUrl).toHaveBeenCalledTimes(1);
    });

    const employee = { id: 'emp-1', email: 'test@gmail.com', name: 'Test User', isAdmin: false };
    const ev = messageWithSource({
      origin: 'https://api.acschennai.com',
      source: googleMockPopup,
      data: {
        type: 'google-oauth-success',
        accessToken: 'access-xyz',
        refreshToken: 'refresh-xyz',
        employee,
      },
    });
    window.dispatchEvent(ev);

    await waitFor(() => {
      expect(mockSetAuthData).toHaveBeenCalledWith('access-xyz', employee, 'refresh-xyz');
    });
  });

  it('2. zoho-oauth-success from https://api.acschennai.com does NOT reach setAuthData (Zoho handler is byte-identical, allowlist unchanged)', async () => {
    // The Zoho handler's allowlist is [VITE_API_URL.origin, window.location.origin]
    // (the pre-fix shape). https://api.acschennai.com is NOT in it. A future
    // refactor that shares or widens the Zoho allowlist would let a same-origin
    // page forge a zoho-oauth-success message; this test catches that.
    renderPortalLogin();
    const zohoBtn = screen.getByText(/Sign in with Zoho/);
    fireEvent.click(zohoBtn);
    await waitFor(() => {
      expect(mockGetZohoAuthUrl).toHaveBeenCalledTimes(1);
    });

    const ev = messageWithSource({
      origin: 'https://api.acschennai.com',
      source: zohoMockPopup,
      data: {
        type: 'zoho-oauth-success',
        accessToken: 'forged-access',
        refreshToken: 'forged-refresh',
        employee: { id: 'emp-2', email: 'attacker@evil.com', name: 'Attacker', isAdmin: true },
      },
    });
    window.dispatchEvent(ev);

    // Wait a tick to let any async handler run, then assert nothing happened.
    await new Promise((r) => setTimeout(r, 50));
    expect(mockSetAuthData).not.toHaveBeenCalled();
  });

  it('3. google-oauth-success from a non-allowlisted origin is rejected even when event.source = popup', async () => {
    renderPortalLogin();
    const btn = await screen.findByTestId('google-signin-button');
    fireEvent.click(btn);
    await waitFor(() => {
      expect(mockGetGoogleAuthUrl).toHaveBeenCalledTimes(1);
    });

    // Origin is neither VITE_API_URL's host nor the current page nor
    // api.acschennai.com. A malicious site CANNOT forge event.origin
    // (the browser pins it to the sender's origin), but if a future
    // redirect-chain bug ever causes a wrong-origin message to land,
    // the allowlist still rejects it.
    const ev = messageWithSource({
      origin: 'https://evil.example.com',
      source: googleMockPopup,
      data: {
        type: 'google-oauth-success',
        accessToken: 'evil-access',
        refreshToken: 'evil-refresh',
        employee: { id: 'evil', email: 'evil@evil.example.com', name: 'Evil', isAdmin: true },
      },
    });
    window.dispatchEvent(ev);

    await new Promise((r) => setTimeout(r, 50));
    expect(mockSetAuthData).not.toHaveBeenCalled();
  });

  it('4. google-oauth-success from the right origin but the wrong event.source is rejected', async () => {
    renderPortalLogin();
    const btn = await screen.findByTestId('google-signin-button');
    fireEvent.click(btn);
    await waitFor(() => {
      expect(mockGetGoogleAuthUrl).toHaveBeenCalledTimes(1);
    });

    // event.source is a different window object — the message comes
    // from somewhere that is NOT the popup this click handler opened.
    // The new event.source check (added in this fix) catches this even
    // when the origin is otherwise in the allowlist.
    const someOtherWindow = { closed: false, close: jest.fn(), location: {} };
    const ev = messageWithSource({
      origin: 'https://api.acschennai.com',
      source: someOtherWindow,
      data: {
        type: 'google-oauth-success',
        accessToken: 'rogue-access',
        refreshToken: 'rogue-refresh',
        employee: { id: 'rogue', email: 'rogue@rogue.com', name: 'Rogue', isAdmin: true },
      },
    });
    window.dispatchEvent(ev);

    await new Promise((r) => setTimeout(r, 50));
    expect(mockSetAuthData).not.toHaveBeenCalled();
  });
});
