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
            {/* DR-043: the previous newsletter form had no submit handler and the
                social/privacy/terms links pointed at href="#". Those dead affordances
                are removed; we keep only static, intentional content here until a real
                owned destination (subscription backend, official social URLs, or a
                published privacy/terms page) exists. */}
            <p>Project insights and industry updates — coming soon.</p>
          </div>
        </div>

        <div className="footer-bottom">
          <p>&copy; {new Date().getFullYear()} ACS Chennai. All rights reserved.</p>
          <div style={{ display: 'flex', gap: '1.2rem' }}>
            {/* DR-043: Privacy Policy / Terms of Service were href="#" placeholders.
                No real policy destination exists yet — render as plain text labels
                (no role, no tabindex) instead of dead links that navigate to home. */}
            <span style={{ fontSize: '0.82rem' }}>Privacy Policy</span>
            <span style={{ fontSize: '0.82rem' }}>Terms of Service</span>
          </div>
        </div>
      </div>
    </footer>
  );
}
