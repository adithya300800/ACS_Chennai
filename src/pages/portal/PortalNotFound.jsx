import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';

// SOL-P2#18: portal-side 404. Lives inside the PortalLayout so the chrome
// (sidebar + top bar) stays visible and the user has a familiar recovery
// path — "Back to my dashboard" — instead of a generic "Back to website"
// link that breaks the SPA flow.
export default function PortalNotFound() {
  useDocumentTitle('Page not found', 'The page you were looking for doesn’t exist in the ACS portal.');
  const navigate = useNavigate();
  return (
    <div className="dpr-page portal-notfound-page">
      <div className="dpr-page-header">
        <div>
          <h1 className="dpr-page-title">Page not found</h1>
          <p className="dpr-page-sub" style={{ color: 'var(--steel)', margin: 0, fontSize: '0.95rem' }}>
            The page you were looking for doesn&rsquo;t exist or has moved.
          </p>
        </div>
      </div>
      <div className="dpr-card portal-notfound-card">
        <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: 'var(--steel)' }}>
          <circle cx="12" cy="12" r="10" />
          <path d="M8 15s1.5-2 4-2 4 2 4 2" />
          <line x1="9" y1="9" x2="9.01" y2="9" />
          <line x1="15" y1="9" x2="15.01" y2="9" />
        </svg>
        <h2 className="portal-notfound-title">We couldn&rsquo;t find that page</h2>
        <p className="portal-notfound-hint">
          The link may be out of date or the URL was mistyped.
        </p>
        <div className="portal-notfound-actions">
          <Link to="/portal/dashboard" className="btn btn-primary" style={{ minHeight: 44 }}>
            ← Back to dashboard
          </Link>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => navigate(-1)}
            style={{ minHeight: 44 }}
          >
            Previous page
          </button>
        </div>
      </div>
    </div>
  );
}
