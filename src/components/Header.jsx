import React from 'react';
import { Link, useLocation } from 'react-router-dom';

export default function Header() {
  const { pathname } = useLocation();
  return (
    <header>
      <div className="container">
        <Link to="/" className="header-logo">
          <div className="logo-icon">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M10 2L18 16H2L10 2Z" fill="white" />
            </svg>
          </div>
          ACS Chennai
        </Link>
        <nav>
          <Link to="/" className={pathname === "/" ? "active" : ""}>Home</Link>
          <Link to="/about" className={pathname === "/about" ? "active" : ""}>About</Link>
          <Link to="/projects" className={pathname === "/projects" ? "active" : ""}>Projects</Link>
          <Link to="/contact" className={pathname === "/contact" ? "active" : ""}>Contact</Link>
          <Link to="/contact" className="nav-cta">Get a Quote</Link>
        </nav>
      </div>
    </header>
  );
}
