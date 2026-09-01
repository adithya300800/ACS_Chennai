import React from 'react';

export default function PageLoader() {
  return (
    <div className="page-loading" role="status" aria-live="polite">
      <div className="page-loading-spinner" aria-hidden="true" />
      <p className="page-loading-text">Loading…</p>
    </div>
  );
}
