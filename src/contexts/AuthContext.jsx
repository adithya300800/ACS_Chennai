import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { api } from '../lib/api.js';
import {
  clearForUser as clearScopedDraftForUser,
  clearAllExcept as clearAllScopedDraftsExcept,
} from '../lib/ownerScopedDraft.js';

// SOL DR-003 — every form that autosaves (DPR, Inspection) subscribes to
// this event and wipes its in-memory state. We also clear the persisted
// localStorage keys via `clearScopedDraftForUser` so the next account on a
// shared machine starts with a blank form, not the previous engineer's draft.
const DRAFT_CLEAR_BASES = ['dpr_draft_v1', 'inspection_draft_v1'];

function clearAllDraftsForEmployee(employeeId) {
  if (!employeeId) return;
  DRAFT_CLEAR_BASES.forEach((base) => clearScopedDraftForUser(base, employeeId));
  clearAllScopedDraftsExcept(DRAFT_CLEAR_BASES, employeeId);
}

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [employee, setEmployee] = useState(null);
  const [accessToken, setAccessToken] = useState(null);
  const [loading, setLoading] = useState(true);
  const navigateRef = useRef(null);
  const locationRef = useRef(null);

  // DR-011 fix: route the preemptive-refresh path through api.js's
  // single-flight coordinator. Pre-fix, this function had its OWN refresh
  // implementation (calling api.post('/auth/refresh', ...)) that bypassed
  // the `refreshingPromise` slot, so a timer-fired refresh racing a 401-
  // fired refresh could send the rotating refresh token twice — the second
  // request would 401 server-side (token already spent) and force an
  // unnecessary logout on the user.
  //
  // The new flow: api.refreshToken() either returns the in-flight refresh
  // promise OR starts a new one and caches it. Both the 401 path inside
  // api.request()/download() AND the preemptive timer here share that
  // single slot. The api.js path also fires `auth:token-refreshed` so this
  // provider can update React state — see the useEffect below.
  const refreshTokenFn = useCallback(async () => {
    try {
      return await api.refreshToken();
    } catch (err) {
      // Re-throw the underlying ApiError so the preemptive timer and
      // any direct caller preserves the original failure mode. The
      // 401 path's auth:logout fire handles the actual UX.
      throw err;
    }
  }, []);

  // On mount, try to restore session from localStorage
  useEffect(() => {
    const stored = localStorage.getItem('acs_auth');
    if (stored) {
      try {
        const { accessToken, employee } = JSON.parse(stored);
        setAccessToken(accessToken);
        setEmployee(employee);
      } catch {
        localStorage.removeItem('acs_auth');
      }
    }
    setLoading(false);
  }, []);

  // Round-10: preemptive refresh so a daily-active user isn't bounced to
  // /portal/login right when they're trying to submit something important.
  // Round-20 (DR-005): the access token is now 15 minutes, so a fixed
  // "1 hour before expiry" lead would degenerate to "60s before expiry" —
  // way too late. Refresh at half-life instead, with a 60s floor (very short
  // tokens) and a 10-minute ceiling (pathologically long tokens).
  const preemptiveTimerRef = useRef(null);
  useEffect(() => {
    // Don't schedule if no token or no logout in flight
    if (!accessToken) {
      if (preemptiveTimerRef.current) {
        clearTimeout(preemptiveTimerRef.current);
        preemptiveTimerRef.current = null;
      }
      return;
    }
    try {
      // Decode the JWT payload without verifying — the api interceptor will
      // catch any real invalidity on the next request. We only need `exp`.
      const parts = accessToken.split('.');
      if (parts.length !== 3) return;
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (!payload || typeof payload.exp !== 'number') return;
      const expiresAtMs = payload.exp * 1000;
      const lifetimeMs = expiresAtMs - Date.now();
      const halfLifeMs = Math.floor(lifetimeMs / 2);
      const msUntilRefresh = Math.min(10 * 60 * 1000, Math.max(60_000, halfLifeMs));
      // Skip if exp is already past (shouldn't happen — interceptor handles)
      if (msUntilRefresh > 24 * 60 * 60 * 1000) return;

      preemptiveTimerRef.current = setTimeout(async () => {
        try {
          await refreshTokenFn();
        } catch {
          // Refresh failed — let the interceptor's auth:logout fire on the
          // next 401 instead of proactively bouncing the user mid-session.
        }
      }, msUntilRefresh);
    } catch {
      // Malformed JWT — let api.js interceptor's normal 401 path handle it
    }
    return () => {
      if (preemptiveTimerRef.current) {
        clearTimeout(preemptiveTimerRef.current);
        preemptiveTimerRef.current = null;
      }
    };
  }, [accessToken, refreshTokenFn]);

  // DR-011 fix: subscribe to auth:token-refreshed so React state mirrors
  // whichever refresh path ran (timer-fired preemptive, 401-fired
  // reactive inside request()/download(), or a manual caller). Pre-fix,
  // api.js dispatched this event but NO provider listened, so the
  // api.js path's localStorage write was the only publication and React
  // state drifted out of sync — components could see a stale `accessToken`
  // for the lifetime of the page even after a successful refresh. The
  // event detail also carries the refresh epoch so we can drop a late
  // event from a previous session (e.g. user logged out and back in
  // during a slow refresh).
  useEffect(() => {
    const handler = (e) => {
      const newToken = e.detail?.accessToken;
      const epoch = e.detail?.epoch;
      // Belt-and-suspenders epoch check: api.js's doRefresh already
      // rejects mismatched epochs inside the promise chain, but the
      // event could in theory land before the rejection reaches the
      // catch if the timing is unlucky. Defensive drop is safe — the
      // current refreshEpoch is the source of truth on this side.
      if (typeof epoch === 'number' && epoch !== api.getRefreshEpoch?.()) {
        return;
      }
      if (newToken) {
        setAccessToken(newToken);
      }
    };
    window.addEventListener('auth:token-refreshed', handler);
    return () => window.removeEventListener('auth:token-refreshed', handler);
  }, []);

  // Wire up auth:logout listener from the api.js interceptor. When a 401
  // comes back with TOKEN_INVALID (or refresh itself fails), the interceptor
  // dispatches this event so we can clear local state and bounce the user to
  // the login page with a friendly "session expired" hint, instead of
  // showing them a raw error string.
  //
  // Belt-and-suspenders idempotency: the api.js interceptor already dedupes
  // auth:logout via a single-fire flag, but NotificationBell SSE and other
  // background tasks could still race. Guard here too so we don't navigate
  // repeatedly or fire the PortalLogin toast multiple times (Aug 29 2026
  // user report: "session expired notification cancerously multiple times").
  const loggingOutRef = useRef(false);
  useEffect(() => {
    const handler = (e) => {
      const reason = e.detail?.reason;
      // Skip the bounce if the user is already on the login page — avoids
      // an infinite navigation loop on /portal/login.
      const hash = window.location.hash || '';
      if (hash.includes('/portal/login')) return;
      if (loggingOutRef.current) return;
      loggingOutRef.current = true;

      // Clear auth state.
      localStorage.removeItem('acs_auth');
      localStorage.removeItem('acs_refresh');

      // SOL DR-003 — fan out draft cleanup BEFORE we null out employee, so
      // subscribers can still observe `previousEmployeeId` for diagnostics.
      const previousEmployeeId = e.detail?.employeeId ?? null;
      clearAllDraftsForEmployee(previousEmployeeId);
      window.dispatchEvent(new CustomEvent('draft:clear-current', { detail: { employeeId: previousEmployeeId } }));

      setAccessToken(null);
      setEmployee(null);

      // Defer navigation to next tick so it lands after the failed
      // fetch's promise chain resolves.
      setTimeout(() => {
        const nav = navigateRef.current;
        if (nav) {
          nav('/portal/login', { state: { reason: reason || 'expired' } });
        } else {
          window.location.hash = '#/portal/login';
        }
        // Reset on the next tick so a fresh login session can fire again.
        setTimeout(() => { loggingOutRef.current = false; }, 0);
      }, 0);
    };
    window.addEventListener('auth:logout', handler);
    return () => window.removeEventListener('auth:logout', handler);
  }, []);

  const login = useCallback(async (email, password) => {
    const data = await api.post('/auth/login', { email, password });
    const { accessToken, refreshToken, employee } = data;

    // DR-011 fix: bump the refresh epoch BEFORE persisting the new
    // tokens so any in-flight refresh from the previous session (a
    // user logged out, then logged back in within the lifetime of a
    // slow refresh response) is rejected on landing via the epoch
    // mismatch check inside doRefresh. Without this bump, the late
    // response could overwrite the freshly-installed access token for
    // the new account with one for the previous account.
    api.bumpRefreshEpoch();

    localStorage.setItem('acs_auth', JSON.stringify({ accessToken, employee }));
    localStorage.setItem('acs_refresh', refreshToken);

    setAccessToken(accessToken);
    setEmployee(employee);
    return employee;
  }, []);

  const setAuthData = useCallback((accessToken, employee, refreshToken) => {
    // DR-011 fix: bump the refresh epoch here too. Zoho OAuth and any
    // other "set auth without /auth/login" entry point must invalidate
    // any in-flight refresh from the previous session for the same
    // reason as login() — otherwise a stale response can land and
    // overwrite the new identity's tokens.
    api.bumpRefreshEpoch();
    localStorage.setItem('acs_auth', JSON.stringify({ accessToken, employee }));
    if (refreshToken) {
      localStorage.setItem('acs_refresh', refreshToken);
    }
    setAccessToken(accessToken);
    setEmployee(employee);
  }, []);

  // Round-9 P1: call the backend logout endpoint BEFORE clearing localStorage
  // so the access token is still available for the Authorization header.
  // BE4 added POST /api/auth/logout to revoke refresh tokens server-side —
  // without this a stolen refresh token stays valid for the full 7-day TTL
  // after the user signs out. Round-20 (DR-005): we now also send the
  // current refresh token in the body so the backend can revoke THIS
  // device's refresh row instead of nuking every other tab/device the user
  // has open. We swallow failures (network already dead, token already
  // expired, etc.) — the local clear is the source of truth for the UI.
  const logout = useCallback(async () => {
    const token = accessToken;
    const refresh = localStorage.getItem('acs_refresh');
    try {
      if (token) {
        await api.postLogout(token, refresh);
      }
    } catch {
      // Swallowed — see comment above; the local clear is the source of truth.
    }
    // DR-011 fix: bump the refresh epoch on logout too so any in-flight
    // refresh from the just-ended session is rejected when its response
    // arrives. (Without this, a slow /auth/refresh response landing
    // right after logout could re-populate localStorage with tokens for
    // the user who just signed out — see SESSION_CHANGED in api.js.)
    api.bumpRefreshEpoch();
    // SOL DR-003 — capture the id before we null out employee so subscribers
    // can correlate the event with the user being logged out. Cleanup runs
    // for both persisted keys and in-memory form state.
    const previousEmployeeId = employee?.id ?? null;
    localStorage.removeItem('acs_auth');
    localStorage.removeItem('acs_refresh');
    clearAllDraftsForEmployee(previousEmployeeId);
    window.dispatchEvent(new CustomEvent('draft:clear-current', { detail: { employeeId: previousEmployeeId } }));
    setAccessToken(null);
    setEmployee(null);
  }, [accessToken, employee]);

  // Provide navigate via a hook wrapper so consumers don't have to wrap us.
  // Called once by <RouterScope /> (see below) to inject react-router.
  const setRouter = useCallback((navigate, location) => {
    navigateRef.current = navigate;
    locationRef.current = location;
  }, []);

  return (
    <AuthContext.Provider value={{
      employee,
      accessToken,
      loading,
      login,
      logout,
      refreshToken: refreshTokenFn,
      setAuthData,
      setRouter,
      isAuthenticated: !!accessToken,
    }}>
      <RouterScope setRouter={setRouter}>{children}</RouterScope>
    </AuthContext.Provider>
  );
}

// Internal component that lives inside the router so we can read navigate().
// We don't want AuthProvider itself inside the router (it's mounted outside
// in main.jsx so ToastProvider wraps it), so we use a small child to inject
// the router hooks back into the context.
function RouterScope({ setRouter, children }) {
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {
    setRouter(navigate, location);
  }, [setRouter, navigate, location]);
  return children;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
