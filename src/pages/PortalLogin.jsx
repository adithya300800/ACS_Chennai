import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';

export default function PortalLogin() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: '', password: '' });
  const [status, setStatus] = useState('idle'); // idle | loading | error
  const [errorMsg, setErrorMsg] = useState('');

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
              required
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
              required
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
