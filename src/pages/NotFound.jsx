import React from 'react';
import { Link } from 'react-router-dom';

// P0/A-12: catch-all for the public route tree so typo'd URLs render a
// visible "page not found" instead of silently showing the homepage.
export default function NotFound() {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '60vh',
      gap: '1rem',
      textAlign: 'center',
      padding: '2rem',
    }}>
      <div style={{ fontSize: '3rem' }}>🔍</div>
      <h2 style={{
        fontFamily: "'Plus Jakarta Sans', sans-serif",
        fontSize: '1.5rem',
        fontWeight: 700,
        color: 'var(--navy)',
      }}>
        Page not found
      </h2>
      <p style={{ color: 'var(--steel)', maxWidth: '400px' }}>
        The page you were looking for doesn't exist. Check the URL or head back to the website.
      </p>
      <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.5rem' }}>
        <Link to="/" className="btn btn-primary btn-sm">← Back to website</Link>
      </div>
    </div>
  );
}
