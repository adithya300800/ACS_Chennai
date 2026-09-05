import React from 'react';
import { render, screen } from '@testing-library/react';

// S5 audit: pin the inspection-browse badge fix so it cannot regress.
// The original round-15 audit found that "filters expose status/severity
// but browse cards do not consistently display them". These tests ensure
//  1. The SeverityBadge component exists and exports a default.
//  2. Each canonical severity renders with the expected CSS class so the
//     audit's colour-coding expectation stays actionable.
//  3. null/undefined/empty render nothing — so callers don't have to guard
//     before dropping in `insp.severity`.
//  4. InspectionAll source pins both StatusBadge and SeverityBadge on every
//     card so the audit's regression class cannot reappear (assertion-only,
//     mount-free to avoid the jsdom + react-router DOM cost we already pay
//     in InspectionList's existing test).

describe('SeverityBadge (S5 audit: filtered attributes on browse cards)', () => {
  let SeverityBadge;
  beforeAll(() => {
    SeverityBadge = require('../components/SeverityBadge.jsx').default;
  });

  test('is exported as default from src/components/SeverityBadge.jsx', () => {
    expect(typeof SeverityBadge).toBe('function');
  });

  test('renders nothing for null / undefined / empty', () => {
    const { container: a } = render(<SeverityBadge severity={null} />);
    expect(a.firstChild).toBeNull();
    const { container: b } = render(<SeverityBadge severity={undefined} />);
    expect(b.firstChild).toBeNull();
    const { container: c } = render(<SeverityBadge severity="" />);
    expect(c.firstChild).toBeNull();
  });

  test('LOW renders with severity-pill-low', () => {
    render(<SeverityBadge severity="LOW" />);
    expect(screen.getByText('Low').className).toContain('severity-pill-low');
  });

  test('MEDIUM renders with severity-pill-medium', () => {
    render(<SeverityBadge severity="MEDIUM" />);
    expect(screen.getByText('Medium').className).toContain('severity-pill-medium');
  });

  test('HIGH renders with severity-pill-high', () => {
    render(<SeverityBadge severity="HIGH" />);
    expect(screen.getByText('High').className).toContain('severity-pill-high');
  });

  test('CRITICAL renders with severity-pill-critical', () => {
    render(<SeverityBadge severity="CRITICAL" />);
    expect(screen.getByText('Critical').className).toContain('severity-pill-critical');
  });

  test('falls back to medium styling for unknown severity', () => {
    render(<SeverityBadge severity="MAYBE" />);
    // Unknown severities show the raw enum value (no label) + medium palette
    expect(screen.getByText('MAYBE').className).toContain('severity-pill-medium');
  });

  test('exposes the raw enum via aria-label for screen-reader users', () => {
    render(<SeverityBadge severity="CRITICAL" />);
    expect(screen.getByLabelText('Severity: CRITICAL')).toBeTruthy();
  });
});

describe('InspectionAll.jsx — filtered attributes pinned on browse cards', () => {
  let src;
  beforeAll(() => {
    src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'pages', 'portal', 'InspectionAll.jsx'),
      'utf8',
    );
  });

  test('imports StatusBadge', () => {
    expect(src).toMatch(/import\s+StatusBadge\s+from\s+['"]\.\.\/\.\.\/components\/StatusBadge\.jsx['"]/);
  });

  test('imports SeverityBadge', () => {
    expect(src).toMatch(/import\s+SeverityBadge\s+from\s+['"]\.\.\/\.\.\/components\/SeverityBadge\.jsx['"]/);
  });

  test('renders both badges inside the card grid', () => {
    // The map((insp) => …) callback should contain both <StatusBadge status={insp.status} />
    // and <SeverityBadge severity={insp.severity} /> so the audit cannot reappear.
    expect(src).toMatch(/<StatusBadge\s+status=\{insp\.status\}\s*\/>/);
    expect(src).toMatch(/<SeverityBadge\s+severity=\{insp\.severity\}\s*\/>/);
  });
});

describe('InspectionList.jsx — local SeverityBadge removed in favour of shared', () => {
  let src;
  beforeAll(() => {
    src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'pages', 'portal', 'InspectionList.jsx'),
      'utf8',
    );
  });

  test('uses the shared SeverityBadge (no local component)', () => {
    // We assert both halves of the refactor: the import is there, and the
    // page no longer defines a local one.
    expect(src).toMatch(/import\s+SeverityBadge\s+from\s+['"]\.\.\/\.\.\/components\/SeverityBadge\.jsx['"]/);
    expect(src).not.toMatch(/function\s+SeverityBadge\s*\(\{/);
  });
});

describe('InspectionDashboard.jsx — local SeverityBadge removed in favour of shared', () => {
  let src;
  beforeAll(() => {
    src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'pages', 'admin', 'InspectionDashboard.jsx'),
      'utf8',
    );
  });

  test('uses the shared SeverityBadge (no local component)', () => {
    expect(src).toMatch(/import\s+SeverityBadge\s+from\s+['"]\.\.\/\.\.\/components\/SeverityBadge\.jsx['"]/);
    expect(src).not.toMatch(/function\s+SeverityBadge\s*\(\{/);
  });
});
