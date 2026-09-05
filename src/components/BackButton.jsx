import React from 'react';
import { Link, useNavigate } from 'react-router-dom';

// SOL-P2 improvement #8: shared "back to list" anchor for detail pages.
// If `to` is given, renders a Link (no history pollution — re-entering a
// detail page won't put two entries on the back stack). Otherwise calls
// navigate(-1). Both code paths surface the same visible "← Back"
// treatment so detail pages look uniform across the portal.
//
// `label` defaults to "Back" but detail pages usually pass a specific
// destination like "Back to Variation Orders" so the user knows where
// they will land. `className` is exposed so the page can swap the
// default `.back-button` for a ghost variant in tight UI (e.g. modal
// header).
export default function BackButton({ to, label = 'Back', className = 'back-button', style }) {
  const navigate = useNavigate();
  const text = `← ${label}`;
  if (to) {
    return (
      <Link to={to} className={className} style={style} aria-label={text}>
        {text}
      </Link>
    );
  }
  return (
    <button
      type="button"
      className={className}
      style={style}
      onClick={() => navigate(-1)}
      aria-label={text}
    >
      {text}
    </button>
  );
}
