import React, { useState } from 'react';
import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';

export default function PortalLayout() {
  const { employee, logout } = useAuth();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const handleLogout = () => {
    logout();
    navigate('/portal/login');
  };

  const navItems = [
    {
      to: '/portal/attendance',
      label: 'Attendance',
      icon: (
        <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
        </svg>
      ),
    },
    {
      to: '/portal/leave',
      label: 'Leave',
      icon: (
        <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /><polyline points="10 9 9 9 8 9" />
        </svg>
      ),
      comingSoon: true,
    },
    {
      to: '/portal/training',
      label: 'Training',
      icon: (
        <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
          <path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z" /><path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z" />
        </svg>
      ),
      comingSoon: true,
    },
    {
      to: '/portal/assets',
      label: 'Assets',
      icon: (
        <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
          <rect x="2" y="7" width="20" height="14" rx="2" ry="2" /><path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16" />
        </svg>
      ),
      comingSoon: true,
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
      {/* Sidebar */}
      <aside className={`portal-sidebar ${sidebarOpen ? 'open' : 'collapsed'}`}>
        <div className="portal-sidebar-header">
          <div className="portal-sidebar-logo">
            <div className="logo-icon" style={{ background: 'var(--blue)', width: 36, height: 36, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M10 2L18 16H2L10 2Z" fill="white" />
              </svg>
            </div>
            {sidebarOpen && <span className="portal-sidebar-brand">ACS Portal</span>}
          </div>
          <button
            className="portal-sidebar-toggle"
            onClick={() => setSidebarOpen((o) => !o)}
            aria-label="Toggle sidebar"
          >
            <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              {sidebarOpen
                ? <path d="M15 18l-6-6 6-6" />
                : <path d="M9 18l6-6-6-6" />}
            </svg>
          </button>
        </div>

        <nav className="portal-nav">
          {navItems.map((item) => (
            item.comingSoon ? (
              <button
                key={item.to}
                className="portal-nav-item coming-soon"
                onClick={() => {
                  // Simple toast notification
                  const toast = document.createElement('div');
                  toast.className = 'portal-toast';
                  toast.textContent = 'Coming Soon';
                  document.body.appendChild(toast);
                  setTimeout(() => toast.remove(), 2500);
                }}
              >
                <span className="portal-nav-icon">{item.icon}</span>
                {sidebarOpen && <span className="portal-nav-label">{item.label}</span>}
                {sidebarOpen && <span className="portal-nav-soon-badge">Soon</span>}
              </button>
            ) : (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) => `portal-nav-item ${isActive ? 'active' : ''}`}
              >
                <span className="portal-nav-icon">{item.icon}</span>
                {sidebarOpen && <span className="portal-nav-label">{item.label}</span>}
              </NavLink>
            )
          ))}
        </nav>

        <div className="portal-sidebar-footer">
          <button className="portal-nav-item portal-logout-btn" onClick={handleLogout}>
            <span className="portal-nav-icon">
              <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" />
              </svg>
            </span>
            {sidebarOpen && <span className="portal-nav-label">Logout</span>}
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <div className="portal-main">
        {/* Topbar */}
        <header className="portal-topbar">
          <div className="portal-topbar-left">
            <button
              className="portal-mobile-menu"
              onClick={() => setSidebarOpen((o) => !o)}
              aria-label="Toggle menu"
            >
              <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            </button>
            <div className="portal-greeting">
              {greeting()}, <strong>{employee?.name?.split(' ')[0] || 'Employee'}</strong>
            </div>
          </div>
          <div className="portal-topbar-right">
            <div className="portal-topbar-date">
              {new Date().toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}
            </div>
          </div>
        </header>

        {/* Page Content */}
        <div className="portal-content">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
