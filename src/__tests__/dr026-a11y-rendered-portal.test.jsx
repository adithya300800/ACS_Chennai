// SOL DR-026 — accessibility repairs now cover the rendered portal.
//
// Reassessment finding (2026-09-08, 7cc65ca):
//   "The inspection list exposed `listitem` without required parent
//    semantics. Nested controls remain in admin DPR and inspection photo
//    interactions. The live MAJOR badge failed contrast..."
//
// Three defect classes are pinned here:
//
//  1. listitem without a list parent  (axe `listitem`)
//     InspectionList renders role="listitem" cards inside a plain grid
//     <div>. Fix: the grid carries role="list".
//
//  2. nested-interactive  (axe `nested-interactive`)
//     PhotoDownloadButton renders an <a>. It used to be a *child* of the
//     open-lightbox <button> in four photo grids, so keyboard users hit
//     an anchor inside a button. Fix: siblings under a positioned div.
//     Verified structurally by scanning for a `</button>` between the
//     photo `<button` open tag and the `<PhotoDownloadButton` call.
//
//  3. MAJOR severity contrast  (axe `color-contrast`)
//     InspectionDetail hard-coded #f59e0b on #fef3c7 (~1.9:1). Fix:
//     reuse the shared SeverityBadge, which now maps MINOR/MAJOR onto
//     the .severity-pill palette (#854d0e on #fef3c7 ≈ 7.4:1).
//
// Source-text pins are used for (1) and (2) for the same reason as
// dpr-list-nested-interactive.test.jsx: these pages pull in auth, toast,
// api.js and env, and the defect is structural JSX, not render output.
// (3) is a real mount because SeverityBadge has no such dependencies.

import React from 'react';
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const read = (rel) => readFileSync(resolvePath(__dirname, '..', rel), 'utf8');

describe('DR-026 (1) — inspection list listitem has a list parent', () => {
  const src = read('pages/portal/InspectionList.jsx');

  test('the card grid that holds role="listitem" carries role="list"', () => {
    // The grid container opens immediately before `inspections.map(`.
    expect(src).toMatch(/<div\s+role="list"[\s\S]{0,200}\{inspections\.map\(/);
  });

  test('every role="listitem" in the file is still present (roles not just deleted)', () => {
    expect(src).toMatch(/role="listitem"/);
  });
});

describe('DR-026 (2) — photo download anchor is a sibling, not a descendant', () => {
  // Each entry: [file, the aria-label prefix that identifies the photo button]
  const GRIDS = [
    'pages/portal/InspectionDetail.jsx',
    'pages/portal/DprList.jsx',
    'pages/portal/DprAll.jsx',
    'pages/admin/DprDashboard.jsx',
  ];

  test.each(GRIDS)('%s closes the photo <button> before <PhotoDownloadButton', (rel) => {
    const src = read(rel);
    const idx = src.indexOf('<PhotoDownloadButton');
    expect(idx).toBeGreaterThan(-1);

    // Walk back from the PhotoDownloadButton call to the nearest preceding
    // `<button` open tag. If a `</button>` sits between them, the anchor is
    // a sibling. If not, the anchor is still nested inside the button.
    const before = src.slice(0, idx);
    const lastOpen = before.lastIndexOf('<button');
    expect(lastOpen).toBeGreaterThan(-1);
    const lastClose = before.lastIndexOf('</button>');
    expect(lastClose).toBeGreaterThan(lastOpen);
  });

  test.each(GRIDS)('%s still renders the download affordance (feature not dropped)', (rel) => {
    expect(read(rel)).toMatch(/<PhotoDownloadButton\s+photo=/);
  });
});

describe('DR-026 (3) — MAJOR severity uses the shared, AA-contrast badge', () => {
  let SeverityBadge;
  beforeAll(() => {
    SeverityBadge = require('../components/SeverityBadge.jsx').default;
  });

  test('MAJOR renders with severity-pill-major (not the medium fallback)', () => {
    render(<SeverityBadge severity="MAJOR" />);
    expect(screen.getByText('Major').className).toContain('severity-pill-major');
  });

  test('MINOR renders with severity-pill-minor (not the medium fallback)', () => {
    render(<SeverityBadge severity="MINOR" />);
    expect(screen.getByText('Minor').className).toContain('severity-pill-minor');
  });

  test('canonical severity meaning survives — raw enum stays in aria-label', () => {
    render(<SeverityBadge severity="MAJOR" />);
    expect(screen.getByLabelText('Severity: MAJOR')).toBeTruthy();
  });

  test('App.css defines the MINOR/MAJOR pill palettes the badge references', () => {
    const css = read('App.css');
    expect(css).toMatch(/\.severity-pill-minor\s*\{[^}]*color:\s*#475569/);
    expect(css).toMatch(/\.severity-pill-major\s*\{[^}]*color:\s*#854d0e/);
  });

  test('InspectionDetail no longer hard-codes the failing #f59e0b MAJOR pill', () => {
    const src = read('pages/portal/InspectionDetail.jsx');
    // Quoted form only — the fix comment mentions the hex by name.
    expect(src).not.toMatch(/'#f59e0b'/);
    expect(src).toMatch(/import\s+SeverityBadge\s+from\s+['"]\.\.\/\.\.\/components\/SeverityBadge\.jsx['"]/);
    expect(src).toMatch(/<SeverityBadge\s+severity=\{record\.severity\}\s*\/>/);
  });
});
