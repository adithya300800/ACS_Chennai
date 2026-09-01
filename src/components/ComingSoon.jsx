import React from 'react';
import { Link } from 'react-router-dom';

// C-14 (round-17): extracted from App.jsx so the Assets stub and any future
// "Soon" surfaces share the same look. The emoji + headline + copy + back
// link layout matches what App.jsx rendered inline before round-17.

export default function ComingSoon({ name }) {
  return (
    <div className="coming-soon">
      <span className="coming-soon-emoji" aria-hidden="true">🚧</span>
      <h2 className="coming-soon-title">{name} — Coming Soon</h2>
      <p className="coming-soon-message">
        This feature is on our roadmap and will be available in a future update.
      </p>
      <Link to="/" className="coming-soon-back">← Back to website</Link>
    </div>
  );
}
