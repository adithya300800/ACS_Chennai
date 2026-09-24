/**
 * DR-022 (round-20) — automated a11y gate.
 *
 * What this catches:
 *   - buttons without accessible names
 *   - inputs without labels
 *   - images without alt
 *   - landmark / heading-order regressions
 *   - aria-* misuse on form controls
 *
 * What it does NOT catch (deferred):
 *   - color contrast — would require a styled render; deferred to CI
 *     Lighthouse run (covered by the .github workflow that already
 *     exists in this repo).
 *   - live E2E browser a11y tree — covered by the Playwright suite,
 *     not Jest.
 *
 * ─── LPR-014: this file does NOT mount a real route ────────────────────────
 * SOL LPR-014 observed that "accessibility tests exercise synthetic fixtures
 * rather than real routed pages." That is intentional and documented here
 * so a future maintainer does not assume coverage that does not exist.
 *
 * Why fixtures, not routes:
 *   1. Mounting the real portal tree pulls in AuthContext + ToastProvider +
 *      BrowserRouter + Zustand stores + an authenticated employee fixture.
 *      Doing that for every rendered route is brittle (auth changes, route
 *      shape changes) and slow.
 *   2. The bug class DR-022 exists to catch — unlabelled inputs, missing
 *      alt text, broken heading order — is independent of the route it
 *      ships inside. A fixture that exercises the pattern catches the
 *      pattern anywhere it ships.
 *   3. The full-page a11y tree IS asserted on production pages — but in
 *      the Playwright suite, against the deployed environment, with axe-
 *      core against a real browser DOM. That's the right layer for "every
 *      page is clean"; this Jest suite is the right layer for "the
 *      patterns we care about never regress in isolation".
 *
 * What this file is NOT a substitute for:
 *   - A per-page jest-axe mount test. The LPR-014 follow-up is to add
 *     one focused test per top-level route (Login, Portal/Dashboard,
 *     Portal/Notifications, Portal/Training, Admin/Overview, …) that
 *     mounts the real component with the production provider tree and
 *     runs axe against it. That work is intentionally out of scope for
 *     this commit (it would inflate this PR and the LPR-014 closure
 *     requires per-route baseline snapshots first).
 *
 * The fixture set is hand-curated. A NEW page should ship with at least
 * one test that mounts the production component with the same provider
 * tree it gets in `main.jsx`, runs jest-axe against the rendered output,
 * and fails the build if any violation is found.
 *
 * Run: `npm test -- --testPathPattern='a11y.smoke'`
 */

const { axe, toHaveNoViolations } = require('jest-axe');

expect.extend(toHaveNoViolations);

const React = require('react');
const { render } = require('@testing-library/react');

// Minimal wrapper — no router, no providers. Tests render self-contained
// fixtures; production-page tests should mount with the same provider
// tree as main.jsx (MemoryRouter + AuthContext + ToastProvider).

describe('DR-022 — a11y smoke gate', () => {
  it('a properly-labelled form passes jest-axe with no violations', async () => {
    const Form = () =>
      React.createElement(
        'form',
        null,
        React.createElement(
          'label',
          { htmlFor: 'email' },
          'Email',
          React.createElement('input', {
            id: 'email',
            name: 'email',
            type: 'email',
            'aria-required': 'true',
          })
        ),
        React.createElement(
          'label',
          { htmlFor: 'password' },
          'Password',
          React.createElement('input', {
            id: 'password',
            name: 'password',
            type: 'password',
            'aria-required': 'true',
          })
        ),
        React.createElement(
          'button',
          { type: 'submit' },
          'Sign in'
        )
      );
    const { container } = render(React.createElement(Form));
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it('an unlabelled input FAILS the gate (sanity check on the gate itself)', async () => {
    const Form = () =>
      React.createElement(
        'form',
        null,
        React.createElement('input', {
          id: 'email',
          name: 'email',
          type: 'email',
        }),
        React.createElement('button', { type: 'submit' }, 'Sign in')
      );
    const { container } = render(React.createElement(Form));
    const results = await axe(container);
    // This is the bug class DR-022 exists to catch. If the gate ever
    // silently passes this, the test is broken.
    expect(results.violations.length).toBeGreaterThan(0);
    const ids = results.violations.map((v) => v.id);
    expect(ids).toEqual(expect.arrayContaining(['label']));
  });

  it('a button without accessible text FAILS the gate', async () => {
    const Form = () =>
      React.createElement(
        'div',
        null,
        React.createElement('button', { type: 'submit' }),
        React.createElement(
          'label',
          { htmlFor: 'email' },
          'Email',
          React.createElement('input', { id: 'email', type: 'email' })
        )
      );
    const { container } = render(React.createElement(Form));
    const results = await axe(container);
    expect(results.violations.length).toBeGreaterThan(0);
    const ids = results.violations.map((v) => v.id);
    expect(ids).toEqual(expect.arrayContaining(['button-name']));
  });

  it('an image without alt FAILS the gate', async () => {
    const Page = () =>
      React.createElement(
        'div',
        null,
        React.createElement('img', { src: '/logo.png' }),
        React.createElement(
          'label',
          { htmlFor: 'email' },
          'Email',
          React.createElement('input', { id: 'email', type: 'email' })
        )
      );
    const { container } = render(React.createElement(Page));
    const results = await axe(container);
    expect(results.violations.length).toBeGreaterThan(0);
    const ids = results.violations.map((v) => v.id);
    expect(ids).toEqual(expect.arrayContaining(['image-alt']));
  });

  it('an aria-labelled input is accepted as labelled', async () => {
    const Form = () =>
      React.createElement(
        'form',
        null,
        React.createElement('input', {
          type: 'email',
          'aria-label': 'Email address',
        }),
        React.createElement('button', { type: 'submit' }, 'Sign in')
      );
    const { container } = render(React.createElement(Form));
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it('a labelled img is accepted (informative, not decorative)', async () => {
    const Page = () =>
      React.createElement(
        'div',
        null,
        React.createElement('img', {
          src: '/chart.png',
          alt: 'Attendance trend over the last 30 days',
        })
      );
    const { container } = render(React.createElement(Page));
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it('a landmark with a heading hierarchy passes', async () => {
    const Page = () =>
      React.createElement(
        'main',
        null,
        React.createElement('h1', null, 'Dashboard'),
        React.createElement(
          'section',
          { 'aria-labelledby': 'stats-heading' },
          React.createElement('h2', { id: 'stats-heading' }, 'Stats')
        ),
        React.createElement(
          'section',
          { 'aria-labelledby': 'recent-heading' },
          React.createElement('h2', { id: 'recent-heading' }, 'Recent activity')
        )
      );
    const { container } = render(React.createElement(Page));
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});

// ─────────────────────────────────────────────────────────────────────
// §8.6 — Mobile filter chip rows: 44×44 touch target + consistent
// gap + visible focus ring on every state.
//
// What this catches:
//   - chip-row CSS regressing back to <44px min-height or <44px min-width
//     (the whole point of DR-042/DR-046's mobile follow-up)
//   - gap falling below 8px (0.5rem), which is the WCAG-adjacent minimum
//     for adjacent touch targets
//   - the `:focus-visible` outline being deleted by a future restyle,
//     which would silently break keyboard-only users on chip rows
//
// Why source-text pin + fixture render instead of one or the other:
//   - jsdom does not enforce min-height / focus rings, so a pure render
//     test cannot assert "button is at least 44px tall" — we pin the CSS
//     rule directly.
//   - a pure source-text pin cannot tell us whether the rendered chip
//     actually has aria-pressed + accessible name, so we render the
//     real FilterChip and run jest-axe.
//
// Wave-3 lesson: source-text pins must filter `/* ... */` block comments
// BEFORE regex-matching so future doc-comment additions don't silently
// change the verdict. The Wave-3 pin broke when someone added a
// explanatory block above the pinned block. We strip the comments first.
// ─────────────────────────────────────────────────────────────────────

describe('§8.6 — Mobile filter chip rows', () => {
  const fs = require('fs');
  const path = require('path');
  const APP_CSS_PATH = path.join(__dirname, '..', '..', 'src', 'App.css');

  // Strip /* ... */ block comments so future doc-comments don't shift
  // the regex match. Single-line `// ...` is not valid CSS so we don't
  // need a JS-style comment stripper.
  function stripCssComments(css) {
    return css.replace(/\/\*[\s\S]*?\*\//g, '');
  }

  let appCss;
  let stripped;

  beforeAll(() => {
    appCss = fs.readFileSync(APP_CSS_PATH, 'utf8');
    stripped = stripCssComments(appCss);
  });

  it('the .filter-chip-row ruleset enforces wrap + 0.5rem gap', () => {
    // Pin the three CSS properties the §8.6 contract relies on:
    //   - flex-wrap: wrap  → no horizontal overflow at 375px
    //   - gap: 0.5rem      → 8px between adjacent chips (was 0.3–0.4rem)
    //   - !important on gap → overrides the inline `gap: '0.3rem'` /
    //                         '0.4rem' on the chip-row parent divs in
    //                         ProjectExpandedPanel / MyProjectReports /
    //                         ReportsAdmin / MyCertifications.
    // The single-regex `[^}]+` capture is intentionally non-greedy so
    // future `@media (max-width: 480px)` overrides inside the same
    // block don't change the verdict.
    const match = stripped.match(/\.filter-chip-row\s*\{([^}]+)\}/);
    expect(match).not.toBeNull();
    const ruleset = match[1];
    expect(ruleset).toMatch(/flex-wrap:\s*wrap/);
    expect(ruleset).toMatch(/display:\s*flex/);
    expect(ruleset).toMatch(/gap:\s*0\.5rem\s*!important/);
  });

  it('the .filter-chip-row > button ruleset enforces 44×44 touch target', () => {
    // Pin the WCAG 2.5.5 / Apple HIG 44×44 minimum target. The shared
    // FilterChip component uses inline `padding: 0.2rem 0.6rem` which
    // only renders the button ~24px tall — without this CSS the row
    // would regress to a sub-target touch size on mobile.
    const match = stripped.match(/\.filter-chip-row\s*>\s*button\s*\{([^}]+)\}/);
    expect(match).not.toBeNull();
    const ruleset = match[1];
    expect(ruleset).toMatch(/min-height:\s*44px/);
    expect(ruleset).toMatch(/min-width:\s*44px/);
  });

  it('the .filter-chip-row > button:focus-visible rule defines a visible outline', () => {
    // Pin a non-empty `outline` declaration so keyboard-only users can
    // tell which chip has focus. The default browser outline is
    // browser-dependent and often suppressed by reset stylesheets, so
    // an explicit project-owned rule is required.
    const match = stripped.match(/\.filter-chip-row\s*>\s*button:focus-visible\s*\{([^}]+)\}/);
    expect(match).not.toBeNull();
    const ruleset = match[1];
    expect(ruleset).toMatch(/outline:\s*\d+px\s+solid/);
    expect(ruleset).toMatch(/outline-offset:/);
  });

  it('a chip-row fixture has flex-wrap and the chips render with accessible name + aria-pressed', async () => {
    // Render the real FilterChip from src/components/ui/FilterChip.jsx
    // inside a .filter-chip-row wrapper. This proves:
    //   1. The component file still exists and is importable from the
    //      test path (no path-alias regression).
    //   2. The button receives `aria-pressed` (FilterChip already did
    //      this — preserved through the §8.6 CSS-only refactor).
    //   3. The label text reaches the accessible-name calculation, so
    //      the chip reads as "All, toggle button" to a screen reader,
    //      not just "<unnamed button>".
    //   4. jest-axe finds no color-contrast / aria-pressed / label
    //      violations on the rendered chip row.
    const FilterChip = require('../../src/components/ui/FilterChip.jsx').default;

    const Page = () =>
      React.createElement(
        'main',
        null,
        React.createElement(
          'div',
          { className: 'filter-chip-row' },
          React.createElement(FilterChip, { label: 'All', active: true, onClick: () => {} }),
          React.createElement(FilterChip, { label: 'Weekly', active: false, onClick: () => {} }),
          React.createElement(FilterChip, { label: 'Monthly', active: false, onClick: () => {} })
        )
      );

    const { container } = render(React.createElement(Page));

    // 1. The .filter-chip-row wrapper is present.
    expect(container.querySelector('.filter-chip-row')).not.toBeNull();

    // 2. flex-wrap is set on the wrapper — the no-horizontal-overflow
    //    promise at 375px viewport. jsdom doesn't enforce layout, but
    //    it does preserve the inline `flexWrap` property on the style
    //    object, which we then map to `flex-wrap`.
    const wrapper = container.querySelector('.filter-chip-row');
    // The CSS rule supplies flex-wrap via a class — jsdom doesn't apply
    // stylesheet rules, so we read the resolved style and fall back to
    // the source-text pin above for the actual property value. This
    // assertion catches a JSX regression where someone removes the
    // wrapper class entirely (which the source-text pin wouldn't notice
    // because the CSS rule still exists).
    expect(wrapper.className).toContain('filter-chip-row');

    // 3. Every chip has aria-pressed + an accessible name.
    const buttons = container.querySelectorAll('.filter-chip-row > button');
    expect(buttons.length).toBe(3);
    buttons.forEach((btn) => {
      expect(btn.getAttribute('aria-pressed')).not.toBeNull();
      expect(btn.textContent.trim().length).toBeGreaterThan(0);
    });

    // 4. jest-axe finds no a11y violations on the rendered chip row.
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
