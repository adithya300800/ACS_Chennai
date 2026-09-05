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
      throw new ApiError('The request took too long. Please try again.', 0, 'TIMEOUT');
    }
    // S5 (audit): replace the developer-oriented "is the server running?"
    // copy with something a non-technical user can act on. The internal
    // `code` stays as 'NETWORK_ERROR' so the cold-start retry at
    // api.js:request() and any error.code === 'NETWORK_ERROR' branches
    // in callers keep working unchanged.
    throw new ApiError("Couldn't reach the server. Check your internet connection and try again.", 0, 'NETWORK_ERROR');
  } finally {
    clearTimeout(timeoutId);
  }
}

// Single-flight refresh: when many parallel 401s hit at once, only one
// /api/auth/refresh call goes out — every other caller awaits the same promise.
let refreshingPromise = null;

// Session-identity guard for refresh responses. AuthContext sets
// `sessionEpoch` to a fresh value on every login; the refresh response
// is dropped (and treated as if the refresh failed → triggers logout)
// if the epoch that started the call doesn't match the current epoch
// at the time the response lands. Without this, a slow in-flight
// refresh from account A could overwrite the freshly-installed
// access token for account B after a logout-then-login in the same
// page lifetime.
let refreshEpoch = 0;

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
  // DR-011 fix: capture the epoch this refresh call started with so a
  // late response (slow network, render-blocking tab) can't apply
  // account A's token to account B's session if a logout/login
  // happened mid-flight. Every refresh initiator — timer-fired
  // preemptive, 401-fired reactive, or a manual call to
  // api.refreshToken() — routes through this single guard.
  const epochAtCall = refreshEpoch;
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
      // DR-011: drop the response if the session identity changed
      // while we were waiting. Throwing here funnels the caller into
      // the same error path as a refresh failure, so AuthContext's
      // normal 'auth:logout' fire ends this stale attempt cleanly.
      if (epochAtCall !== refreshEpoch) {
        throw new ApiError('Session changed during refresh', 401, 'SESSION_CHANGED');
      }
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
      // DR-011 fix: include the epoch in the event detail so a late
      // subscriber can still drop the event if a newer epoch has
      // started. AuthContext subscribes to this and updates React
      // state so any mounted consumer sees the new token on the next
      // render — without this subscription the api.js path's
      // localStorage write was the only publication and React state
      // drifted out of sync.
      window.dispatchEvent(new CustomEvent('auth:token-refreshed', {
        detail: { accessToken: newToken, epoch: epochAtCall },
      }));
      return newToken;
    })
    .finally(() => {
      // clear the single-flight slot on the next tick so subsequent 401s
      // can issue a fresh refresh if the user stays logged in
      setTimeout(() => { refreshingPromise = null; }, 0);
    });
}

async function request(method, path, body, token, { _retried, _networkRetried, idempotencyKey } = {}) {
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      // DR-012: forward the Idempotency-Key header on every send AND
      // on every NETWORK_ERROR retry of the same call (the retry path
      // re-enters request() with the same `idempotencyKey` arg, so the
      // server can dedupe a "POST committed but response lost" replay
      // back to the cached 201 instead of producing a duplicate row +
      // duplicate admin fan-out). Round-10 added the server-side
      // dedupe; this is the matching client-side contract.
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
  };

  if (body && method !== 'GET') {
    opts.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetchWithTimeout(`${API_BASE}/api${path}`, opts, DEFAULT_TIMEOUT_MS);
  } catch (err) {
    // Round-26.5: cold-start network-error self-heal for mutating requests.
    // Render's free plan spins the service down after 15 min idle; the very
    // first request after a sleep often gets a TCP-level reset from the
    // waking server (the connection drops before the response begins). The
    // browser's fetch surfaces that as a TypeError, which fetchWithTimeout
    // translates to an ApiError with code 'NETWORK_ERROR'. For mutating
    // verbs (POST/PUT/DELETE) a single retry almost always succeeds — the
    // server is now awake and the second round-trip lands cleanly. GETs are
    // skipped (browsers cache + retries can confuse the user with duplicate
    // loads). Token-bearing requests are safe to retry because the server-
    // side handlers are idempotent or guarded with state-machine checks
    // (DPR DELETE requires DRAFT; a second DELETE returns 404, which the
    // caller surfaces as "already deleted").
    if (
      err.code === 'NETWORK_ERROR' &&
      !_networkRetried &&
      method !== 'GET' &&
      !path.startsWith('/auth/')
    ) {
      // Small backoff so the waking server has a beat to bind its socket.
      await new Promise((r) => setTimeout(r, 750));
      return request(method, path, body, token, { _retried, _networkRetried: true, idempotencyKey });
    }
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
        // DR-011 fix: route through api.refreshToken() so all refresh
        // initiators (this 401 path, timer-fired preemptive, download(),
        // manual call) share the single-flight slot AND the session-
        // identity guard in doRefresh(). The single-flight guarantee is
        // preserved by the implementation in api.refreshToken itself.
        const newToken = await api.refreshToken();
        return request(method, path, body, newToken, { _retried: true, idempotencyKey });
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
  // DR-012: post/put/delete accept an optional idempotencyKey as the
  // 4th positional arg. Forwarded as `Idempotency-Key: <key>` so the
  // backend can dedupe a NETWORK_ERROR-retry-with-same-key to the
  // cached 201 instead of producing a duplicate row + admin fan-out.
  // The retry path inside request() preserves the key, so the
  // client only needs to mint a key ONCE per submit intent.
  post: (path, body, token, idempotencyKey) => request('POST', path, body, token, { idempotencyKey }),
  put: (path, body, token, idempotencyKey) => request('PUT', path, body, token, { idempotencyKey }),
  // Round-29: patch was added when cube-test (N5), project updates, and
  // BOQ item updates all started using partial-update semantics.
  // Forwarded with the same idempotency-key contract as post/put so a
  // NETWORK_ERROR retry dedupes to the cached response.
  patch: (path, body, token, idempotencyKey) => request('PATCH', path, body, token, { idempotencyKey }),
  delete: (path, token, idempotencyKey) => request('DELETE', path, null, token, { idempotencyKey }),

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
      // DR-011 fix: route through the SHARED single-flight slot via
      // api.refreshToken() so a download-initiated refresh serializes
      // with any other refresh in flight (timer-fired, 401-fired from
      // request()) instead of racing a duplicate refresh on the same
      // rotating token.
      if (res.status === 401 && token && !path.startsWith('/auth/')) {
        try {
          const newToken = await api.refreshToken();
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
        throw new ApiError('The download took too long. Please try again.', 0, 'TIMEOUT');
      }
      if (err instanceof ApiError) throw err;
      throw new ApiError("Couldn't reach the server. Check your internet connection and try again.", 0, 'NETWORK_ERROR');
    } finally {
      clearTimeout(timeoutId);
    }
  },

  // DPR methods
  getDprSasUrl: (filename, contentType, container, token) =>
    api.post('/dpr/sas-url', { filename, contentType, container }, token),
  confirmUpload: (ulid, container, filename, contentType, sizeBytes, token) =>
    api.post('/dpr/confirm-upload', { ulid, container, filename, contentType, sizeBytes }, token),
  createDpr: (data, token, idempotencyKey) => api.post('/dpr', data, token, idempotencyKey),
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

  // Round-25: notification email preferences. Two-way contract: server
  // returns { preferences, types[] } on GET; PUT accepts any subset of
  // { emailEnabled, digestEnabled, typeMutes, digestHourLocal } and
  // returns the merged { preferences } shape.
  getNotificationPreferences: (token) =>
    api.get('/notifications/preferences', token),
  updateNotificationPreferences: (partial, token) =>
    api.put('/notifications/preferences', partial, token),
  // Admin-only: send a probe email to the admin's own mailbox to verify
  // the SMTP wire (Zoho credentials, deliverability) end-to-end.
  sendTestEmail: (token) =>
    api.post('/notifications/test', {}, token),

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

  // DR-011 fix: ONE coordinator for token rotation. Every refresh initiator
  // (timer-fired preemptive, 401-fired reactive inside request()/download(),
  // and a manual AuthContext call) routes through this function so they all
  // serialize on the same single-flight slot. Pre-fix, AuthContext had its
  // OWN refresh implementation that bypassed `refreshingPromise`, so two
  // parallel refreshes (timer + 401) could race on the same rotating
  // refresh token — sending it twice, getting one revoked server-side, and
  // forcing an unnecessary logout on the user.
  //
  // This helper is also what bumps `refreshEpoch` when the session identity
  // changes — callers that mount a fresh login call `api.bumpRefreshEpoch()`
  // (see below) so any in-flight refresh from the previous account is
  // dropped on landing via the epoch-mismatch check inside doRefresh().
  refreshToken: () => {
    if (!refreshingPromise) refreshingPromise = doRefresh();
    return refreshingPromise;
  },
  // Bump the refresh epoch so any in-flight refresh from a previous session
  // is rejected on landing (epoch mismatch in doRefresh → ApiError
  // SESSION_CHANGED → caller treats as a refresh failure → logout path).
  // AuthContext.login() calls this AFTER persisting the new tokens; it's a
  // no-op for fresh page loads where doRefresh hasn't been called yet.
  bumpRefreshEpoch: () => {
    refreshEpoch += 1;
  },
  // Read-only accessor for the current refresh epoch. AuthContext's
  // auth:token-refreshed listener uses this to drop a late event whose
  // epoch is stale (a refresh from a previous session landing after a
  // logout/login cycle). Optional chain (`api.getRefreshEpoch?.()`) so
  // an older bundle without this helper doesn't crash.
  getRefreshEpoch: () => refreshEpoch,

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
  createInspection: (data, token, idempotencyKey) => api.post('/inspection', data, token, idempotencyKey),
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
  // SOL DR-005: DRAFT → OPEN transition. Owner-only; backend fires the
  // admin fan-out on success. Symmetric to the dpr `/review` chain.
  submitInspection: (id, token) => api.post(`/inspection/${id}/submit`, {}, token),

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
  // SOL-P1#12: admin employee directory — powers the bulk-assign picker.
  listAdminEmployees: (params = {}, token) => {
    const qs = new URLSearchParams(params).toString();
    return api.get(`/admin/employees${qs ? '?' + qs : ''}`, token);
  },
  // Bulk assign — backend accepts either employeeIds (cuids) OR
  // employeeEmails and resolves them server-side. We pass emails because
  // admins paste a textarea of emails, not a list of cuids. The backend
  // returns { created: [...], skipped: [...], invalidInputs: [...] } so
  // the admin UI can show "Assigned to 12 · 1 duplicate · 2 invalid".
  assignTraining: (courseId, employeeIdsOrEmails, opts = {}, token) =>
    api.post('/training/enrollments', {
      courseId,
      // Round-24: the previous wrapper hardcoded `employeeEmails` on the wire
      // regardless of input, so any caller passing cuids (the picker in
      // TrainingCourseNew, the reassign modal) silently fell into the email
      // branch and got 0 matches / all in `invalidInputs`. Now we forward to
      // the correct key based on `opts.byEmail`. Default is `employeeIds`
      // because every UI consumer passes cuids; callers that genuinely want
      // to assign by email (none today) opt in with `{ byEmail: true }`.
      ...(opts.byEmail
        ? { employeeEmails: employeeIdsOrEmails }
        : { employeeIds: employeeIdsOrEmails }),
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
  //
  // Round-24 follow-up: `evidenceMetadata` is the IFrame session token the
  // backend requires (DR-010) before accepting `progressPct >= 100` from a
  // player-observable provider (YOUTUBE / VIMEO). Without it the route
  // 400s with PLAYER_DATA_REQUIRED. Caller passes `{ sessionId }` —
  // generated once per page mount by TrainingDetail (see sessionIdRef) —
  // and we send it on every progress POST so the route can validate the
  // chain of pings came from the same iframe load.
  updateTrainingProgress: (id, progressPct, lastWatchedSec, evidenceMetadata, token) =>
    api.put(`/training/enrollments/${id}/progress`, {
      progressPct,
      lastWatchedSec,
      ...(evidenceMetadata ? { evidenceMetadata } : {}),
    }, token),
  // Manual mark-complete (employee for non-trackable providers, or admin
  // override). 409 ENROLLMENT_LOCKED if the row is already COMPLETED.
  // Round-24 follow-up: admin can pull a row back from the employee's
  // queue. Soft-cancel — the row stays for audit (status=CANCELLED) so the
  // history isn't lost. Body shape: { note?: string }. The backend writes
  // it to employeeNote (existing column) and refuses if the row is already
  // completed or cancelled. Returns the updated enrollment row.
  cancelTrainingEnrollment: (id, note, token) =>
    api.post(`/training/enrollments/${id}/cancel`, { note: note || null }, token),
  markTrainingComplete: (id, note, token) =>
    api.put(`/training/enrollments/${id}/complete`, note ? { note } : {}, token),

  // Round-29 (N5): Cube-test integration with DPR & Inspection. The
  // backend ships 6 endpoints under /api/cube-tests; see
  // backend/src/routes/cubeTest.js for the full contract.
  //   - getCubeTests            → list with filters (status / dprId /
  //                               castingRecordId / dueBefore). 100-row cap.
  //   - createCubeTest          → file a new cube test (requires
  //                               ownership of the linked inspection/DPR
  //                               unless admin).
  //   - getCubeTest             → detail (submitter, DPR-submitter, or admin).
  //   - updateCubeTest          → record 7d/28d results. Status is
  //                               server-derived from result >= expected;
  //                               sending `status` in the body is rejected.
  //   - getCubeTestsDueSoon     → 28-day tests due in the next N days
  //                               (default 7) — powers the admin review queue.
  //   - getCubePourSummary      → pour-summary view per DPR (cast /
  //                               passed / pending / failed / overdue +
  //                               billingStatus).
  getCubeTests: (params = {}, token) => {
    const qs = new URLSearchParams(params).toString();
    return api.get(`/cube-tests${qs ? '?' + qs : ''}`, token);
  },
  createCubeTest: (data, token) => api.post('/cube-tests', data, token),
  getCubeTest: (id, token) => api.get(`/cube-tests/${id}`, token),
  updateCubeTest: (id, data, token) => api.patch(`/cube-tests/${id}`, data, token),
  getCubeTestsDueSoon: (days = 7, token) =>
    api.get(`/cube-tests/due-soon?days=${days}`, token),
  getCubePourSummary: (dprId, token) =>
    api.get(`/cube-tests/pour-summary/${dprId}`, token),

  // N17 — Project-level dashboard with KPI tiles. Lightweight project
  // master + a single KPI endpoint that aggregates DPR / Inspection /
  // CubeTest / BOQ / People counts scoped to one project. `idOrName`
  // accepts either a UUID or the project name (URL-decoded); the backend
  // resolves both.
  getProjects: (params, token) => {
    // [N1 Phase B] Accept an optional filter map (e.g. {isActive: 'true',
    // limit: '200'}) so the admin browse views can scope the dropdown to
    // registered+active projects without a separate /projects?isActive=…
    // method. Backward-compatible: callers that pass a token as the
    // first argument (the old single-arg form) still work because
    // `typeof params === 'string'` short-circuits the params branch.
    let path = '/projects';
    if (params && typeof params !== 'string') {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v != null && v !== '') qs.set(k, String(v));
      }
      const s = qs.toString();
      if (s) path += `?${s}`;
      return api.get(path, token);
    }
    // Backward-compat: (token) => api.get('/projects', token)
    return api.get('/projects', typeof params === 'string' ? params : token);
  },
  createProject: (data, token) => api.post('/projects', data, token),
  // [Bug fix] Resolves a free-text project name to a real Project row,
  // creating one on the fly if the name is "discovered" (exists as a
  // DPR.projectName but has no Project row yet). Returns the canonical
  // { id, name, ... } payload — the caller should overwrite its local
  // projectId state with the returned id so downstream pickers
  // (DrawingPicker, etc.) can fire with a valid UUID FK.
  // Backend: backend/src/routes/projects.js POST /api/projects/resolve.
  resolveProject: (name, token) => api.post('/projects/resolve', { name }, token),
  // getProject accepts either a UUID or a free-text name. We URL-encode
  // the value so a name like "T-Nagar / Phase II" survives the trip —
  // Express decodes it before the resolver runs.
  getProject: (idOrName, token) =>
    api.get(`/projects/${encodeURIComponent(idOrName)}`, token),
  // updateProject / softDeleteProject take the UUID — the backend
  // intentionally rejects PATCH on a name and routes soft-delete via
  // DELETE on the id (see backend/src/routes/projects.js).
  updateProject: (id, data, token) => api.patch(`/projects/${id}`, data, token),
  softDeleteProject: (id, token) => api.delete(`/projects/${id}`, token),
  // getProjectKpis: dashboard payload for one project. `days` is the
  // lookback window for activity counts (default 30; backend clamps to
  // 1..365). Pass 'all' is not supported — the dashboard uses 365 for
  // a full-year view and the dedicated stats endpoints otherwise.
  getProjectKpis: (idOrName, days = 30, token) =>
    api.get(`/projects/${encodeURIComponent(idOrName)}/kpis?days=${days}`, token),
  // [N1 Phase B] getProjectParties — anchor-page sidebar payload
  // (parties / contractValue / sites / description). Resolves by
  // UUID or name; a discovered (name-only) project returns 200 with
  // isRegistered=false and the metadata fields null. Mirrors the
  // `/:idOrName/kpis` URL encoding rule so a name with slashes
  // survives the round trip.
  getProjectParties: (idOrName, token) =>
    api.get(`/projects/${encodeURIComponent(idOrName)}/parties`, token),

  // N7 (round-28) — Bill of Quantities (BOQ) CRUD + variance report.
  // Backend (backend/src/routes/boq.js) — committed 68611e2. The
  // /variance endpoint MUST be called before the /:id fetch above would
  // match the literal "variance" string (Express route ordering bug — see
  // the file header in boq.js). Mirroring that priority here is just
  // cosmetic (the wrapper passes path strings through), but the URL
  // shape matters: `/boq/variance?projectName=...` not
  // `/boq/:id?variance=1`.
  getBoqItems: (params = {}, token) => {
    const qs = new URLSearchParams(params).toString();
    return api.get(`/boq${qs ? '?' + qs : ''}`, token);
  },
  createBoqItem: (data, token) => api.post('/boq', data, token),
  getBoqItem: (id, token) => api.get(`/boq/${id}`, token),
  updateBoqItem: (id, data, token) => api.patch(`/boq/${id}`, data, token),
  softDeleteBoqItem: (id, token) => api.delete(`/boq/${id}`, token),
  getBoqVariance: (projectName, token) =>
    api.get(`/boq/variance?projectName=${encodeURIComponent(projectName)}`, token),

  // N2 (Phase C — ACS Portal): RFI (Request for Information) routes.
  //
  // Status lifecycle: OPEN → RESPONDED → CLOSED. OVERDUE is a presentation
  // flag the backend derives server-side for OPEN rows past their due date
  // (see backend/src/routes/rfis.js:deriveRfiStatus). The wire shape from
  // the list + detail endpoints is:
  //   { id, subject, question, response, status, displayStatus,
  //     dueDate, createdAt, project, raisedBy, targetResponder,
  //     responder, _count: { variations } }
  //
  // Filters: projectId, status (OPEN/RESPONDED/CLOSED/OVERDUE), myOnly,
  // from/to on createdAt, cursor (keyset), limit (1..100, default 20).
  getRfis: (params = {}, token) => {
    const qs = new URLSearchParams(params).toString();
    return api.get(`/rfis${qs ? '?' + qs : ''}`, token);
  },
  createRfi: (data, token, idempotencyKey) => api.post('/rfis', data, token, idempotencyKey),
  getRfi: (id, token) => api.get(`/rfis/${id}`, token),
  // PATCH is multi-purpose on the backend: setting `response` records the
  // answer (status → RESPONDED), and adding `status: 'CLOSED'` in the
  // same body closes the row (admin-only). We expose a thin `respondRfi`
  // wrapper for the user-facing "Respond" button so callers don't have to
  // know the inline-state-machine rules.
  respondRfi: (id, { response, status }, token) =>
    api.patch(`/rfis/${id}`, { response, ...(status ? { status } : {}) }, token),
  // Admin close (no response required — CLOSED is the terminal state).
  closeRfi: (id, token) => api.patch(`/rfis/${id}`, { status: 'CLOSED' }, token),
  // Admin escalation: turns an RFI into a VariationOrder DRAFT. The
  // backend returns the new variation row so we can navigate to it.
  escalateRfiToVariation: (id, payload = {}, token) =>
    api.post(`/rfis/${id}/escalate-to-variation`, payload || {}, token),

  // N2 (Phase C — ACS Portal): Variation Order routes.
  //
  // Status lifecycle: DRAFT → SUBMITTED → APPROVED | REJECTED.
  // Wire shape (list + detail):
  //   { id, title, description, deltaAmount (string|number),
  //     status, clientApprovalRequired, project, referenceRfi,
  //     raisedBy, approvedBy, createdAt }
  //
  // Filters: projectId, status, from/to on createdAt, cursor, limit.
  // No `myOnly` — variations are org-visible.
  getVariations: (params = {}, token) => {
    const qs = new URLSearchParams(params).toString();
    return api.get(`/variations${qs ? '?' + qs : ''}`, token);
  },
  createVariation: (data, token, idempotencyKey) =>
    api.post('/variations', data, token, idempotencyKey),
  getVariation: (id, token) => api.get(`/variations/${id}`, token),
  // PATCH is DRAFT-only (raiser or admin). Allowed fields: title,
  // description, deltaAmount, clientApprovalRequired. Status transitions
  // route through /submit, /approve, /reject.
  updateVariation: (id, data, token) =>
    api.patch(`/variations/${id}`, data, token),
  // DRAFT → SUBMITTED (raiser or admin).
  submitVariation: (id, token) =>
    api.post(`/variations/${id}/submit`, {}, token),
  // SUBMITTED → APPROVED (admin only — requireFreshAdmin on the server).
  approveVariation: (id, token) =>
    api.post(`/variations/${id}/approve`, {}, token),
  // SUBMITTED → REJECTED (admin only). `reason` is required by the server
  // (rejected_reason column); passing null/empty will 400.
  rejectVariation: (id, { reason }, token) =>
    api.post(`/variations/${id}/reject`, { reason }, token),

  // N3 (Phase F) — Drawing Revision Register frontend wiring. Backend
  // (backend/src/routes/drawings.js) shipped in Phase E; this mirrors
  // the routes the admin registry + DPR/Inspection picker need.
  //
  //   - getDrawings              → list with filters (projectId REQUIRED,
  //                                status 'ACTIVE' | 'SUPERSEDED' | 'ALL',
  //                                cursor + limit). Cursor-paginated by
  //                                (issuedDate DESC, id DESC).
  //   - createDrawing            → admin create. Supports `supersedesId`
  //                                to atomically flip a predecessor to
  //                                SUPERSEDED inside the same transaction.
  //   - getDrawing               → detail + reference list + supersedes chain.
  //   - updateDrawing            → admin metadata edit (cannot change the
  //                                natural key (projectId, drawingNumber,
  //                                revision); those require a supersede).
  //   - softDeleteDrawing        → admin soft-delete via status=SUPERSEDED.
  //                                Idempotent on the server.
  //
  // Drawing PDFs ride the existing dpr-documents bucket (see
  // backend/src/routes/drawings.js header). The helpers below reuse
  // /api/dpr/sas-url + /api/dpr/confirm-upload with `drawing/` blob-path
  // prefix so a leaky SAS can't cross to photo or inspection buckets.
  getDrawings: (params = {}, token) => {
    const qs = new URLSearchParams(params).toString();
    return api.get(`/drawings${qs ? '?' + qs : ''}`, token);
  },
  createDrawing: (data, token, idempotencyKey) => api.post('/drawings', data, token, idempotencyKey),
  getDrawing: (id, token) => api.get(`/drawings/${id}`, token),
  updateDrawing: (id, data, token, idempotencyKey) => api.patch(`/drawings/${id}`, data, token, idempotencyKey),
  softDeleteDrawing: (id, token, idempotencyKey) => api.delete(`/drawings/${id}`, token, idempotencyKey),

  // Drawing PDF upload. Reuses /api/dpr/sas-url + /api/dpr/confirm-upload
  // but tags the container as 'dpr-documents' so a freshly-minted SAS
  // can't reach photo buckets. The blob path the server stores is the
  // verbatim R2 key returned by confirmUpload — the admin detail page
  // uses that key (via getDrawingReadSas) to mint a read SAS for the
  // iframe preview.
  //
  // `drawing/` prefix is a server-side naming convention so a bucket-wide
  // listing still shows which objects belong to drawings vs other
  // dpr-documents blobs. Matches the contract pinned in
  // backend/src/routes/dpr.js (sas-url handler).
  getDrawingSasUrl: (filename, contentType, token) =>
    api.post('/dpr/sas-url', {
      filename: `drawing/${filename}`,
      contentType,
      container: 'dpr-documents',
    }, token),
  confirmDrawingUpload: (ulid, filename, contentType, sizeBytes, token) =>
    api.post('/dpr/confirm-upload', {
      ulid,
      container: 'dpr-documents',
      filename: `drawing/${filename}`,
      contentType,
      sizeBytes,
    }, token),
  // PDF read SAS for the iframe preview on the Drawing detail page.
  // The backend route is NOT shipped yet (Phase E only exposes CRUD +
  // confirm-upload). The DrawingDetail page renders a "Preview pending"
  // state until this endpoint lands — keep the wrapper here so the
  // frontend contract is fixed and a backend PR can slot in without
  // a frontend refactor.
  getDrawingReadSas: (id, token) => api.get(`/drawings/${id}/read-sas`, token),
};
