import React, { useState, useRef, useCallback } from 'react';
import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useToast } from '../contexts/ToastContext.jsx';
import NotificationBell from './NotificationBell.jsx';
// Round-17: shared skip-nav + focus-trap + keyboard-shortcut primitives.
import SkipNav from './SkipNav.jsx';
import useFocusTrap from '../hooks/useFocusTrap.js';
import useKeyboardShortcut from '../hooks/useKeyboardShortcut.js';

export default function PortalLayout() {
  const { employee, logout } = useAuth();
  const navigate = useNavigate();
  const { push: pushToast } = useToast();
  const [sidebarOpen, setSidebarOpen] = useState(false); // Start collapsed on mobile
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  const sidebarRef = useRef(null);

  // Handle resize
  React.useEffect(() => {
    const handleResize = () => {
      const mobile = window.innerWidth < 768;
      setIsMobile(mobile);
      if (!mobile) setSidebarOpen(true); // Auto-expand on desktop
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

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

  // P0/A-03: sidebar is now grouped under section labels (Personal / Reports /
  // Approve) instead of 13 flat items. P1/A-04: dropped the "New DPR" and
  // "New Inspection" CTAs — the relevant pages already have a "+ New" CTA
  // pinned in their own list/header.
  const navGroups = [
    {
      label: null, // first group has no header — landing/today items
      items: [
        {
          to: '/portal/attendance',
          label: 'My Attendance',
          icon: (
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
            </svg>
          ),
        },
        {
          to: '/portal/leave',
          label: 'My Leave',
          icon: (
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /><polyline points="10 9 9 9 8 9" />
            </svg>
          ),
        },
        {
          to: '/portal/training',
          label: 'My Training',
          icon: (
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z" /><path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z" />
            </svg>
          ),
        },
      ],
    },
    {
      label: 'Field Reports',
      items: [
        {
          to: '/portal/dpr/my',
          label: 'My Daily Reports',
          icon: (
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /><polyline points="10 9 9 9 8 9" />
            </svg>
          ),
        },
        {
          to: '/portal/inspection/my',
          label: 'My Inspection Records',
          icon: (
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2" /><rect x="9" y="3" width="6" height="4" rx="1" /><path d="M9 14l2 2 4-4" />
            </svg>
          ),
        },
      ],
    },
    ...(employee?.isAdmin ? [{
      label: 'Admin',
      items: [
        {
          to: '/portal/admin',
          label: 'Overview',
          icon: (
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
              <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" />
            </svg>
          ),
        },
        {
          to: '/portal/admin/attendance',
          label: 'All Attendance',
          icon: (
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
            </svg>
          ),
        },
        {
          to: '/portal/admin/dpr',
          label: 'Daily Reports Review',
          icon: (
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
            </svg>
          ),
        },
        {
          to: '/portal/admin/inspection',
          label: 'Inspections Review',
          icon: (
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
              <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" />
            </svg>
          ),
        },
        {
          to: '/portal/inspection/all',
          label: 'All Inspection Records',
          icon: (
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
              <rect x="9" y="3" width="6" height="4" rx="1" /><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2" />
            </svg>
          ),
        },
        {
          to: '/portal/admin/leave',
          label: 'Leave Approvals',
          icon: (
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ),
        },
        {
          to: '/portal/admin/training',
          label: 'Training Library',
          icon: (
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M22 10v6M2 10l10-5 10 5-10 5z" /><path d="M6 12v5c3 3 9 3 12 0v-5" />
            </svg>
          ),
        },
      ],
    }] : []),
    {
      label: 'Coming soon',
      items: [
        {
          to: '/portal/assets',
          label: 'Assets',
          comingSoon: true,
          icon: (
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
              <rect x="2" y="7" width="20" height="14" rx="2" ry="2" /><path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16" />
            </svg>
          ),
        },
      ],
    },
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

        <nav className="portal-nav">
          {navGroups.map((group, gi) => (
            <React.Fragment key={group.label || `__group_${gi}`}>
              {group.label && sidebarOpen && (
                <div className="portal-nav-section-label">{group.label}</div>
              )}
              {group.items.map((item) => (
                item.comingSoon ? (
                  <button
                    key={item.to}
                    className="portal-nav-item coming-soon"
                    onClick={() => {
                      // P2/C-14: replaced ad-hoc document.createElement toast with
                      // the proper ToastContext used elsewhere in the app.
                      pushToast('Assets module is coming soon.', 'info');
                    }}
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
                    {sidebarOpen && <span className="portal-nav-soon-badge">Soon</span>}
                  </button>
                ) : (
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
                )
              ))}
            </React.Fragment>
          ))}
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
              {new Date().toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}
            </div>
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
