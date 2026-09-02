import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { api } from '../lib/api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [employee, setEmployee] = useState(null);
  const [accessToken, setAccessToken] = useState(null);
  const [loading, setLoading] = useState(true);
  const navigateRef = useRef(null);
  const locationRef = useRef(null);

  // Defined early so the preemptive-refresh useEffect below can reference it
  // in its dependency array without hitting a JS TDZ (declared-later is a
  // ReferenceError for `const`). This callback's own deps are [] so it never
  // changes identity — moving it up is safe and stable.
  const refreshTokenFn = useCallback(async () => {
    const refresh = localStorage.getItem('acs_refresh');
    if (!refresh) throw new Error('No refresh token');

    const data = await api.post('/auth/refresh', { refreshToken: refresh });
    const newAccessToken = data.accessToken;

    const stored = localStorage.getItem('acs_auth');
    if (stored) {
      const parsed = JSON.parse(stored);
      localStorage.setItem('acs_auth', JSON.stringify({ ...parsed, accessToken: newAccessToken }));
    }
    // Round-20 (DR-005): backend rotates refresh tokens. The one we just sent
    // is dead server-side; the response carries a replacement. Persist it
    // before doing anything else so a 401 on the next page doesn't see the
    // spent value. Guarded on presence so we still work against a backend
    // that hasn't rolled the rotation out yet.
    if (data.refreshToken) {
      localStorage.setItem('acs_refresh', data.refreshToken);
    }
    setAccessToken(newAccessToken);
    return newAccessToken;
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

    localStorage.setItem('acs_auth', JSON.stringify({ accessToken, employee }));
    localStorage.setItem('acs_refresh', refreshToken);

    setAccessToken(accessToken);
    setEmployee(employee);
    return employee;
  }, []);

  const setAuthData = useCallback((accessToken, employee, refreshToken) => {
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
    localStorage.removeItem('acs_auth');
    localStorage.removeItem('acs_refresh');
    setAccessToken(null);
    setEmployee(null);
  }, [accessToken]);

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
