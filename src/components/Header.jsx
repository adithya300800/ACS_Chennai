import React from 'react';
import { Link, useLocation } from 'react-router-dom';

export default function Header() {
  const { pathname } = useLocation();
  return (
    <header>
      <div className="container">
        <h1>ACS Chennai <span className="accent">/ VirtualOffice</span></h1>
        <nav>
          <Link to="/" className={pathname === "/" ? "active" : ""}>Home</Link>
          <Link to="/about" className={pathname === "/about" ? "active" : ""}>About</Link>
          <Link to="/projects" className={pathname === "/projects" ? "active" : ""}>Projects</Link>
          <Link to="/team" className={pathname === "/team" ? "active" : ""}>Team</Link>
          <Link to="/careers" className={pathname === "/careers" ? "active" : ""}>Careers</Link>
          <Link to="/blog" className={pathname === "/blog" ? "active" : ""}>Blog</Link>
          <Link to="/contact" className={pathname === "/contact" ? "active" : ""}>Contact</Link>
        </nav>
      </div>
    </header>
  );
}