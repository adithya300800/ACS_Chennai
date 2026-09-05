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
  // DR-017: roving-tabindex state for the menuitems. `activeIndex` is
  // -1 when the menu is closed (so Tab from the trigger moves to the
  // next page element, not into the menu). When the user opens the
  // menu via click/Enter/Space, activeIndex becomes 0 so the first
  // menuitem is the next Tab target. ArrowUp/Down move the index; the
  // menuitem with the matching index receives focus.
  const [activeIndex, setActiveIndex] = useState(-1);

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

  // DR-017: list of menuitems in render order. We use this both for
  // ArrowDown/ArrowUp/Home/End navigation and for focus management.
  // The order MUST match the JSX render order below — the index drives
  // the active descendant.
  const menuItems = [
    { type: 'link', to: '/contact', label: 'Help & Support' },
    { type: 'link', to: '/portal/dashboard', label: 'Dashboard' },
    { type: 'link', to: '/portal/notifications/preferences', label: 'Notification preferences' },
    { type: 'button', label: 'Logout' },
  ];
  // Per-item refs for focus management. We index into this when
  // ArrowDown / ArrowUp changes activeIndex, so the matching <Link> /
  // <button> receives focus.
  const itemRefs = useRef([]);

  // Close on outside-click + Escape.
  // Round-22 fix: use 'click' (not 'mousedown') for outside-click detection.
  // Round-21 made the dropdown a React portal to document.body. Mousedown
  // fires BEFORE the link's onClick, so setOpen(false) on mousedown causes
  // React to unmount the dropdown (and remove the link element) before the
  // browser fires the click event — meaning React Router never sees the
  // navigation, and Help & Support / Dashboard / Sign out all silently
  // stop working. Switching to 'click' lets the link's click handler run
  // first (so React Router navigates) before we close the menu.
  //
  // ─── DR-017 — full ARIA Authoring Practices menu keyboard model ────
  // Implemented (see https://www.w3.org/WAI/ARIA/apg/patterns/menubar/):
  //   - Escape → close + return focus to trigger
  //   - ArrowDown → move focus to next menuitem (wraps to first)
  //   - ArrowUp → move focus to previous menuitem (wraps to last)
  //   - Home → focus first menuitem
  //   - End → focus last menuitem
  //   - roving tabindex on the menuitems (only the active item is in
  //     the tab order; the rest are tabIndex={-1} so Tab leaves the
  //     menu after one stop)
  // Still TODO:
  //   - First-letter type-ahead (one to several letters jumps to the
  //     first menuitem whose label starts with that letter)
  //   - Move focus to first item automatically on ArrowDown when the
  //     menu opens via keyboard (already done via `activeIndex = 0`)
  // ─────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      // The dropdown is portalled to document.body, so we check whether
      // the click landed inside either the trigger (still in the
      // header) OR the dropdown. Otherwise outside-click closes.
      if (rootRef.current && !rootRef.current.contains(e.target)
          && menuRef.current && !menuRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      // ARIA menu keyboard contract — only when focus is INSIDE the
      // menu (so we don't hijack global Arrow keys on the page).
      const insideMenu = menuRef.current && menuRef.current.contains(document.activeElement);
      const insideTrigger = triggerRef.current && triggerRef.current === document.activeElement;
      if (!insideMenu && !insideTrigger) return;
      const lastIndex = menuItems.length - 1;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => {
          const next = i < 0 ? 0 : (i + 1 > lastIndex ? 0 : i + 1);
          itemRefs.current[next]?.focus();
          return next;
        });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) => {
          const next = i < 0 ? lastIndex : (i - 1 < 0 ? lastIndex : i - 1);
          itemRefs.current[next]?.focus();
          return next;
        });
      } else if (e.key === 'Home') {
        e.preventDefault();
        itemRefs.current[0]?.focus();
      } else if (e.key === 'End') {
        e.preventDefault();
        itemRefs.current[lastIndex]?.focus();
      }
    };
    document.addEventListener('click', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', onDoc);
      document.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // DR-017: clicking the trigger (mouse) or pressing Enter/Space
  // (keyboard) opens the menu. When opening via keyboard we move
  // focus into the menu immediately so the screen-reader user does
  // not have to press ArrowDown to "enter" — the ARIA Authoring
  // Practices guide recommends this for menubar / menu patterns.
  const openMenu = (moveFocusInto) => {
    setOpen(true);
    if (moveFocusInto) {
      // Defer to next paint so the portal is mounted before we try
      // to focus into it.
      requestAnimationFrame(() => {
        setActiveIndex(0);
        itemRefs.current[0]?.focus();
      });
    }
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
        onClick={() => {
          if (open) setOpen(false);
          else openMenu(false); // mouse — user will press ArrowDown if they want it
        }}
        onKeyDown={(e) => {
          // Keyboard activation of the trigger moves focus INTO the
          // menu. Mouse clicks do not (the user clicks then ArrowDown
          // if they want keyboard nav).
          if ((e.key === 'Enter' || e.key === ' ') && !open) {
            e.preventDefault();
            openMenu(true);
          }
        }}
      >
        <span className="user-menu-avatar" style={{ background: accent }} aria-hidden="true">{initials}</span>
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          className="user-menu-dropdown user-menu-dropdown--portalled"
          role="menu"
          aria-label="Account"
          // DR-017: aria-activedescendant announces the focused
          // menuitem to assistive tech without moving DOM focus away
          // from the trigger (the trigger is what Tab will return to
          // when the user leaves the menu). Combined with the roving
          // tabindex below this is the WAI-ARIA APG menu pattern.
          aria-activedescendant={
            activeIndex >= 0 ? `user-menu-item-${activeIndex}` : undefined
          }
          style={{ top: `${pos.top}px` }}
        >
          <div className="user-menu-header">
            <div className="user-menu-name">{fullName}</div>
            {email && <div className="user-menu-email">{email}</div>}
            <span className={`user-menu-role ${employee?.isAdmin ? 'is-admin' : 'is-employee'}`}>
              {role}
            </span>
          </div>
          {/* DR-017: stable id matches index in `menuItems` so
              aria-activedescendant on the parent <div role="menu">
              can reference the focused item. Roving tabindex ensures
              only the activeIndex item is in the tab order; the rest
              are tabIndex={-1} so Tab leaves the menu after one stop. */}
          <Link
            id="user-menu-item-0"
            to="/contact"
            className="user-menu-item"
            role="menuitem"
            tabIndex={activeIndex === 0 ? 0 : -1}
            ref={(el) => { itemRefs.current[0] = el; }}
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
            id="user-menu-item-1"
            to="/portal/dashboard"
            className="user-menu-item"
            role="menuitem"
            tabIndex={activeIndex === 1 ? 0 : -1}
            ref={(el) => { itemRefs.current[1] = el; }}
            onClick={() => setOpen(false)}
          >
            <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M3 12l9-9 9 9" />
              <path d="M5 10v10h14V10" />
            </svg>
            <span>Dashboard</span>
          </Link>
          {/* Round-25: deep link to per-user email preferences. Lives next
              to Dashboard in the avatar dropdown so it's discoverable
              without polluting the main sidebar. */}
          <Link
            id="user-menu-item-2"
            to="/portal/notifications/preferences"
            className="user-menu-item"
            role="menuitem"
            tabIndex={activeIndex === 2 ? 0 : -1}
            ref={(el) => { itemRefs.current[2] = el; }}
            onClick={() => setOpen(false)}
          >
            <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 01-3.46 0" />
            </svg>
            <span>Notification preferences</span>
          </Link>
          <button
            id="user-menu-item-3"
            type="button"
            className="user-menu-item user-menu-signout"
            role="menuitem"
            tabIndex={activeIndex === 3 ? 0 : -1}
            ref={(el) => { itemRefs.current[3] = el; }}
            onClick={handleLogout}
          >
            <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            <span>Logout</span>
          </button>
        </div>,
        document.body
      )}
    </div>
  );
}
