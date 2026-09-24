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
//
// DR-040: an earlier revision also wrote the literal `#main-content`
// hash back onto the history stack so the URL would "match the focus".
// Under HashRouter the fragment IS the route, so that change made the
// router fall through to the portal `*` → NotFound, and a reload right
// after clicking landed on 404. The fix is to keep the URL untouched
// and rely on programmatic focus on the <main> landmark (tabIndex={-1}).
// The href remains so screen readers still announce the destination
// and middle-click / cmd-click open it as a link.

export default function SkipNav() {
  const handleClick = (e) => {
    const target = document.getElementById('main-content');
    if (!target) return;
    e.preventDefault();
    target.focus();
  };
  return (
    <a href="#main-content" className="skip-nav-link" onClick={handleClick}>
      Skip to main content
    </a>
  );
}
