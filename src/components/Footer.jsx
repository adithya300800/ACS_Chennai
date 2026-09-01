import React from 'react';
import { Link } from 'react-router-dom';

export default function Footer() {
  return (
    <footer>
      <div className="container">
        <div className="footer-grid">
          <div className="footer-col">
            <div className="header-logo" style={{ marginBottom: '1rem' }}>
              <div className="logo-icon">
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path d="M10 2L18 16H2L10 2Z" fill="white" />
                </svg>
              </div>
              <span style={{ fontSize: '1rem' }}>ACS Chennai</span>
            </div>
            <p>Construction project management consultancy based in Oragadam, Chennai. Serving clients across India in pharma, chemical, logistics, and industrial construction. Building Tomorrow, Remotely and Reliably.</p>
            <div className="trust-badges" style={{ marginTop: '1rem' }}>
              <span className="trust-badge">
                <svg width="12" height="12" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" /></svg>
                ISO Compliant
              </span>
              <span className="trust-badge">
                <svg width="12" height="12" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" /></svg>
                PCBF Compliant
              </span>
              <span className="trust-badge">
                <svg width="12" height="12" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" /></svg>
                GMP Ready
              </span>
            </div>
          </div>

          <div className="footer-col">
            <h4>Company</h4>
            <Link to="/about">About Us</Link>
            <Link to="/projects">Our Projects</Link>
            <Link to="/contact">Contact</Link>
          </div>

          <div className="footer-col">
            <h4>Services</h4>
            <p style={{ cursor: 'default' }}>Project Management Consultancy</p>
            <p style={{ cursor: 'default' }}>Quality Assurance & Control</p>
            <p style={{ cursor: 'default' }}>Commercial & Contract Management</p>
            <p style={{ cursor: 'default' }}>Planning & Scheduling</p>
            <p style={{ cursor: 'default' }}>Safety Management</p>
            <p style={{ cursor: 'default' }}>Billing Verification</p>
          </div>

          <div className="footer-col">
            <h4>Stay Updated</h4>
            <p>Get project insights and industry updates.</p>
            <div className="newsletter-form">
              <input type="email" placeholder="your@email.com" />
              <button className="btn btn-primary" style={{ padding: '0.55rem 0.85rem', fontSize: '0.85rem' }} aria-label="Subscribe to newsletter">
                <svg width="14" height="14" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true"><path fillRule="evenodd" d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" clipRule="evenodd" /></svg>
              </button>
            </div>
            <div className="footer-social" style={{ marginTop: '1.2rem' }}>
              <a href="#" aria-label="LinkedIn">
                <svg width="16" height="16" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.848 3.37-1.848 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
              </a>
              <a href="#" aria-label="Twitter/X">
                <svg width="16" height="16" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
              </a>
            </div>
          </div>
        </div>

        <div className="footer-bottom">
          <p>&copy; {new Date().getFullYear()} ACS Chennai. All rights reserved.</p>
          <div style={{ display: 'flex', gap: '1.2rem' }}>
            <a href="#" style={{ fontSize: '0.82rem' }}>Privacy Policy</a>
            <a href="#" style={{ fontSize: '0.82rem' }}>Terms of Service</a>
          </div>
        </div>
      </div>
    </footer>
  );
}
