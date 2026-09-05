// S5 audit: "Restore concise grouped sections: My Work, Reports, Review,
// Records, Administration". Pins the source so the audit's regression
// class cannot reappear silently — re-introducing a flat 13-item list
// (the round-22 layout) fails these tests immediately.
//
// Mount-free: PortalLayout transitively imports the lazy router graph
// that exhausts memory in this sandbox (see App.test.jsx). Source-text
// checks below are deterministic and run in <1ms.

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const layoutPath = resolvePath(__dirname, '../components/PortalLayout.jsx');
const src = readFileSync(layoutPath, 'utf8');

describe('PortalLayout — S5 nav grouping taxonomy', () => {
  test('declares the five audit-mandated section labels (everyone-visible)', () => {
    // My Work + My Reports render for everyone. Review / Records /
    // Administration are admin-only — see the admin block below.
    expect(src).toMatch(/label:\s*['"]My Work['"]/);
    expect(src).toMatch(/label:\s*['"]My Reports['"]/);
  });

  test('declares the three admin-only section labels', () => {
    expect(src).toMatch(/label:\s*['"]Review['"]/);
    expect(src).toMatch(/label:\s*['"]Records['"]/);
    expect(src).toMatch(/label:\s*['"]Administration['"]/);
  });

  test('Review/Records/Administration are wrapped in a ...(employee?.isAdmin ? [...]) spread', () => {
    // The whole admin block must be conditional on isAdmin so employees
    // don't see "Leave Approvals" or "Training Library" in their sidebar.
    expect(src).toMatch(/\.\.\.\(employee\?\.isAdmin\s*\?/);
    // N5+N7+N17 (round-29): grew the Records + Administration groups with
    // Cube Tests Review, BOQ Registry, Projects, and Project Dashboard.
    // The 800-char window in the S5 baseline is too tight for the post-
    // N17 sidebar; we widened to 3000 so the test still asserts "all three
    // labels exist in the same admin block" without re-tightening every
    // round.
    expect(src).toMatch(/label:\s*['"]Review['"][\s\S]{0,3000}label:\s*['"]Records['"][\s\S]{0,3000}label:\s*['"]Administration['"]/);
  });

  test('renders <h3 className="portal-nav-section-label"> for each non-empty group', () => {
    // Round-22 collapsed these to a flat list. The audit requires the
    // labels to come back, and only when the sidebar is expanded.
    expect(src).toMatch(/<h3[^>]*className=['"]portal-nav-section-label['"][^>]*>\s*\{group\.label\}/);
  });

  test('labels are gated by `sidebarOpen` (hidden in icon-only mode)', () => {
    // Icon-only mode already conveys items via NavLink title + aria-label,
    // so stacking orphan labels above each icon column would be
    // confusing rather than informative.
    const block = src.match(/const\s+labelEls[^;]+;/);
    expect(block).toBeTruthy();
    expect(block[0]).toMatch(/sidebarOpen/);
    expect(block[0]).toMatch(/group\.label/);
  });

  test('Logout is outside the grouped nav (still rendered as a footer button)', () => {
    // Logout has its own .portal-sidebar-footer block — make sure the
    // refactor didn't accidentally lift it into the grouped nav.
    expect(src).toMatch(/portal-sidebar-footer/);
    expect(src).toMatch(/portal-logout-btn/);
    // The Logout NavLink variant is not present anywhere.
    expect(src).not.toMatch(/to=['"]\/portal\/logout['"]/);
  });
});
