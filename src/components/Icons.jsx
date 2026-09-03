import React from 'react';

// SOL-P2#15: shared line-icon system. Mirrors PortalLayout's existing 18x18
// stroke style (fill="none", stroke="currentColor", strokeWidth="2",
// strokeLinecap="round", strokeLinejoin="round"). All Icons accept a
// `size` prop (defaults to 14 — the inline-meta size used across card
// headers). Pass `style` to override color via currentColor inheritance.
const ICON_BASE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: '2',
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  viewBox: '0 0 24 24',
  'aria-hidden': 'true',
  focusable: 'false',
};

export function CalendarIcon({ size = 14, style }) {
  return (
    <svg width={size} height={size} {...ICON_BASE} style={style}>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}

export function MapPinIcon({ size = 14, style }) {
  return (
    <svg width={size} height={size} {...ICON_BASE} style={style}>
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

export function CameraIcon({ size = 14, style }) {
  return (
    <svg width={size} height={size} {...ICON_BASE} style={style}>
      <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  );
}

export function ClipboardIcon({ size = 14, style }) {
  return (
    <svg width={size} height={size} {...ICON_BASE} style={style}>
      <path d="M9 2h6a1 1 0 011 1v2H8V3a1 1 0 011-1z" />
      <path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2" />
      <line x1="9" y1="11" x2="15" y2="11" />
      <line x1="9" y1="15" x2="13" y2="15" />
    </svg>
  );
}

export function PaperclipIcon({ size = 14, style }) {
  return (
    <svg width={size} height={size} {...ICON_BASE} style={style}>
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

export function BuildingIcon({ size = 14, style }) {
  return (
    <svg width={size} height={size} {...ICON_BASE} style={style}>
      <rect x="4" y="2" width="16" height="20" rx="1" />
      <line x1="9" y1="6" x2="9" y2="6" />
      <line x1="15" y1="6" x2="15" y2="6" />
      <line x1="9" y1="10" x2="9" y2="10" />
      <line x1="15" y1="10" x2="15" y2="10" />
      <line x1="9" y1="14" x2="9" y2="14" />
      <line x1="15" y1="14" x2="15" y2="14" />
      <path d="M10 22v-4h4v4" />
    </svg>
  );
}
