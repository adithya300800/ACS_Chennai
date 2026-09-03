import React, { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';

// SOL-P2#19: header account/support control. Avatar (initials in a
// colored circle) opens a dropdown with: name + email + role badge,
// Help & Support link, Settings placeholder, Sign out. Closes on
// outside-click + Escape. Anchored top-right; never off-screen on
// 320px+ viewports.
//
// Round-21 fix: render the dropdown via React portal to document.body.
// The portal escapes the <header>'s containing-block (the global rule
// `header { backdrop-filter: blur(16px)… }` in App.css creates a fixed-
// positioning ancestor), so the prior in-header `position: fixed`
// dropdown was being clipped by the header's `overflow: hidden auto`
// once it dropped below the header's 64px band. Portalling out makes
// the dropdown a normal viewport-fixed element regardless of the
// header's stacking context.
export default function UserMenu() {
  const { employee, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, right: 0 }); // SOL-P2#19 live-deploy fix: dropdown is position:fixed, compute viewport coords from trigger rect
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);

  // Compute dropdown position from the trigger rect. useLayoutEffect
  // avoids the 1-frame flash where the dropdown would otherwise render
  // at 0,0 before React commits the position.
  //
  // Round-21 update: `right` is now CSS-driven (`right: 1rem` clamps the
  // dropdown to the viewport edge on mobile). JS-computed right doesn't
  // generalize for mobile topbars where the avatar is not at the far
  // right of the screen — same lesson as NotificationBell.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const compute = () => {
      const r = triggerRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 8 });
    };
    compute();
    window.addEventListener('resize', compute);
    window.addEventListener('scroll', compute, true);
    return () => {
      window.removeEventListener('resize', compute);
      window.removeEventListener('scroll', compute, true);
    };
  }, [open]);

  // Close on outside-click + Escape.
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const initials = (() => {
    const n = employee?.name?.trim() || '';
    if (!n) return '?';
    const parts = n.split(/\s+/);
    return ((parts[0]?.[0] || '') + (parts[parts.length - 1]?.[0] || '')).toUpperCase();
  })();

  const fullName = employee?.name || 'Employee';
  const email = employee?.email || '';
  const role = employee?.isAdmin ? 'Administrator' : 'Employee';
  // Deterministic accent — uses the email hash so different users get
  // different avatar colors without randomizing (which would shift
  // between sessions).
  const accent = (() => {
    const colors = ['#0EA5E9', '#6366F1', '#22C55E', '#F59E0B', '#EC4899', '#14B8A6'];
    let hash = 0;
    for (let i = 0; i < (email || fullName).length; i += 1) {
      hash = ((hash << 5) - hash + (email || fullName).charCodeAt(i)) | 0;
    }
    return colors[Math.abs(hash) % colors.length];
  })();

  const handleLogout = async () => {
    setOpen(false);
    await logout();
  };

  return (
    <div className="user-menu" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="user-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu for ${fullName}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="user-menu-avatar" style={{ background: accent }} aria-hidden="true">{initials}</span>
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          className="user-menu-dropdown user-menu-dropdown--portalled"
          role="menu"
          aria-label="Account"
          style={{ top: `${pos.top}px` }}
        >
          <div className="user-menu-header">
            <div className="user-menu-name">{fullName}</div>
            {email && <div className="user-menu-email">{email}</div>}
            <span className={`user-menu-role ${employee?.isAdmin ? 'is-admin' : 'is-employee'}`}>
              {role}
            </span>
          </div>
          <Link
            to="/contact"
            className="user-menu-item"
            role="menuitem"
            onClick={() => setOpen(false)}
          >
            <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <span>Help & Support</span>
          </Link>
          <Link
            to="/portal/dashboard"
            className="user-menu-item"
            role="menuitem"
            onClick={() => setOpen(false)}
          >
            <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M3 12l9-9 9 9" />
              <path d="M5 10v10h14V10" />
            </svg>
            <span>Dashboard</span>
          </Link>
          <button
            type="button"
            className="user-menu-item user-menu-signout"
            role="menuitem"
            onClick={handleLogout}
          >
            <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            <span>Sign out</span>
          </button>
        </div>,
        document.body
      )}
    </div>
  );
}
