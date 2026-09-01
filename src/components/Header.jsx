import React, { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';

export default function Header() {
  const { pathname } = useLocation();
  const { isAuthenticated } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);

  const navLinks = [
    { to: "/", label: "Home" },
    { to: "/about", label: "About" },
    { to: "/projects", label: "Projects" },
    { to: "/contact", label: "Contact" },
    ...(isAuthenticated
      ? [{ to: "/portal/attendance", label: "My Portal" }]
      : [{ to: "/portal/login", label: "Employee Portal" }]),
  ];

  return (
    <header>
      {/* Round-10 a11y (WCAG 2.4.1 Bypass Blocks, Level A): skip-nav link.
          First focusable element on the page — keyboard users (Tab on load)
          can jump past the nav straight to <main id="main-content">.
          Visually hidden until focused, then becomes visible + outlines. */}
      <a href="#main-content" className="skip-nav-link">
        Skip to main content
      </a>
      <div className="container">
        <Link to="/" className="header-logo">
          <div className="logo-icon">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <path d="M10 2L18 16H2L10 2Z" fill="white" />
            </svg>
          </div>
          ACS Chennai
        </Link>
        <nav className={mobileOpen ? 'mobile-open' : ''}>
          {navLinks.map(({ to, label }) => (
            <Link
              key={to}
              to={to}
              className={pathname === to ? "active" : ""}
              onClick={() => setMobileOpen(false)}
            >
              {label}
            </Link>
          ))}
          <Link to="/contact" className="nav-cta" onClick={() => setMobileOpen(false)}>Get a Quote</Link>
        </nav>
        <button
          className="mobile-menu-toggle"
          aria-label="Toggle menu"
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen(o => !o)}
        >
          <svg width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
            {mobileOpen
              ? <path d="M18 6L6 18M6 6l12 12" />
              : <path d="M3 12h18M3 6h18M3 18h18" />}
          </svg>
        </button>
      </div>
    </header>
  );
}
