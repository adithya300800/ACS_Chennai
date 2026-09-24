/**
 * §8.12 (Fresh24 wave-4 batch-B) — consistent archive banner.
 *
 * The Fresh24 audit found archive UX drift across modules:
 *   - TrainingCourseDetail had a local `training-pill-archived` element
 *   - DrawingsBrowse rendered an inline archive error string
 *   - BillingCertificationsAdmin kept a `STATUS_BADGE_STYLES` map that
 *     was missing an ARCHIVED entry
 *   - ProjectsAdmin used a local "Inactive" pill with bespoke inline styles
 *
 * The fix is a single shared `RecordStatusBadge` component with three
 * canonical states: archived / deleted / unavailable. Each module's
 * source text must import + reference the badge so the copy ("Archived"
 * / "Deleted" / "Unavailable") reads identically across modules.
 *
 * Wave-3 lesson (Fresh24): filter JS comments before regex matching so
 * the audit-rationale prose at the top of every changed file doesn't
 * false-positive the pin.
 */

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

function stripComments(src) {
  return src
    .split('\n')
    .filter((line) => {
      const t = line.trimStart();
      if (t.startsWith('//')) return false;
      if (t.startsWith('/*')) return false;
      if (t.startsWith('*')) return false;
      return true;
    })
    .join('\n');
}

const MODULES = [
  {
    name: 'TrainingCourseDetail',
    path: 'src/pages/admin/TrainingCourseDetail.jsx',
    requireArchived: true,
  },
  {
    name: 'DrawingsBrowse',
    path: 'src/pages/portal/DrawingsBrowse.jsx',
    requireArchived: true,
  },
  {
    name: 'BillingCertificationsAdmin',
    path: 'src/pages/admin/BillingCertificationsAdmin.jsx',
    requireArchived: true,
  },
  {
    name: 'ProjectsAdmin',
    path: 'src/pages/admin/ProjectsAdmin.jsx',
    requireArchived: true,
  },
];

describe('§8.12 — shared RecordStatusBadge canonical copy', () => {
  let badgeSrc;
  beforeAll(() => {
    badgeSrc = stripComments(
      readFileSync(
        resolvePath(__dirname, '..', 'components', 'RecordStatusBadge.jsx'),
        'utf8',
      ),
    );
  });

  test('RecordStatusBadge.jsx is the single source of truth for the three-state copy', () => {
    // Each state maps to its canonical label. A regression that adds a
    // state without a label here would silently render as the enum.
    expect(badgeSrc).toMatch(/archived:\s*['"]Archived['"]/);
    expect(badgeSrc).toMatch(/deleted:\s*['"]Deleted['"]/);
    expect(badgeSrc).toMatch(/unavailable:\s*['"]Unavailable['"]/);
  });

  test('RecordStatusBadge.jsx exports a default React component', () => {
    expect(badgeSrc).toMatch(/export\s+default\s+function\s+RecordStatusBadge/);
  });

  test('RecordStatusBadge renders nothing for null / undefined / empty state', () => {
    expect(badgeSrc).toMatch(/if\s*\(\s*!state\s*\)\s*return\s+null/);
  });

  test('RecordStatusBadge falls back to the `unavailable` palette for unknown states', () => {
    expect(badgeSrc).toMatch(/RECORD_STATE_CLASS\[state\]\s*\|\|\s*RECORD_STATE_CLASS\.unavailable/);
  });
});

describe('§8.12 — each archive-touched module imports + references RecordStatusBadge', () => {
  MODULES.forEach(({ name, path, requireArchived }) => {
    let src;
    beforeAll(() => {
      src = stripComments(
        readFileSync(resolvePath(__dirname, '..', '..', path), 'utf8'),
      );
    });

    test(`${name} imports RecordStatusBadge`, () => {
      expect(src).toMatch(
        new RegExp(`import\\s+RecordStatusBadge\\s+from\\s+['"]\\.\\./\\.\\./components/RecordStatusBadge\\.jsx['"]`),
      );
    });

    test(`${name} renders RecordStatusBadge with state="archived"`, () => {
      // Wave-3 lesson: the regex must catch JSX usages, not the import
      // path comment. The state prop may be a string literal OR an
      // expression (e.g. `isArchived ? 'archived' : null`) so we accept
      // either pattern.
      expect(src).toMatch(/<RecordStatusBadge\s+state=/);
      // The expression has to actually reference the "archived" enum —
      // not e.g. a "DRAFT" / "Deleted" string. Match both literal and
      // ternary forms.
      expect(src).toMatch(/<RecordStatusBadge\s+state=['"]archived['"]|state=\{[^}]*archived[^}]*\}/);
    });
  });
});

describe('§8.12 — three-state label vocabulary is canonical', () => {
  test('Archived copy appears in the badge source', () => {
    const src = stripComments(
      readFileSync(
        resolvePath(__dirname, '..', 'components', 'RecordStatusBadge.jsx'),
        'utf8',
      ),
    );
    expect(src).toMatch(/['"]Archived['"]/);
  });

  test('Deleted copy appears in the badge source', () => {
    const src = stripComments(
      readFileSync(
        resolvePath(__dirname, '..', 'components', 'RecordStatusBadge.jsx'),
        'utf8',
      ),
    );
    expect(src).toMatch(/['"]Deleted['"]/);
  });

  test('Unavailable copy appears in the badge source', () => {
    const src = stripComments(
      readFileSync(
        resolvePath(__dirname, '..', 'components', 'RecordStatusBadge.jsx'),
        'utf8',
      ),
    );
    expect(src).toMatch(/['"]Unavailable['"]/);
  });
});