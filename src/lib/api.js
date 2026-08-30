// API base URL. Reads from src/lib/env.js — a tiny wrapper around
// import.meta.env so this file can be required in Jest (CJS) without
// hitting SyntaxError on `import.meta` (see package.json moduleNameMapper).
import { VITE_API_URL } from './env.js';
const API_BASE = VITE_API_URL;

// Default request timeout. The browser's native fetch() has no timeout — if
// the server hangs (Azure slot swap mid-request, Prisma connection-pool
// warm-up after restart, transient Front-Door cold path, etc.) the call
// would sit pending indefinitely and the UI would stay stuck on
// "Submitting..." / "Marking..." / "Uploading..." forever (Aug 29 2026 user
// report: three independent "stuck forever" symptoms on DPR submit, attendance
// check-in, and photo upload). Aborting at 30s gives the user a clear
// timeout error instead of a frozen button.
const DEFAULT_TIMEOUT_MS = 30_000;
const REFRESH_TIMEOUT_MS = 15_000; // shorter — refresh is on the auth hot path

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// fetch() with an AbortController timeout. Always throws an ApiError on
// failure (timeout, network down, DNS failure) so callers can treat the
// error shape uniformly. The 'TIMEOUT' code lets the UI distinguish "the
// server is slow" from "the server is down" if it wants to.
async function fetchWithTimeout(url, opts = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new ApiError('Request timed out — please try again.', 0, 'TIMEOUT');
    }
    throw new ApiError('Network error — is the server running?', 0, 'NETWORK_ERROR');
  } finally {
    clearTimeout(timeoutId);
  }
}

// Single-flight refresh: when many parallel 401s hit at once, only one
// /api/auth/refresh call goes out — every other caller awaits the same promise.
let refreshingPromise = null;

// Single-fire logout: once we decide the session is dead (TOKEN_INVALID,
// refresh failed, or no token at all), we dispatch auth:logout exactly
// ONCE per page lifetime. Without this, every parallel 401 in flight
// would each dispatch its own auth:logout, which fires the listener N
// times → N navigate() calls → the toast in PortalLogin stacks up to
// "cancerous" levels (user report, Aug 29 2026).
let logoutDispatched = false;
function dispatchLogoutOnce(reason) {
  if (logoutDispatched) return;
  logoutDispatched = true;
  window.dispatchEvent(new CustomEvent('auth:logout', { detail: { reason } }));
  // Reset on the next tick so a fresh login session can fire again.
  setTimeout(() => { logoutDispatched = false; }, 0);
}

function doRefresh() {
  const refresh = localStorage.getItem('acs_refresh');
  if (!refresh) {
    return Promise.reject(new ApiError('No refresh token', 401, 'NO_REFRESH_TOKEN'));
  }
  return fetchWithTimeout(`${API_BASE}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: refresh }),
  }, REFRESH_TIMEOUT_MS)
    .then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new ApiError(data.error || 'Refresh failed', res.status, data.code);
      const newToken = data.accessToken;
      try {
        const stored = localStorage.getItem('acs_auth');
        if (stored) {
          const parsed = JSON.parse(stored);
          localStorage.setItem('acs_auth', JSON.stringify({ ...parsed, accessToken: newToken }));
        }
      } catch {}
      window.dispatchEvent(new CustomEvent('auth:token-refreshed', { detail: { accessToken: newToken } }));
      return newToken;
    })
    .finally(() => {
      // clear the single-flight slot on the next tick so subsequent 401s
      // can issue a fresh refresh if the user stays logged in
      setTimeout(() => { refreshingPromise = null; }, 0);
    });
}

async function request(method, path, body, token, { _retried } = {}) {
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  };

  if (body && method !== 'GET') {
    opts.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetchWithTimeout(`${API_BASE}/api${path}`, opts, DEFAULT_TIMEOUT_MS);
  } catch (err) {
    // fetchWithTimeout already throws ApiError for timeout / network failures.
    throw err;
  }

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    // Auto-refresh on 401 + TOKEN_EXPIRED/TOKEN_NBF, exactly once per call.
    // The server emits these structured codes (see backend/src/middleware/auth.js)
    // so we can distinguish "refresh and retry" from "the token is dead, log out".
    const shouldRefresh =
      res.status === 401 &&
      !_retried &&
      (data.code === 'TOKEN_EXPIRED' || data.code === 'TOKEN_NBF') &&
      !!token &&
      !path.startsWith('/auth/');

    if (shouldRefresh) {
      try {
        if (!refreshingPromise) refreshingPromise = doRefresh();
        const newToken = await refreshingPromise;
        return request(method, path, body, newToken, { _retried: true });
      } catch (refreshErr) {
        // Refresh itself failed — fall through to the normal error path
        // but tell the app to log out (single-fire to avoid toast spam).
        dispatchLogoutOnce('refresh_failed');
        throw new ApiError('Session expired. Please sign in again.', 401, data.code);
      }
    }

    // No refresh path (or already retried) — tell the app to log out on truly
    // invalid/missing tokens so the user sees a friendly redirect instead of
    // a raw "TOKEN_INVALID" string. Single-fire so multiple parallel 401s
    // don't stack toasts (Aug 29 2026 user report).
    if (res.status === 401 && (data.code === 'TOKEN_INVALID' || !token)) {
      dispatchLogoutOnce(data.code || 'no_token');
    }

    throw new ApiError(data.error || 'Request failed', res.status, data.code);
  }

  return data;
}

export const api = {
  get: (path, token) => request('GET', path, null, token),
  post: (path, body, token) => request('POST', path, body, token),
  put: (path, body, token) => request('PUT', path, body, token),
  delete: (path, token) => request('DELETE', path, null, token),

  // DPR methods
  getDprSasUrl: (filename, contentType, container, token) =>
    api.post('/dpr/sas-url', { filename, contentType, container }, token),
  confirmUpload: (ulid, container, filename, contentType, sizeBytes, token) =>
    api.post('/dpr/confirm-upload', { ulid, container, filename, contentType, sizeBytes }, token),
  createDpr: (data, token) => api.post('/dpr', data, token),
  getDprs: (params = {}, token) => {
    const qs = new URLSearchParams(params).toString();
    return api.get(`/dpr${qs ? '?' + qs : ''}`, token);
  },
  getDpr: (id, token) => api.get(`/dpr/${id}`, token),
  updateDpr: (id, data, version, token) =>
    api.put(`/dpr/${id}`, { ...data, version }, token),
  // Terminal-state endpoints. Backend POST /api/dpr/:id/review still exists
  // for UNDER_REVIEW but is not used by the admin UI anymore — the buttons
  // here are approve/reject only.
  approveDpr: (id, adminNotes, token) =>
    api.post(`/dpr/${id}/approve`, { adminNotes }, token),
  rejectDpr: (id, reason, adminNotes, token) =>
    api.post(`/dpr/${id}/reject`, { reason, adminNotes }, token),
  generateDprPdf: (id, token) => api.post(`/dpr/${id}/pdf`, {}, token),
  // P0 round-9: GET /api/dpr/notifications is mounted only as an SSE stream,
  // so JSON-parsing the response silently throws and the bell shows "0 unread".
  // The dedicated JSON-list endpoint returns { notifications: [...] } so
  // callers should expect that shape (NotificationBell already handles both).
  getNotifications: (lastId, token) =>
    api.get(`/dpr/notifications/list${lastId ? '?lastNotificationId=' + lastId : ''}`, token),
  markAllNotificationsRead: (token) =>
    api.put('/dpr/notifications/read-all', {}, token),
  // Single-use SSE ticket — replaces ?token= JWT-in-URL (Code Reviewer P2-2)
  getNotificationTicket: (token) =>
    api.post('/dpr/notifications/ticket', {}, token),

  // Auth helpers (BE4 added /api/auth/logout and /api/auth/me)
  // postLogout revokes the refresh token server-side so a stolen token stops
  // being valid after the user signs out (round-8 P2). Call this BEFORE
  // clearing localStorage so the request can still use the access token.
  postLogout: (token) => api.post('/auth/logout', null, token),
  // fetchMe returns the current employee; used by AuthContext for preemptive
  // refresh when the access token is about to expire (round-8 P1).
  fetchMe: (token) => api.get('/auth/me', token),

  // Zoho OAuth — public endpoints (no auth token).
  // Round-7: these previously used raw fetch() in PortalLogin, bypassing
  // the timeout wrapper and 401 handling. They return the parsed JSON
  // directly; the caller handles the OAuth popup lifecycle.
  //
  // Backend (backend/src/routes/auth.js) intentionally registers POST only:
  // the auth URL contains the OAuth `state` and should never be cached or
  // appear in browser/CDN history. The route comment claims the frontend
  // uses POST, but this helper used GET — which 404'd until round-11 fix.
  getZohoAuthUrl: () => api.post('/auth/zoho'),
  postZohoCallback: (code) => api.post('/auth/zoho/callback', { code }),
};
