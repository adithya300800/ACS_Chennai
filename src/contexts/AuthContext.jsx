import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [employee, setEmployee] = useState(null);
  const [accessToken, setAccessToken] = useState(null);
  const [loading, setLoading] = useState(true);

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

  const login = useCallback(async (email, password) => {
    const data = await api.post('/auth/login', { email, password });
    const { accessToken, refreshToken, employee } = data;

    localStorage.setItem('acs_auth', JSON.stringify({ accessToken, employee }));
    localStorage.setItem('acs_refresh', refreshToken);

    setAccessToken(accessToken);
    setEmployee(employee);
    return employee;
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

  return (
    <AuthContext.Provider value={{
      employee,
      accessToken,
      loading,
      login,
      logout,
      refreshToken: refreshTokenFn,
      isAuthenticated: !!accessToken,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
