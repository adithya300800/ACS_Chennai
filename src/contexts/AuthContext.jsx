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
  // /portal/login at 23h59m. Decode the stored access token's `exp` claim
  // and schedule a refresh 1 hour before it. The api.js interceptor handles
  // 401s on the fly, but a proactive refresh avoids the user seeing a flash
  // of "session expired" right when they're trying to submit something
  // important (DPR, attendance). Cancelled on logout.
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
      const msUntilRefresh = Math.max(60_000, expiresAtMs - Date.now() - 60 * 60 * 1000); // 1h before
      // Skip if exp is already past (shouldn't happen — interceptor handles)
      if (msUntilRefresh > 24 * 60 * 60 * 1000) return;

      preemptiveTimerRef.current = setTimeout(async () => {
        try {
          await refreshTokenFn();
        } catch (err) {
          // Refresh failed — let the interceptor's auth:logout fire on the
          // next 401 instead of proactively bouncing the user mid-session.
          console.warn('[auth] preemptive refresh failed:', err?.message || err);
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
  // after the user signs out. We swallow failures (network already dead,
  // token already expired, etc.) — the local clear is the source of truth
  // for the UI.
  const logout = useCallback(async () => {
    const token = accessToken;
    try {
      if (token) {
        await api.postLogout(token);
      }
    } catch (err) {
      console.warn('[auth] backend logout failed (continuing with local clear):', err?.message || err);
    }
    localStorage.removeItem('acs_auth');
    localStorage.removeItem('acs_refresh');
    setAccessToken(null);
    setEmployee(null);
  }, [accessToken]);

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
    setAccessToken(newAccessToken);
    return newAccessToken;
  }, []);

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
