import React from 'react';

// B-02 (round-17): portal-side skip-nav. The public site has one in
// Header.jsx already; PortalLayout mounts this one so keyboard users in
// the portal can jump past the sidebar straight to <main id="main-content">.
// Visually hidden until focused, then becomes visible + outlined —
// behavior matches the existing `.skip-nav-link` class.
//
// SOL-P1#9: clicking the link explicitly focuses the target so the
// keyboard user's tab order resumes from inside the main landmark
// rather than from the next focusable element after the link itself.

export default function SkipNav() {
  const handleClick = (e) => {
    const target = document.getElementById('main-content');
    if (!target) return;
    e.preventDefault();
    target.focus();
    // Keep the URL hash in sync so the back button / assistive tech
    // can find the destination.
    if (typeof window !== 'undefined' && window.history?.replaceState) {
      window.history.replaceState(null, '', '#main-content');
    }
  };
  return (
    <a href="#main-content" className="skip-nav-link" onClick={handleClick}>
      Skip to main content
    </a>
  );
}
