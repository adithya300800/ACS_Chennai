import React, { useState, useRef, useCallback } from 'react';
import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
// SOL-P2#17: removed the useToast import; pushToast was only used by
// the now-removed Assets coming-soon branch. Re-introduce when a
// sidebar item genuinely needs a toast.
import NotificationBell from './NotificationBell.jsx';
// SOL-P2#19: header account/support control (avatar + dropdown).
import UserMenu from './UserMenu.jsx';
// Round-17: shared skip-nav + focus-trap + keyboard-shortcut primitives.
import SkipNav from './SkipNav.jsx';
import useFocusTrap from '../hooks/useFocusTrap.js';
import useKeyboardShortcut from '../hooks/useKeyboardShortcut.js';
import { formatDateOnly } from '../lib/format.js';

// S5 audit: desktop sidebar used to start icon-only with no way to
// remember the user's choice. The new contract:
//   - First visit on desktop → expanded (so labels are visible and the
//     audit's "no discoverable affordance" finding stays fixed).
//   - First visit on mobile  → collapsed (the drawer overlay covers the
//     page; opening it should be a deliberate gesture).
//   - The user's last toggle persists across reloads via localStorage.
//   - The persisted choice wins on desktop; mobile always collapses the
//     drawer off-canvas regardless of the desktop preference.
// This breaks the "always icon-only on desktop" regression class.

const SIDEBAR_PREF_KEY = 'acs.sidebarExpanded';
// Read synchronously so the first render uses the saved preference —
// avoids the icon-only → expanded flash the audit captured.
const readSidebarPref = () => {
  if (typeof window === 'undefined') return null;
  const v = window.localStorage.getItem(SIDEBAR_PREF_KEY);
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null; // never set → fall back to defaults below
};

export default function PortalLayout() {
  const { employee, logout } = useAuth();
  const navigate = useNavigate();
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  const [sidebarOpen, setSidebarOpenState] = useState(() => {
    // Mobile should always start collapsed; desktop honours the saved
    // choice, defaulting to expanded on first visit.
    if (window.innerWidth < 768) return false;
    const saved = readSidebarPref();
    return saved === null ? true : saved;
  });
  const sidebarRef = useRef(null);

  // Wrapper that also persists the desktop choice. On mobile the drawer
  // state isn't persisted — every reload starts closed, by design — so
  // we only write the key when we're on a desktop-sized viewport.
  const setSidebarOpen = useCallback((next) => {
    setSidebarOpenState((prev) => {
      const resolved = typeof next === 'function' ? next(prev) : next;
      const mobile = window.innerWidth < 768;
      if (!mobile) {
        try { window.localStorage.setItem(SIDEBAR_PREF_KEY, String(resolved)); } catch (_) { /* private mode / quota — ignore */ }
      }
      return resolved;
    });
  }, []);

  // Handle resize
  React.useEffect(() => {
    const handleResize = () => {
      const mobile = window.innerWidth < 768;
      const wasMobile = isMobile;
      setIsMobile(mobile);
      // Crossing the desktop boundary: collapse the mobile drawer (it
      // would cover everything off-canvas on desktop) but DO NOT touch
      // the desktop sidebar state — the user's saved preference wins.
      if (mobile !== wasMobile) {
        if (mobile) {
          setSidebarOpenState(false);
        } else {
          const saved = readSidebarPref();
          setSidebarOpenState(saved === null ? true : saved);
        }
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [isMobile]);

  // Close mobile sidebar on Escape
  React.useEffect(() => {
    const handleKey = (e) => {
      if (e.key === 'Escape' && isMobile && sidebarOpen) {
        setSidebarOpen(false);
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isMobile, sidebarOpen]);

  // Round-17 B-09 / D-07: trap Tab inside the mobile drawer while it's open
  // so keyboard users can't tab into the page content behind it.
  useFocusTrap(sidebarRef, isMobile && sidebarOpen);

  // Round-17 B-07: Shift+A is a quick jump to Attendance for employees (the
  // landing page post-login). Skipped for admins — they land on the
  // overview instead, where Attendance isn't where they usually go next.
  const goAttendance = useCallback(() => navigate('/portal/attendance'), [navigate]);
  useKeyboardShortcut({
    key: 'a',
    modifiers: ['Shift'],
    handler: !employee?.isAdmin ? goAttendance : undefined,
  });

  const handleLogout = () => {
    logout();
    navigate('/portal/login');
  };

  const toggleSidebar = () => setSidebarOpen(o => !o);
  const closeMobileSidebar = () => {
    if (isMobile) setSidebarOpen(false);
  };

  // S5 audit: "Restore concise grouped sections: My Work, Reports, Review,
// Records, Administration". Round-22 collapsed the sidebar to a flat list
// at the user's request, but the S5 audit found that the admin sidebar
// in particular was visually noisy (8 flat links under one heading) and
// hard to scan for new admins. The grouped structure now mirrors the
// audit's recommended taxonomy:
//   My Work         — per-user daily flow (everyone)
//   Reports         — per-user filed records (everyone)
//   Review          — admin approval queues (admin only)
//   Records         — admin cross-org browse views (admin only)
//   Administration  — admin overview / config (admin only)
// Labels render only when the sidebar is expanded; the audit's grouping
// does not affect the icon-only mode (each NavLink already carries a
// `title` + `aria-label` for that case — see WCAG 2.4.4 / 4.1.2).
//
// P1/A-04: dropped the "New DPR" and "New Inspection" CTAs — the
// relevant pages already have a "+ New" CTA pinned in their own list
// header.
const ATTENDANCE_ICON = (
  <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
    <rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
  </svg>
);
const DOC_ICON = (
  <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /><polyline points="10 9 9 9 8 9" />
  </svg>
);
const CLIPBOARD_ICON = (
  <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2" /><rect x="9" y="3" width="6" height="4" rx="1" /><path d="M9 14l2 2 4-4" />
  </svg>
);
const GRID_ICON = (
  <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
    <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" />
  </svg>
);
const CHECK_ICON = (
  <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
  </svg>
);
const CLIPBOARD_LIST_ICON = (
  <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
    <rect x="9" y="3" width="6" height="4" rx="1" /><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2" />
  </svg>
);
const CHECKMARK_ICON = (
  <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);
const GRADUATION_ICON = (
  <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M22 10v6M2 10l10-5 10 5-10 5z" /><path d="M6 12v5c3 3 9 3 12 0v-5" />
  </svg>
);
const CALENDAR_ICON = (
  <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
    <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
    <line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" />
    <line x1="3" y1="10" x2="21" y2="10" />
  </svg>
);
const BOOK_ICON = (
  <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z" /><path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z" />
  </svg>
);
// N7: BOQ registry (admin) + variance report (employee). Two icons:
//   - LIST_ICON — registry table (admin)
//   - CHART_ICON — variance bars (employee-facing)
const LIST_ICON = (
  <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
    <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><circle cx="4" cy="6" r="1" /><circle cx="4" cy="12" r="1" /><circle cx="4" cy="18" r="1" />
  </svg>
);
const CHART_ICON = (
  <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
    <line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" /><line x1="3" y1="20" x2="21" y2="20" />
  </svg>
);
// Round-29: cube-test icon REMOVED — cube testing is captured by the
// cube_casting / cube_testing InspectionRecord sub-types. The standalone
// feature (and its sidebar entry) is gone.
// N17 — Project icon (building) + dashboard chart icon.
const BUILDING_ICON = (
  <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="3" y1="9" x2="21" y2="9" /><line x1="9" y1="21" x2="9" y2="9" />
  </svg>
);
// Round-29: RFI icon REMOVED — the RFI feature is gone; VOs are now
// standalone work items.
// Phase-D (N2): Variation Order icon — a fork-and-node glyph echoing the
// "scope change branching from the original contract" concept. Distinct
// from CHART_ICON (BOQ variance bars) so admins don't conflate the two.
const VARIATION_ICON = (
  <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="6" cy="6" r="2" /><circle cx="6" cy="18" r="2" /><circle cx="18" cy="6" r="2" />
    <path d="M6 8v8" /><path d="M6 12c0-3.31 2.69-6 6-6" />
  </svg>
);
// N3 (Phase F): Drawing Revision Register icon — a simple "blueprint"
// triangle-over-rectangle glyph echoing the engineering-drawing aesthetic.
// Distinct from DOC_ICON (DPR) and CLIPBOARD_ICON (Inspection) so the
// admin sidebar stays scannable when three record-shaped links share a
// group.
const DRAWING_ICON = (
  <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M3 17l4-4 4 4 3-3 7 7" />
    <path d="M14 6l4 4-4 4" />
  </svg>
);

const navGroups = [
  {
    // Per-user daily flow — visible to everyone.
    label: 'My Work',
    items: [
      { to: '/portal/attendance', label: 'My Attendance', icon: ATTENDANCE_ICON },
      { to: '/portal/leave', label: 'My Leave', icon: CALENDAR_ICON },
      { to: '/portal/training', label: 'My Training', icon: BOOK_ICON },
    ],
  },
  {
    // Per-user filed records — visible to everyone.
    label: 'My Reports',
    items: [
      { to: '/portal/dpr/my', label: 'My Daily Reports', icon: DOC_ICON },
      { to: '/portal/inspection/my', label: 'My Inspection Records', icon: CLIPBOARD_ICON },
      // Round-29: cube-test sidebar entry REMOVED. Cube testing is
      // captured by the cube_casting / cube_testing InspectionRecord
      // sub-types; no standalone cube-test page.
      // Round-29: RFI sidebar entry REMOVED. VOs are standalone work
      // items now; the RFI feature is gone.
      // N7: BOQ variance report — read-only contract-vs-executed view
      // scoped to one project. The page is useful to anyone who files
      // DPR / Inspection rows against a BOQ item, so it lives in the
      // shared "My Reports" group rather than behind the admin tree.
      { to: '/portal/boq', label: 'BOQ Variance', icon: CHART_ICON },
      // [N1 Phase B] My Projects — anchor to the new "My Projects" list.
      // Distinct from the admin /portal/admin/projects registry
      // (which lives under Records). Same icon (BUILDING_ICON) so the
      // visual language stays consistent.
      { to: '/portal/projects', label: 'My Projects', icon: BUILDING_ICON },
    ],
  },
  ...(employee?.isAdmin ? [
    {
      // Approval queues — admin only.
      label: 'Review',
      items: [
        { to: '/portal/admin/dpr', label: 'Daily Reports Review', icon: CHECK_ICON },
        { to: '/portal/admin/inspection', label: 'Inspections Review', icon: GRID_ICON },
        { to: '/portal/admin/leave', label: 'Leave Approvals', icon: CHECKMARK_ICON },
        { to: '/portal/admin/training', label: 'Training Library', icon: GRADUATION_ICON },
        // Round-29: cube-test review queue REMOVED — see My Reports
        // comment above.
      ],
    },
    {
      // Cross-org browse views — admin only.
      label: 'Records',
      items: [
        { to: '/portal/admin/attendance', label: 'All Attendance', icon: ATTENDANCE_ICON },
        { to: '/portal/dpr/all', label: 'All Daily Reports', icon: DOC_ICON },
        { to: '/portal/inspection/all', label: 'All Inspection Records', icon: CLIPBOARD_LIST_ICON },
        // N17 — Project registry. Cross-org browse for admins to register
        // new projects or archive existing ones. Sits under Records because
        // it's the same browse-then-act shape as the other "All …" entries.
        { to: '/portal/admin/projects', label: 'Projects', icon: BUILDING_ICON },
        // N7 — BOQ registry (full CRUD + per-row variance). Admin-only
        // because PATCH/DELETE on boqItem is gated to creator-or-admin
        // server-side; employees read variance on the public page.
        { to: '/portal/admin/boq', label: 'BOQ Registry', icon: LIST_ICON },
        // Round-29: "All RFIs" admin entry REMOVED — RFI feature is gone.
        // Phase-D (N2): Variation Order admin list + detail (drill-in).
        // Also lives under Records because VOs are admin-curated and the
        // page is a cross-org browse with the same UI shape.
        { to: '/portal/admin/variations', label: 'Variations', icon: VARIATION_ICON },
        // N3 (Phase F): Drawing Revision Register. Cross-org browse +
        // create/supersede/archive — admin-curated. Lives under Records
        // alongside the other admin-managed registries.
        { to: '/portal/admin/drawings', label: 'Drawings', icon: DRAWING_ICON },
      ],
    },
    {
      // Admin landing / configuration — admin only.
      label: 'Administration',
      items: [
        { to: '/portal/admin', label: 'Overview', icon: GRID_ICON },
        // N17 — Project dashboard (PM's daily landing). Lives under
        // Administration because it's the "overview per project" page —
        // same intent as the admin Overview, just scoped to one site.
        { to: '/portal/admin/project-dashboard', label: 'Project Dashboard', icon: CHART_ICON },
      ],
    },
  ] : []),
];

  const greeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    return 'Good evening';
  };

  return (
    <div className="portal-layout">
      {/* Round-17 B-02: portal-side skip-nav. Keyboard users Tab through the
          link as the first focusable element and jump to <main id="main-content">. */}
      <SkipNav />
      {/* Mobile backdrop */}
      {isMobile && sidebarOpen && (
        <div className="portal-backdrop" onClick={closeMobileSidebar} />
      )}

      {/* Sidebar */}
      <aside ref={sidebarRef} className={`portal-sidebar ${isMobile ? (sidebarOpen ? 'mobile-open' : '') : (sidebarOpen ? '' : 'collapsed')}`}>
        <div className="portal-sidebar-header">
          <div className="portal-sidebar-logo">
            <div className="logo-icon" style={{ background: 'var(--blue)', width: 36, height: 36, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path d="M10 2L18 16H2L10 2Z" fill="white" />
              </svg>
            </div>
            {sidebarOpen && <span className="portal-sidebar-brand">ACS Portal</span>}
          </div>
          <button
            className="portal-sidebar-toggle"
            onClick={() => setSidebarOpen((o) => !o)}
            aria-label="Toggle sidebar"
            aria-expanded={sidebarOpen}
          >
            <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
              {sidebarOpen
                ? <path d="M15 18l-6-6 6-6" />
                : <path d="M9 18l6-6-6-6" />}
            </svg>
          </button>
        </div>

        <nav className="portal-nav" aria-label="Portal navigation">
          {navGroups.flatMap((group) => {
            // S5 audit: re-render the group divider labels so the sidebar
            // is searchable by section (My Work / My Reports / Review /
            // Records / Administration). The label is wrapped in an
            // <h3> landmark so screen-reader users can jump to a section
            // quickly; hidden when the sidebar is collapsed because the
            // sub-list still has aria-label coverage from the NavLinks.
            //
            // We deliberately keep the labels OFF in icon-only mode — the
            // expanded mode is the only one where labels add information
            // (collapsed mode already shows the icon for each item, and
            // would otherwise become a confusing orphan label stack).
            const labelEls = (sidebarOpen && group.label) ? [
              <h3 key={`label-${group.label}`} className="portal-nav-section-label" aria-hidden="false">
                {group.label}
              </h3>,
            ] : [];
            return [
              ...labelEls,
              ...group.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                onClick={closeMobileSidebar}
                className={({ isActive }) => `portal-nav-item ${isActive ? 'active' : ''}`}
                // SOL-P0#1: stable accessible name + tooltip regardless of
                // sidebar collapse state — required by WCAG 2.4.4 + 4.1.2.
                title={item.label}
                aria-label={item.label}
              >
                <span className="portal-nav-icon" aria-hidden="true">{item.icon}</span>
                {sidebarOpen ? (
                  <span className="portal-nav-label">{item.label}</span>
                ) : (
                  <span className="sr-only">{item.label}</span>
                )}
              </NavLink>
              )),
            ];
          })}
        </nav>

        <div className="portal-sidebar-footer">
          <button
            className="portal-nav-item portal-logout-btn"
            onClick={handleLogout}
            // SOL-P0#1: stable accessible name regardless of sidebar state.
            title="Logout"
            aria-label="Logout"
          >
            <span className="portal-nav-icon" aria-hidden="true">
              <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" />
              </svg>
            </span>
            {sidebarOpen ? (
              <span className="portal-nav-label">Logout</span>
            ) : (
              <span className="sr-only">Logout</span>
            )}
          </button>
        </div>
      </aside>

      {/* Main Content — SOL-P1#9: <main> landmark so screen readers and
          the SOL audit's landmark check recognize this as the page's
          primary content region. tabIndex=-1 makes the skip-nav target
          focusable programmatically without entering the tab order. */}
      <main className="portal-main" id="main-content" tabIndex={-1}>
        {/* Topbar */}
        <header className="portal-topbar">
          <div className="portal-topbar-left">
            <button
              className="portal-mobile-menu"
              onClick={() => setSidebarOpen((o) => !o)}
              aria-label="Toggle menu"
            >
              <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
                <line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            </button>
            <div className="portal-greeting">
              {greeting()}, <strong>{employee?.name?.split(' ')[0] || 'Employee'}</strong>
            </div>
          </div>
          <div className="portal-topbar-right">
            <NotificationBell />
            <div className="portal-topbar-date">
              {formatDateOnly(new Date(), { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}
            </div>
            {/* SOL-P2#19: avatar + account menu replaces the bare sign-out
                button. Sign-out is now inside the dropdown. */}
            <UserMenu />
          </div>
        </header>

        {/* Page Content */}
        <div className="portal-content">
          <Outlet />
        </div>

        {/* Round-17 D-03: bottom tab bar for EMPLOYEES on mobile.
            Admins get the Overview as their landing and use the sidebar for
            review queues — bottom tabs would be the wrong affordance.
            Hidden on desktop via .portal-bottom-tabs display:none @ ≥768px. */}
        {!employee?.isAdmin && (
          <nav className="portal-bottom-tabs" aria-label="Quick navigation">
            <NavLink to="/portal/attendance" className={({ isActive }) => `portal-bottom-tab ${isActive ? 'active' : ''}`}>
              <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
              </svg>
              <span>Attendance</span>
            </NavLink>
            <NavLink to="/portal/dpr/my" className={({ isActive }) => `portal-bottom-tab ${isActive ? 'active' : ''}`}>
              <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /><polyline points="10 9 9 9 8 9" />
              </svg>
              <span>DPR</span>
            </NavLink>
            <NavLink to="/portal/inspection/my" className={({ isActive }) => `portal-bottom-tab ${isActive ? 'active' : ''}`}>
              <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2" /><rect x="9" y="3" width="6" height="4" rx="1" /><path d="M9 14l2 2 4-4" />
              </svg>
              <span>Inspection</span>
            </NavLink>
            <NavLink to="/portal/leave" className={({ isActive }) => `portal-bottom-tab ${isActive ? 'active' : ''}`}>
              <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" />
              </svg>
              <span>Leave</span>
            </NavLink>
            <NavLink to="/portal/training" className={({ isActive }) => `portal-bottom-tab ${isActive ? 'active' : ''}`}>
              <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z" /><path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z" />
              </svg>
              <span>Training</span>
            </NavLink>
          </nav>
        )}
      </main>
    </div>
  );
}
