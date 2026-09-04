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