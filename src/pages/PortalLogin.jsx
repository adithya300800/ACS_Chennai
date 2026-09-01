import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useToast } from '../contexts/ToastContext.jsx';
import { api } from '../lib/api.js';

// Map the backend's typed OAuth error codes to something a human can act on.
// The popup posts `{ type: 'zoho-oauth-error', error: '<code>' }`; showing the
// raw code ("token_exchange_failed") to an employee is not an error message.
const ZOHO_ERRORS = {
  no_code: 'Zoho did not return an authorization code. Please try again.',
  invalid_state: 'Your sign-in session expired. Please try again.',
  token_exchange_failed: 'Could not complete sign-in with Zoho. Please try again.',
  no_email: 'Your Zoho account has no email address associated with it.',
  domain_not_allowed: 'This email domain is not permitted for the employee portal.',
  server_error: 'Something went wrong on our end. Please try again.',
};

// B-04 (round-15+): one-time welcome toast on first successful login per
// employee. Keyed by employee ID in localStorage so (a) it only fires once
// per user, and (b) logging out and a different employee logging in on the
// same browser does not suppress the new user's first-login greeting.
//
// We fire from PortalLogin before navigate() because the toast lives in
// the top-level ToastProvider, which is mounted above the router — so the
// toast persists across the navigation and renders on top of the landing
// page (Attendance for employees, AdminOverview for admins).
function maybeShowWelcomeToast(toast, employee) {
  if (!employee?.id) return;
  let key;
  try {
    key = `acs_welcome_employee_${employee.id}`;
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, new Date().toISOString());
  } catch {
    // Storage unavailable (Safari private mode, quota) — fall back to
    // showing the toast anyway rather than silently failing the welcome.
  }
  const name = (employee.name || '').split(' ')[0] || 'there';
  const greeting = employee.isAdmin
    ? `Welcome back, ${name}. Open tiles are waiting for review.`
    : `Welcome to ACS Chennai, ${name}. Mark your attendance to start the day.`;
  toast.push(greeting, 'success', 6000);
}

export default function PortalLogin() {
  const { login, setAuthData } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const [form, setForm] = useState({ email: '', password: '' });
  // Round-17 B-15: login errors now flow through the shared toast stack
  // (PortalLayout already mounts ToastProvider) — no more on-page red box,
  // no `errorMsg` state, no `status === 'error'` branch. The user sees the
  // error in the same place they'd see errors on every other portal page.
  const [status, setStatus] = useState('idle'); // idle | loading

  // Surface "session expired" navigation state from AuthContext's logout
  // listener as a friendly toast instead of letting the user wonder why
  // they got bounced back to login.
  //
  // We also dedupe by reason in sessionStorage — if multiple parallel
  // 401s somehow still cause a navigate with the same reason (e.g. on
  // a slow network), the toast pushes once per session-per-reason rather
  // than once per navigate call (Aug 29 2026 user report).
  useEffect(() => {
    const reason = location.state?.reason;
    if (!reason) return;
    const dedupeKey = `acs_logout_toast_${reason}`;
    try {
      if (sessionStorage.getItem(dedupeKey)) {
        window.history.replaceState({}, document.title);
        return;
      }
      sessionStorage.setItem(dedupeKey, '1');
    } catch {}
    toast.push('Your session has expired. Please sign in again.', 'warning', 5000);
    // Clear the state so it doesn't fire again on refresh
    window.history.replaceState({}, document.title);
  }, [location.state, toast]);

  // Check for OAuth code in URL on mount
  useEffect(() => {
    const code = searchParams.get('code');
    const error = searchParams.get('error');

    if (error) {
      toast.push('Zoho authentication failed.', 'error');
      setStatus('idle');
      return;
    }

    if (code) {
      setStatus('loading');

      // Round-7: route through api.js so the Zoho callback POST inherits
      // the timeout wrapper (raw fetch could hang indefinitely if Azure
      // slot-swapped mid-OAuth). Throws ApiError on failure with structured
      // message + code.
      api.postZohoCallback(code)
        .then((data) => {
          setAuthData(data.accessToken, data.employee, data.refreshToken);
          maybeShowWelcomeToast(toast, data.employee);
          // P0/A-02: land admins on the new Overview, employees on Attendance.
          const landing = data.employee?.isAdmin ? '/portal/admin' : '/portal/attendance';
          // SPA navigation — preserves any draft state and avoids a full reload
          navigate(landing, { replace: true });
        })
        .catch((err) => {
          toast.push(err.message || 'Zoho login failed.', 'error');
          setStatus('idle');
        });
    }
  }, [searchParams, navigate, setAuthData]);

  const handleChange = (e) => {
    setForm((f) => ({ ...f, [e.target.name]: e.target.value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setStatus('loading');

    try {
      const employee = await login(form.email, form.password);
      // Clear dedupe keys for the new session — so a future session-expiry
      // toast can fire again.
      try {
        Object.keys(sessionStorage).forEach((k) => {
          if (k.startsWith('acs_logout_toast_')) sessionStorage.removeItem(k);
        });
      } catch {}
      maybeShowWelcomeToast(toast, employee);
      // P0/A-02: branch landing on role post-auth.
      const landing = employee?.isAdmin ? '/portal/admin' : '/portal/attendance';
      navigate(landing);
    } catch (err) {
      toast.push(err.message || 'Login failed. Please check your credentials.', 'error');
      setStatus('idle');
    }
  };

  const handleZohoLogin = async () => {
    setStatus('loading');

    // CRITICAL: open the popup SYNCHRONOUSLY (inside the click handler,
    // before any await) so the user gesture is preserved. Modern browsers
    // (Chrome, Safari, Firefox) drop the "user activated" flag after the
    // first await/microtask boundary — if we await the authUrl fetch first
    // and then call window.open, the popup is blocked, the user sees
    // nothing happen, and we lose them. Pre-open to about:blank (returns a
    // valid popup reference even before navigation) and navigate it to
    // the real authUrl after the fetch resolves.
    const width = 600;
    const height = 700;
    const left = window.screenX + (window.outerWidth - width) / 2;
    const top = window.screenY + (window.outerHeight - height) / 2;
    const features = `width=${width},height=${height},left=${left},top=${top},scrollbars=yes`;
    const popup = window.open('about:blank', 'ZohoOAuth', features);

    // If the synchronous popup-open itself was blocked (some browsers do
    // this even for about:blank), DO NOT navigate the parent to authUrl.
    // The previous fallback (`window.location.href = authUrl`) meant the
    // parent became the popup; after Zoho + callback, the callback HTML's
    // `window.close()` then killed the parent's tab — user reported this
    // as "portal login page is just full blank". Show an actionable
    // error and let the user retry with popups enabled.
    if (!popup) {
      toast.push('Pop-ups are blocked for this site. Please allow pop-ups and try again.', 'error');
      setStatus('idle');
      return;
    }

    try {
      // Round-7: use api.js so this inherits the 30s timeout wrapper.
      const { authUrl } = await api.getZohoAuthUrl();
      // Navigate the already-open popup to the real authUrl.
      popup.location.href = authUrl;

      // Every exit path (success, error, popup closed, timeout) funnels
      // through here so we never leave a listener, an interval or a timer
      // running — and never leave the button stuck on "Signing in...".
      // Declared with `let` up front so `cleanup` never closes over a
      // binding that is still in its temporal dead zone.
      let settled = false;
      let closedWatch = null;
      let giveUp = null;
      const cleanup = () => {
        settled = true;
        window.removeEventListener('message', handleMessage);
        clearInterval(closedWatch);
        clearTimeout(giveUp);
        try { popup.close(); } catch {}
      };

      function handleMessage(event) {
        // Trust the origin of the message sender. The popup runs on the
        // backend origin (acs-chennai.onrender.com) after Zoho redirects
        // it cross-origin. VITE_API_URL is not always set in CI (it's an
        // optional build-time var for backend overrides) — so fall back
        // to (a) the configured backend origin or (b) the current page's
        // origin. Accept either; the typed `event.data.type` check below
        // is the real defense against rogue messages (origin can't be
        // spoofed by other windows).
        const expected = (import.meta.env.VITE_API_URL || '').trim();
        const allowedOrigins = expected
          ? [new URL(expected).origin, window.location.origin]
          : [window.location.origin];
        if (!allowedOrigins.includes(event.origin)) return;
        if (event.data?.type === 'zoho-oauth-success') {
          cleanup();
          setAuthData(event.data.accessToken, event.data.employee, event.data.refreshToken);
          try {
            Object.keys(sessionStorage).forEach((k) => {
              if (k.startsWith('acs_logout_toast_')) sessionStorage.removeItem(k);
            });
          } catch {}
          maybeShowWelcomeToast(toast, event.data.employee);
          // P0/A-02: branch landing on role post-auth.
          const landing = event.data.employee?.isAdmin ? '/portal/admin' : '/portal/attendance';
          navigate(landing, { replace: true });
        } else if (event.data?.type === 'zoho-oauth-error') {
          cleanup();
          toast.push(ZOHO_ERRORS[event.data.error] || 'Zoho login failed. Please try again.', 'error');
          setStatus('idle');
        }
      }
      window.addEventListener('message', handleMessage);

      // If the user closes the popup manually mid-flow (e.g. abandons the
      // Zoho sign-in screen), bail out of the loading state so they can
      // retry instead of staring at a stuck "Signing in..." button.
      closedWatch = setInterval(() => {
        if (popup.closed) {
          cleanup();
          setStatus((s) => (s === 'loading' ? 'idle' : s));
        }
      }, 500);

      // Last-resort backstop. If the popup is alive but inert — its script
      // blocked, its opener severed, the network wedged — no message and no
      // `closed` transition will ever arrive, and the login page would hang
      // on "Signing in..." indefinitely. That was the reported production
      // symptom. Always give the user a way out.
      giveUp = setTimeout(() => {
        if (settled) return;
        cleanup();
        toast.push('Zoho sign-in timed out. Please close the Zoho window and try again.', 'error');
        setStatus('idle');
      }, 3 * 60 * 1000);

    } catch (err) {
      // Network failed before we could navigate the popup — close it so
      // the user isn't left with an empty about:blank window.
      try { popup.close(); } catch {}
      toast.push(err.message || 'Zoho OAuth not available.', 'error');
      setStatus('idle');
      // Note: closedWatch is owned by the success path; if we never
      // registered the message listener (authUrl fetch failed), there's
      // nothing for the watcher to clean up.
    }
  };

  return (
    <div className="portal-auth-bg">
      <div className="portal-auth-card">
        <div className="portal-auth-logo">
          <div className="logo-icon" style={{ background: 'var(--blue)', width: 48, height: 48, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <svg width="24" height="24" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <path d="M10 2L18 16H2L10 2Z" fill="white" />
            </svg>
          </div>
          <div>
            <div className="portal-auth-brand">ACS Chennai</div>
            <div className="portal-auth-subbrand">Employee Portal</div>
          </div>
        </div>

        <h1 className="portal-auth-title">Welcome back</h1>
        {/* P2/A-14: role-neutral — was "Sign in to mark your attendance", which
            misled admin users about what the portal is for. */}
        <p className="portal-auth-desc">Sign in to the ACS Chennai employee portal</p>

        <button
          type="button"
          onClick={handleZohoLogin}
          className="btn btn-primary"
          style={{ width: '100%', justifyContent: 'center', padding: '0.85rem', marginBottom: '1rem' }}
          disabled={status === 'loading'}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="white" style={{ marginRight: '0.5rem' }} aria-hidden="true">
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
              placeholder="Enter your password"
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
