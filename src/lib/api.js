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
        // Round-20 (DR-005): the backend now ROTATES refresh tokens — the one
        // we just sent was spent server-side and a replacement came back in
        // this response. Persist it. If we kept using the old value, the next
        // refresh would look like a replayed (stolen) token and the server
        // would revoke every session for this employee, logging the user out
        // of every device. Guarded on presence so this build still works
        // against a backend that predates rotation.
        if (data.refreshToken) {
          localStorage.setItem('acs_refresh', data.refreshToken);
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

  // Round-13: download() — fetch a binary response (XLSX / CSV) and return
  // a Blob + parsed Content-Disposition filename. Routes through the same
  // fetchWithTimeout helper as JSON calls so a hung server still aborts at
  // 30s. Token + single-flight 401 refresh handled here too.
  download: async (path, token, { timeoutMs = 60_000 } = {}) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let res = await fetch(`${API_BASE}/api${path}`, {
        method: 'GET',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: controller.signal,
      });
      // Mirror the JSON request() path: on TOKEN_EXPIRED/TOKEN_NBF, try a
      // single refresh then retry. Binary responses rarely come back 401,
      // but a long-running session can hit this during a slow export.
      if (res.status === 401 && token && !path.startsWith('/auth/')) {
        try {
          const newToken = await (refreshingPromise || (refreshingPromise = doRefresh().finally(() => {
            setTimeout(() => { refreshingPromise = null; }, 0);
          })));
          res = await fetch(`${API_BASE}/api${path}`, {
            method: 'GET',
            headers: { Authorization: `Bearer ${newToken}` },
            signal: controller.signal,
          });
        } catch (refreshErr) {
          dispatchLogoutOnce('refresh_failed');
          throw new ApiError('Session expired. Please sign in again.', 401, 'TOKEN_EXPIRED');
        }
      }
      if (!res.ok) {
        // Try to extract a server-side error message from the JSON body.
        let errBody = {};
        try { errBody = await res.json(); } catch {}
        if (res.status === 401) dispatchLogoutOnce(errBody.code || 'no_token');
        throw new ApiError(errBody.error || 'Download failed', res.status, errBody.code);
      }
      const blob = await res.blob();
      // Parse Content-Disposition for the suggested filename; fall back to
      // a timestamp-based name. Header may be absent on a misconfigured server.
      const cd = res.headers.get('Content-Disposition') || '';
      const m = /filename="?([^"]+)"?/i.exec(cd);
      const filename = m ? m[1] : `download-${Date.now()}.bin`;
      return {
        blob,
        filename,
        contentType: res.headers.get('Content-Type') || '',
        format: res.headers.get('X-Export-Format') || '',
        rowCount: Number(res.headers.get('X-Export-Row-Count') || 0),
      };
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new ApiError('Download timed out — please try again.', 0, 'TIMEOUT');
      }
      if (err instanceof ApiError) throw err;
      throw new ApiError('Network error — is the server running?', 0, 'NETWORK_ERROR');
    } finally {
      clearTimeout(timeoutId);
    }
  },

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
  // DR-029 (round-20): explicit aggregate counts for the admin dashboard.
  // Replaces the old "read paginated list, use length as count" pattern
  // that silently capped numbers at the page size. The backend runs six
  // indexed COUNT() queries in parallel; the window is echoed back in the
  // response so the UI can render "as of <ts>" if desired.
  getDprStats: (token) => api.get('/dpr/stats', token),
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
  // Round-17 B-06: bulk fan-out for the admin queue.
  // Returns { succeeded, failed, total } so the UI can show per-ID results.
  bulkReviewDprs: ({ ids, action, reason, adminNotes }, token) =>
    api.post('/dpr/bulk-review', { ids, action, reason, adminNotes }, token),
  generateDprPdf: (id, token) => api.post(`/dpr/${id}/pdf`, {}, token),
  // SOL-P0#4: delete own DRAFT DPR. Backend enforces DRAFT-only + owner-only.
  deleteDpr: (id, token) => api.delete(`/dpr/${id}`, token),
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
  // being valid after the user signs out (round-8 P2). Round-20 (DR-005):
  // takes the refresh token in addition to the access token, and sends it in
  // the request body so the backend can precisely revoke THIS device's
  // refresh row instead of over-revoking every session the user has open on
  // other tabs/devices. Call BEFORE clearing localStorage so the request can
  // still use the access token. refreshToken is optional — if missing (e.g.
  // already-expired session where someone cleared it manually) the backend
  // falls back to revoking all of this employee's refresh rows, which is the
  // safe direction to fail.
  postLogout: (token, refreshToken) =>
    api.post('/auth/logout', refreshToken ? { refreshToken } : null, token),
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

  // Round-12: Inspection & Compliance Records — first-class resource that
  // owns the 15 structured sub-work types (material / cube / water /
  // waterproofing / villa / day-activity / NCR / safety / major_deviation)
  // formerly nested inside DPR.workEntries. SAS upload goes to the
  // `inspection-photos` container so a leaky SAS can't cross to DPR photos.
  getInspectionSasUrl: (filename, contentType, token) =>
    api.post('/inspection/sas-url', { filename, contentType, container: 'inspection-photos' }, token),
  confirmInspectionUpload: (ulid, filename, contentType, sizeBytes, token) =>
    api.post('/inspection/confirm-upload', {
      ulid, container: 'inspection-photos', filename, contentType, sizeBytes,
    }, token),
  createInspection: (data, token) => api.post('/inspection', data, token),
  getInspections: (params = {}, token) => {
    const qs = new URLSearchParams(params).toString();
    return api.get(`/inspection${qs ? '?' + qs : ''}`, token);
  },
  // DR-029 (round-20): inspection admin dashboard aggregate counts. Same
  // shape as getDprStats — six parallel COUNT() queries against indexed
  // columns. See docs/dashboard-metrics.md for the metric definitions.
  getInspectionStats: (token) => api.get('/inspection/stats', token),
  getInspection: (id, token) => api.get(`/inspection/${id}`, token),
  // DR-004 (round-20): the previous signature took a `version` argument
  // and forwarded it on the wire, but InspectionRecord has no `version`
  // column. The backend's dead `where: { id, version }` clause made
  // every PUT silently 409 with VERSION_CONFLICT. The new wire
  // contract is: PUT /inspection/:id with just the editable fields
  // (no version, no status — status transitions go through the admin
  // endpoints). We keep the third positional arg as a deprecated
  // no-op so any caller still passing it doesn't crash.
  updateInspection: (id, data, _deprecatedVersion, token) =>
    api.put(`/inspection/${id}`, data, token),

  // Round-17 B-06: bulk fan-out for the admin inspection queue. Mirrors the
  // DPR bulkReviewDprs shape — backend returns
  // { succeededCount, failedCount, results: [...] } so the UI can show
  // per-ID results.
  bulkReviewInspections: ({ ids, action, reason, adminNotes }, token) =>
    api.post('/inspection/bulk-review', { ids, action, reason, adminNotes }, token),
  acknowledgeInspection: (id, adminNotes, token) =>
    api.post(`/inspection/${id}/acknowledge`, { adminNotes }, token),
  closeInspection: (id, adminNotes, token) =>
    api.post(`/inspection/${id}/close`, { adminNotes }, token),
  rejectInspection: (id, reason, adminNotes, token) =>
    api.post(`/inspection/${id}/reject`, { reason, adminNotes }, token),

  // Round-13: Attendance Excel timesheet export + Leave Request workflow.
  // The export route returns a binary blob; use api.download() instead of
  // api.get() — JSON parsing the response would silently produce `{}` and
  // lose the bytes.
  downloadTimesheet: (month, token, opts = {}) =>
    api.download(`/attendance/export?month=${encodeURIComponent(month)}${opts.employeeId ? `&employeeId=${encodeURIComponent(opts.employeeId)}` : ''}`, token, { timeoutMs: 60_000 }),
  // Leave endpoints. Non-admin callers see only their own requests via
  // /api/leave/my; the admin queue lives at /api/leave with optional filters.
  getMyLeaves: (token) => api.get('/leave/my', token),
  createLeave: (data, token) => api.post('/leave', data, token),
  cancelLeave: (id, token) => api.post(`/leave/${id}/cancel`, {}, token),
  getLeave: (id, token) => api.get(`/leave/${id}`, token),
  // Admin-only.
  getAllLeaves: (params = {}, token) => {
    const qs = new URLSearchParams(params).toString();
    return api.get(`/leave${qs ? '?' + qs : ''}`, token);
  },
  approveLeave: (id, reviewNotes, token) =>
    api.post(`/leave/${id}/approve`, { reviewNotes: reviewNotes || '' }, token),
  rejectLeave: (id, reviewNotes, token) =>
    api.post(`/leave/${id}/reject`, { reviewNotes }, token),

  // Round-14: Employee Training — admin assigns external courses; employees
  // watch in-platform with auto progress capture. All admin-only endpoints
  // 403 for non-admin tokens (the backend re-checks admin in the DB before
  // state transitions, so a stale JWT can't act on a revoked admin claim).
  getTrainingCourses: (params = {}, token) => {
    const qs = new URLSearchParams(params).toString();
    return api.get(`/training/courses${qs ? '?' + qs : ''}`, token);
  },
  getTrainingCourse: (id, token) => api.get(`/training/courses/${id}`, token),
  createTrainingCourse: (data, token) => api.post('/training/courses', data, token),
  updateTrainingCourse: (id, data, token) =>
    api.put(`/training/courses/${id}`, data, token),
  // Bulk assign — backend accepts either employeeIds (cuids) OR
  // employeeEmails and resolves them server-side. We pass emails because
  // admins paste a textarea of emails, not a list of cuids. The backend
  // returns { created: [...], skipped: [...], invalidInputs: [...] } so
  // the admin UI can show "Assigned to 12 · 1 duplicate · 2 invalid".
  assignTraining: (courseId, employeeIdsOrEmails, opts = {}, token) =>
    api.post('/training/enrollments', {
      courseId,
      employeeEmails: employeeIdsOrEmails,
      ...(opts.dueDate ? { dueDate: opts.dueDate } : {}),
      ...(opts.priority ? { priority: opts.priority } : {}),
    }, token),
  // Employee "My Learning" — only their own enrollments. Backend caps at 200.
  getMyTraining: (params = {}, token) => {
    const qs = new URLSearchParams(params).toString();
    return api.get(`/training/enrollments/my${qs ? '?' + qs : ''}`, token);
  },
  // Admin queue — all enrollments across the company, filterable.
  getAllTrainingEnrollments: (params = {}, token) => {
    const qs = new URLSearchParams(params).toString();
    return api.get(`/training/enrollments${qs ? '?' + qs : ''}`, token);
  },
  getTrainingEnrollment: (id, token) => api.get(`/training/enrollments/${id}`, token),
  // Progress ping — called every ~10s by the player (YouTube / Vimeo IFrame
  // API). Backend conditional UPDATE on status != COMPLETED so a stale
  // ping can't move the row backwards, and the row is locked once complete.
  updateTrainingProgress: (id, progressPct, lastWatchedSec, token) =>
    api.put(`/training/enrollments/${id}/progress`, { progressPct, lastWatchedSec }, token),
  // Manual mark-complete (employee for non-trackable providers, or admin
  // override). 409 ENROLLMENT_LOCKED if the row is already COMPLETED.
  markTrainingComplete: (id, note, token) =>
    api.put(`/training/enrollments/${id}/complete`, note ? { note } : {}, token),
};
