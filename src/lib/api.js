const API_BASE = import.meta.env.VITE_API_URL || '';

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Single-flight refresh: when many parallel 401s hit at once, only one
// /api/auth/refresh call goes out — every other caller awaits the same promise.
let refreshingPromise = null;

function doRefresh() {
  const refresh = localStorage.getItem('acs_refresh');
  if (!refresh) {
    return Promise.reject(new ApiError('No refresh token', 401, 'NO_REFRESH_TOKEN'));
  }
  return fetch(`${API_BASE}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: refresh }),
  })
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
    res = await fetch(`${API_BASE}/api${path}`, opts);
  } catch (err) {
    throw new ApiError('Network error — is the server running?', 0, 'NETWORK_ERROR');
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
        // but tell the app to log out.
        window.dispatchEvent(new CustomEvent('auth:logout', { detail: { reason: 'refresh_failed' } }));
        throw new ApiError('Session expired. Please sign in again.', 401, data.code);
      }
    }

    // No refresh path (or already retried) — tell the app to log out on truly
    // invalid/missing tokens so the user sees a friendly redirect instead of
    // a raw "TOKEN_INVALID" string.
    if (res.status === 401 && (data.code === 'TOKEN_INVALID' || !token)) {
      window.dispatchEvent(new CustomEvent('auth:logout', { detail: { reason: data.code || 'no_token' } }));
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
  getNotifications: (lastId, token) =>
    api.get(`/dpr/notifications${lastId ? '?lastNotificationId=' + lastId : ''}`, token),
  markAllNotificationsRead: (token) =>
    api.put('/dpr/notifications/read-all', {}, token),
  // Single-use SSE ticket — replaces ?token= JWT-in-URL (Code Reviewer P2-2)
  getNotificationTicket: (token) =>
    api.post('/dpr/notifications/ticket', {}, token),
};
