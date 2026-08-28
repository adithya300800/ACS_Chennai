import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';

export default function PortalLogin() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [form, setForm] = useState({ email: '', password: '' });
  const [status, setStatus] = useState('idle'); // idle | loading | error
  const [errorMsg, setErrorMsg] = useState('');

  // Check for OAuth code in URL on mount
  useEffect(() => {
    const code = searchParams.get('code');
    const error = searchParams.get('error');

    if (error) {
      setStatus('error');
      setErrorMsg('Zoho authentication failed');
      return;
    }

    if (code) {
      setStatus('loading');
      setErrorMsg('');

      fetch(`${import.meta.env.VITE_API_URL}/api/auth/zoho/callback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      })
        .then((res) => res.json())
        .then((data) => {
          if (data.error) throw new Error(data.error);

          // Store auth data
          localStorage.setItem('acs_auth', JSON.stringify({
            accessToken: data.accessToken,
            employee: data.employee
          }));
          localStorage.setItem('acs_refresh', data.refreshToken);

          // Reload to apply auth state
          window.location.hash = '#/portal/attendance';
          window.location.reload();
        })
        .catch((err) => {
          setStatus('error');
          setErrorMsg(err.message || 'Zoho login failed');
        });
    }
  }, [searchParams]);

  const handleChange = (e) => {
    setForm((f) => ({ ...f, [e.target.name]: e.target.value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setStatus('loading');
    setErrorMsg('');

    try {
      await login(form.email, form.password);
      navigate('/portal/attendance');
    } catch (err) {
      setStatus('error');
      setErrorMsg(err.message || 'Login failed. Please check your credentials.');
    }
  };

  const handleZohoLogin = async () => {
    setStatus('loading');
    setErrorMsg('');

    const apiUrl = import.meta.env.VITE_API_URL;
    console.log('Zoho login clicked, API URL:', apiUrl);

    try {
      // Get Zoho OAuth URL
      const res = await fetch(`${apiUrl}/api/auth/zoho`);
      console.log('Zoho endpoint response status:', res.status);
      if (!res.ok) throw new Error('Zoho OAuth not configured. API URL: ' + apiUrl);
      const { authUrl } = await res.json();
      console.log('Redirecting to:', authUrl);

      // Use popup window for OAuth (less likely to be blocked as suspicious)
      const width = 600;
      const height = 700;
      const left = window.screenX + (window.outerWidth - width) / 2;
      const top = window.screenY + (window.outerHeight - height) / 2;
      const popup = window.open(
        authUrl,
        'ZohoOAuth',
        `width=${width},height=${height},left=${left},top=${top},scrollbars=yes`
      );

      if (!popup) {
        // Fallback to redirect if popup blocked
        window.location.href = authUrl;
        return;
      }

      // Listen for OAuth callback via postMessage
      const handleMessage = (event) => {
        if (event.origin !== apiUrl) return;
        if (event.data.type === 'zoho-oauth-success') {
          window.removeEventListener('message', handleMessage);
          popup.close();

          // Store auth data
          localStorage.setItem('acs_auth', JSON.stringify({
            accessToken: event.data.accessToken,
            employee: event.data.employee
          }));
          localStorage.setItem('acs_refresh', event.data.refreshToken);

          // Reload to apply auth state
          window.location.hash = '#/portal/attendance';
          window.location.reload();
        } else if (event.data.type === 'zoho-oauth-error') {
          window.removeEventListener('message', handleMessage);
          popup.close();
          setStatus('error');
          setErrorMsg(event.data.error || 'Zoho login failed');
        }
      };
      window.addEventListener('message', handleMessage);

    } catch (err) {
      console.error('Zoho login error:', err);
      setStatus('error');
      setErrorMsg(err.message || 'Zoho OAuth not available');
    }
  };

  return (
    <div className="portal-auth-bg">
      <div className="portal-auth-card">
        {/* Logo / Branding */}
        <div className="portal-auth-logo">
          <div className="logo-icon" style={{ background: 'var(--blue)', width: 48, height: 48, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <svg width="24" height="24" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M10 2L18 16H2L10 2Z" fill="white" />
            </svg>
          </div>
          <div>
            <div className="portal-auth-brand">ACS Chennai</div>
            <div className="portal-auth-subbrand">Employee Portal</div>
          </div>
        </div>

        <h1 className="portal-auth-title">Welcome back</h1>
        <p className="portal-auth-desc">Sign in to mark your attendance</p>

        {status === 'error' && (
          <div className="portal-auth-error">
            <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            {errorMsg}
          </div>
        )}

        {/* Zoho SSO Button */}
        <button
          type="button"
          onClick={handleZohoLogin}
          className="btn btn-primary"
          style={{ width: '100%', justifyContent: 'center', padding: '0.85rem', marginBottom: '1rem', background: '#0258D8' }}
          disabled={status === 'loading'}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="white" style={{ marginRight: '0.5rem' }}>
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-1-13h2v6h-2zm0 8h2v2h-2z"/>
          </svg>
          Sign in with Zoho
        </button>

        <div style={{ display: 'flex', alignItems: 'center', margin: '1rem 0', color: 'var(--steel)', fontSize: '0.85rem' }}>
          <div style={{ flex: 1, height: '1px', background: '#ddd' }} />
          <span style={{ padding: '0 1rem' }}>or</span>
          <div style={{ flex: 1, height: '1px', background: '#ddd' }} />
        </div>

        <form onSubmit={handleSubmit} className="portal-auth-form">
          <div className="form-group">
            <label htmlFor="email">Email Address</label>
            <input
              id="email"
              name="email"
              type="email"
              className="form-input"
              placeholder="you@acschennai.com"
              value={form.email}
              onChange={handleChange}
              autoComplete="email"
            />
          </div>

          <div className="form-group">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              className="form-input"
              placeholder="••••••••"
              value={form.password}
              onChange={handleChange}
              autoComplete="current-password"
            />
          </div>

          <button
            type="submit"
            className="btn btn-primary"
            style={{ width: '100%', justifyContent: 'center', padding: '0.85rem', marginTop: '0.5rem' }}
            disabled={status === 'loading'}
          >
            {status === 'loading' ? 'Signing in...' : 'Sign In'}
          </button>
        </form>

        <div className="portal-auth-footer">
          <a href="/" className="portal-auth-back">← Back to website</a>
        </div>
      </div>
    </div>
  );
}
