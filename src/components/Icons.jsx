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

export function ClockIcon({ size = 14, style }) {
  return (
    <svg width={size} height={size} {...ICON_BASE} style={style}>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

export function DocIcon({ size = 14, style }) {
  return (
    <svg width={size} height={size} {...ICON_BASE} style={style}>
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="9" y1="13" x2="15" y2="13" />
      <line x1="9" y1="17" x2="13" y2="17" />
    </svg>
  );
}

export function BookIcon({ size = 14, style }) {
  return (
    <svg width={size} height={size} {...ICON_BASE} style={style}>
      <path d="M4 19.5A2.5 2.5 0 016.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" />
    </svg>
  );
}

export function PlaneIcon({ size = 14, style }) {
  return (
    <svg width={size} height={size} {...ICON_BASE} style={style}>
      <path d="M17.8 19.2L16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z" />
    </svg>
  );
}

export function BellIcon({ size = 14, style }) {
  return (
    <svg width={size} height={size} {...ICON_BASE} style={style}>
      <path d="M6 8a6 6 0 0112 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 003.4 0" />
    </svg>
  );
}

// Phase-D (N2): UserIcon — used by Variation detail (raised by /
// approved-by) so the "who" rows have a consistent person glyph. Mirrors
// the line-icon style of the other Icons (24x24 viewBox, stroke=2,
// currentColor). (Round-29: the RFI detail page that also used this
// icon was removed.)
export function UserIcon({ size = 14, style }) {
  return (
    <svg width={size} height={size} {...ICON_BASE} style={style}>
      <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}
