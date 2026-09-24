// DR-040 — skip-navigation links (public Header.jsx + portal SkipNav.jsx)
// must not overwrite the HashRouter location.
//
// Bug: clicking the public `href="#main-content"` jumped the hash
// straight to `main-content`; HashRouter then matched the fragment
// against its routes and fell through to the public `*` → NotFound.
// The portal SkipNav did the same thing via
// `window.history.replaceState(null, '', '#main-content')` after
// preventDefault. A reload right after clicking either link landed
// the user on a 404 instead of the page they were on.
//
// Fix: preventDefault on the click + programmatic focus on the existing
// <main id="main-content"> (tabIndex={-1}) + NO history mutation. The
// href stays in the DOM so screen readers still announce the
// destination and middle-click / cmd-click open it as a link.
//
// Pins:
//   1. Both components declare `e.preventDefault()` in their click path.
//   2. Neither component mutates `window.history` (replaceState /
//      pushState / assign / location.href).
//   3. Behavioral (jsdom): clicking the SkipNav link moves focus to
//      <main> and leaves `window.location.hash` unchanged. The same
//      shape is asserted source-text for Header because Header needs
//      react-router + AuthContext (the defect is structural, not
//      render-dependent).

import React from 'react';
import { fireEvent, render } from '@testing-library/react';
import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const read = (rel) => readFileSync(resolvePath(__dirname, '..', rel), 'utf8');

const headerSrc = read('components/Header.jsx');
const skipNavSrc = read('components/SkipNav.jsx');
const mainJsxSrc = read('main.jsx'); // pin: HashRouter unchanged

describe('DR-040 — skip-nav public (Header.jsx)', () => {
  test('the skip-nav link carries an onClick that calls e.preventDefault', () => {
    // Pin the structural contract: a click handler is attached AND it
    // calls preventDefault on the synthetic event. A bare
    // `href="#main-content"` (the pre-fix shape) had no onClick at all.
    expect(headerSrc).toMatch(/href=["']#main-content["']/);
    expect(headerSrc).toMatch(/onClick=\{[\s\S]*?e\.preventDefault\(\)/);
  });

  test('the onClick focuses <main id="main-content"> (no history mutation)', () => {
    // The fix must move keyboard focus to the main landmark and must
    // NOT touch window.history. The pre-fix SkipNav.jsx used
    // `window.history.replaceState(null, '', '#main-content')`; the
    // public Header never had an onClick. Both must be absent now.
    const skipBlock = headerSrc.match(/onClick=\{[\s\S]*?\}\s*\}/);
    expect(skipBlock).not.toBeNull();
    expect(skipBlock[0]).toMatch(/document\.getElementById\(['"]main-content['"]\)/);
    expect(skipBlock[0]).toMatch(/\.focus\(\)/);
    // Guard against a regression that re-introduces history mutation.
    expect(skipBlock[0]).not.toMatch(/history\.(replaceState|pushState|go|back)/);
    expect(skipBlock[0]).not.toMatch(/location\.href\s*=/);
  });

  test('main.jsx still mounts HashRouter (router was not changed by the fix)', () => {
    // The audit explicitly forbids swapping to BrowserRouter. Pin it so
    // a future refactor can't silently undo DR-040's premise.
    expect(mainJsxSrc).toMatch(/import\s+\{\s*HashRouter\s*\}\s+from\s+['"]react-router-dom['"]/);
    expect(mainJsxSrc).toMatch(/<HashRouter>/);
    expect(mainJsxSrc).not.toMatch(/BrowserRouter/);
  });
});

describe('DR-040 — skip-nav portal (SkipNav.jsx)', () => {
  test('click handler calls e.preventDefault and focuses the target', () => {
    expect(skipNavSrc).toMatch(/e\.preventDefault\(\)/);
    expect(skipNavSrc).toMatch(/document\.getElementById\(['"]main-content['"]\)/);
    expect(skipNavSrc).toMatch(/target\.focus\(\)/);
  });

  test('no window.history mutation remains (DR-040 removed replaceState)', () => {
    // The previous shape `window.history.replaceState(... '#main-content')`
    // is what made a reload land on 404. Pin its absence so a future
    // contributor can't quietly add it again to "make the URL match the
    // focus" — that's exactly the bug DR-040 closes.
    expect(skipNavSrc).not.toMatch(/history\.(replaceState|pushState|go|back)/);
    expect(skipNavSrc).not.toMatch(/location\.href\s*=/);
    expect(skipNavSrc).not.toMatch(/#main-content['"]\)/); // no hash arg
  });

  test('the link still has href="#main-content" (a11y + middle-click preserved)', () => {
    // Per the brief, the href MUST stay so screen readers announce the
    // destination and middle-click / cmd-click open it as a link.
    expect(skipNavSrc).toMatch(/href=["']#main-content["']/);
    expect(skipNavSrc).toMatch(/skip-nav-link/);
  });
});

describe('DR-040 — SkipNav behavioral (jsdom)', () => {
  // Mount-free source for PortalLayout (it transitively imports the
  // router graph), but SkipNav itself has zero external dependencies,
  // so a real mount is fast and proves the contract end-to-end.
  let SkipNav;
  beforeAll(() => {
    SkipNav = require('../components/SkipNav.jsx').default;
  });

  beforeEach(() => {
    // Plant a realistic HashRouter URL so any accidental history
    // mutation would be observable as a hash change.
    window.history.replaceState(null, '', '#/portal/dashboard');
  });

  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  test('click moves focus to <main id="main-content"> without changing the hash', () => {
    // Provide the <main> landmark the skip-nav points to. It needs
    // tabIndex={-1} to be focusable, mirroring the production markup
    // in App.jsx / PortalLayout.jsx.
    const { getByText, getByTestId } = render(
      <>
        <SkipNav />
        <main id="main-content" data-testid="main-landmark" tabIndex={-1}>
          body
        </main>
      </>
    );

    const link = getByText('Skip to main content');
    const main = getByTestId('main-landmark');

    expect(main).not.toHaveFocus();
    fireEvent.click(link);
    expect(main).toHaveFocus();
    // The HashRouter fragment is unchanged — DR-040 acceptance:
    // "Skip, reload, Back, and deep link all retain the correct page".
    expect(window.location.hash).toBe('#/portal/dashboard');
  });

  test('click calls preventDefault (browser would not navigate to the hash)', () => {
    const { getByText } = render(
      <>
        <SkipNav />
        <main id="main-content" tabIndex={-1} />
      </>
    );

    // fireEvent.click's event object exposes defaultPrevented after the
    // handler returns. If preventDefault wasn't called, this is false
    // and the click would have followed the #main-content href.
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    fireEvent(getByText('Skip to main content'), event);
    expect(event.defaultPrevented).toBe(true);
  });

  test('a missing <main> target is a safe no-op (no throw, no URL change)', () => {
    // Defensive: if the landmark isn't rendered yet, the click should
    // not crash and must not have left the previous URL in a bad state.
    const { getByText } = render(<SkipNav />);
    expect(() => fireEvent.click(getByText('Skip to main content'))).not.toThrow();
    expect(window.location.hash).toBe('#/portal/dashboard');
  });
});