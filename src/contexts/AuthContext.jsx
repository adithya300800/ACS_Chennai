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

  // Wire up auth:logout listener from the api.js interceptor. When a 401
  // comes back with TOKEN_INVALID (or refresh itself fails), the interceptor
  // dispatches this event so we can clear local state and bounce the user to
  // the login page with a friendly "session expired" hint, instead of
  // showing them a raw error string.
  useEffect(() => {
    const handler = (e) => {
      const reason = e.detail?.reason;
      // Skip the bounce if the user is already on the login page — avoids
      // an infinite navigation loop on /portal/login.
      const hash = window.location.hash || '';
      if (hash.includes('/portal/login')) return;

      // Clear auth state. Using logout() rather than firing another
      // auth:logout — the listener will be a no-op.
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

  const logout = useCallback(() => {
    localStorage.removeItem('acs_auth');
    localStorage.removeItem('acs_refresh');
    setAccessToken(null);
    setEmployee(null);
  }, []);

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
