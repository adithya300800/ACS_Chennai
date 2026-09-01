import React from 'react';

// B-02 (round-17): portal-side skip-nav. The public site has one in
// Header.jsx already; PortalLayout mounts this one so keyboard users in
// the portal can jump past the sidebar straight to <main id="main-content">.
// Visually hidden until focused, then becomes visible + outlined —
// behavior matches the existing `.skip-nav-link` class.

export default function SkipNav() {
  return (
    <a href="#main-content" className="skip-nav-link">
      Skip to main content
    </a>
  );
}
