import React from 'react';

/**
 * Round-28 #6: visual indicator for the pull-to-refresh hook.
 *
 * Renders a small banner that drops down from the top of the page in
 * sync with the user's drag distance, then locks into a "Refreshing…"
 * state while the hook's onRefresh resolves.
 *
 * Position: `position: fixed; top: 0; left: 0; right: 0` so it floats
 * above page content (z-index 30 — below toasts/notification dropdowns
 * but above the bulk action bar).
 *
 * Pointer-events: none — never blocks taps on the underlying page.
 */
export default function PullToRefreshIndicator({ pullDistance, isRefreshing, threshold = 70 }) {
  const distance = Math.max(0, Math.min(140, pullDistance));
  if (distance === 0 && !isRefreshing) return null;

  const reached = distance >= threshold || isRefreshing;
  const opacity = isRefreshing ? 1 : Math.min(1, distance / threshold);
  const label = isRefreshing
    ? 'Refreshing…'
    : reached
      ? 'Release to refresh'
      : 'Pull to refresh';

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        height: `${distance}px`,
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        paddingBottom: '0.5rem',
        background: reached ? 'rgba(0, 102, 255, 0.06)' : 'rgba(0, 0, 0, 0.02)',
        borderBottom: reached ? '1px solid rgba(0, 102, 255, 0.2)' : '1px solid transparent',
        color: reached ? 'var(--blue)' : 'var(--steel)',
        fontSize: '0.85rem',
        fontWeight: 600,
        zIndex: 30,
        pointerEvents: 'none',
        opacity,
        transition: isRefreshing ? 'background 0.15s, border-color 0.15s, color 0.15s' : 'none',
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.5rem',
          padding: '0.375rem 0.75rem',
          background: 'white',
          borderRadius: 9999,
          boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
          // CSS spinner animation when refreshing; gentle scale on the
          // chevron otherwise. The CSS spin animation is the cheaper
          // visual cue — no SVG required.
          animation: isRefreshing ? 'ptr-spin 1s linear infinite' : 'none',
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="23 4 23 10 17 10" />
          <polyline points="1 20 1 14 7 14" />
          <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
        </svg>
        {label}
      </span>
      <style>{`@keyframes ptr-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
