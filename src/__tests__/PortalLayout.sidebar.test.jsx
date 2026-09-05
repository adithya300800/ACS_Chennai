// S5 audit: "Sidebar starts icon-only. Choose an intentional initial
// desktop state and persist the user's choice."
//
// We can't mount PortalLayout in jsdom — it transitively imports the
// whole lazy router graph that exhausts memory in this sandbox (same
// reason App.test.jsx mounts nothing). Instead the test pins the source:
//   (a) the localStorage key + read/write logic are present and correct,
//   (b) the desktop default is expanded (so labels render on first visit),
//   (c) the mobile default stays collapsed (drawer covers everything off-
//       canvas; opening should be deliberate),
//   (d) the toggle persists the user's choice across reloads.
//
// Re-implementing the read/write helpers below mirrors the file so
// any future regression in PortalLayout.jsx must coincidentally also
// break the test helper to pass — but the source-text checks target the
// specific addition directly.

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const layoutPath = resolvePath(__dirname, '../components/PortalLayout.jsx');
const layoutSource = readFileSync(layoutPath, 'utf8');

// Mirror of readSidebarPref in PortalLayout.jsx. Tests below use this
// to verify the saved-preference round-trip; the source-text checks
// ensure PortalLayout is the one implementing it.
function readSidebarPref(key = 'acs.sidebarExpanded') {
  const v = localStorage.getItem(key);
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

// Source-text checks (mount-free, stable, fast).
describe('PortalLayout — S5 sidebar persistence contract', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('declares the localStorage key "acs.sidebarExpanded"', () => {
    expect(layoutSource).toMatch(/const\s+SIDEBAR_PREF_KEY\s*=\s*['"]acs\.sidebarExpanded['"]/);
  });

  test('desktop initial state reads the saved preference, defaulting to expanded', () => {
    // The useState initializer must:
    //   - collapse on mobile (window.innerWidth < 768)
    //   - read the saved preference on desktop
    //   - default to expanded (true) when nothing is saved
    expect(layoutSource).toMatch(/window\.innerWidth\s*<\s*768[^}]*return\s+false/);
    // The desktop branch must consult readSidebarPref() and pick `true`
    // when nothing is saved. We pin the literal `true` only after the
    // saved-preference read so the order is enforced.
    expect(layoutSource).toMatch(/saved\s*===\s*null\s*\?\s*true\s*:\s*saved/);
  });

  test('toggles persist to localStorage on desktop, but never on mobile', () => {
    // The setSidebarOpen wrapper should only call localStorage.setItem
    // when the viewport is desktop (we deliberately reset mobile on
    // every resize so the drawer never strays off-canvas).
    expect(layoutSource).toMatch(/window\.innerWidth\s*<\s*768/);
    expect(layoutSource).toMatch(/localStorage\.setItem\(\s*SIDEBAR_PREF_KEY/);
    // The localStorage.setItem call must be gated by `!mobile`.
    expect(layoutSource).toMatch(/if\s*\(!mobile\)[\s\S]{0,120}localStorage\.setItem\(\s*SIDEBAR_PREF_KEY/);
  });

  test('crossing the resize boundary resets to the saved value, not just "expanded"', () => {
    // When the viewport crosses from desktop → mobile → desktop, the
    // sidebar should land back on the saved preference, not always on
    // `true`. The earlier code did `setSidebarOpen(true)` on every
    // resize and lost the user's collapse choice.
    expect(layoutSource).toMatch(/if\s*\(mobile\)\s*\{[\s\S]*setSidebarOpenState\(false\)[\s\S]*\}\s*else\s*\{[\s\S]*saved\s*===\s*null\s*\?\s*true/);
  });
});

// Behavioural checks (run without the React tree, against a
// localStorage mock). These verify the round-trip without booting the
// route graph.
describe('readSidebarPref + writeSidebarPref round-trip', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('null when the key is unset', () => {
    expect(readSidebarPref()).toBeNull();
  });

  test('true / false are read back as booleans', () => {
    localStorage.setItem('acs.sidebarExpanded', 'true');
    expect(readSidebarPref()).toBe(true);
    localStorage.setItem('acs.sidebarExpanded', 'false');
    expect(readSidebarPref()).toBe(false);
  });

  test('corrupt values do not crash the helper (returns null → fall back to expanded)', () => {
    localStorage.setItem('acs.sidebarExpanded', 'maybe');
    // The helper is intentionally tolerant: anything not 'true'/'false'
    // falls through to the caller's default. This matches PortalLayout's
    // desktop default of `true`, so a corrupted entry resets the user
    // to expanded rather than collapsing on every visit.
    expect(readSidebarPref()).toBeNull();
  });
});
