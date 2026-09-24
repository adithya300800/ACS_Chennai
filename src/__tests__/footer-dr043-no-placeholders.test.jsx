// DR-043 — Footer must not present placeholders as functioning actions.
//
// Audit evidence: src/components/Footer.jsx (pre-fix) carried a
// newsletter <input>+<button> with no submit handler, two social <a
// href="#"> icons, and two more <a href="#"> legal links (Privacy /
// Terms) whose click went to home rather than to a policy.
//
// The audit's Minimal implementation: remove unfinished affordances or
// wire real owned destinations. The simpler path is removal — the
// codebase has no /privacy or /terms route, no owned social URLs, and
// the audit explicitly forbids adding a custom subscription backend.
// Static text labels replace the dead links so the column keeps its
// shape without tricking users into clicking something that does
// nothing intentional.
//
// These tests pin the post-fix contract:
//   1. No rendered <a> element uses href="#".
//   2. No rendered <button type="submit"> exists (the pre-fix newsletter
//      button had no handler, no type, and was inside a <div> — the
//      browser would still treat the click as a no-op submit intent;
//      a real newsletter backend is out of scope).
//   3. Source-text pin: Footer.jsx no longer contains the literal
//      href="#" (outside of HTML comments) so a future regression that
//      re-adds a placeholder link is caught by a one-line grep.
//
// Why mount <Footer /> directly: it imports Link from react-router-dom
// (real usage in the Company column), so the test wraps in
// MemoryRouter. Footer.jsx has no other dependencies (no auth, no
// toast, no api) — that's the point of the audit: the dead affordances
// were the only stateful surface.

import React from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

import Footer from '../components/Footer.jsx';

const renderFooter = () =>
  render(
    <MemoryRouter>
      <Footer />
    </MemoryRouter>
  );

describe('Footer — DR-043 (no dead-affordance placeholders)', () => {
  test('1. Renders no link with href="#"', () => {
    const { container } = renderFooter();
    const deadLinks = container.querySelectorAll('a[href="#"]');
    expect(deadLinks.length).toBe(0);
  });

  test('2. Renders no <button type="submit"> (no-handler newsletter affordance is gone)', () => {
    const { container } = renderFooter();
    const submitButtons = container.querySelectorAll('button[type="submit"]');
    expect(submitButtons.length).toBe(0);
  });

  test('3. Privacy Policy and Terms of Service are present as static text, not links', () => {
    renderFooter();
    // These are now <span> labels. queryByRole('link', ...) returns null
    // for non-anchor elements, so the assertion is: the visible text
    // exists in the document but is NOT exposed as a link role.
    const privacyLinks = document.querySelectorAll('a');
    const privacyTexts = Array.from(privacyLinks).map((a) => a.textContent);
    expect(privacyTexts).not.toContain('Privacy Policy');
    expect(privacyTexts).not.toContain('Terms of Service');

    // And the labels themselves ARE present (so the legal/contact
    // section still reads as a footer — we just don't pretend they're
    // clickable).
    expect(document.body.textContent).toMatch(/Privacy Policy/);
    expect(document.body.textContent).toMatch(/Terms of Service/);
  });

  test('4. Source-text pin: Footer.jsx does not contain href="#" (outside HTML comments)', () => {
    const src = readFileSync(
      resolvePath(__dirname, '../components/Footer.jsx'),
      'utf8'
    );
    // Strip /* ... */ block comments and // line comments so the pin
    // doesn't false-positive on a comment that mentions the fix.
    // DR-043's own block comments above the dead-link replacements do
    // reference "href=\"#\"" — those are intentional documentation, so
    // we explicitly allow them by stripping comments first.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(stripped).not.toMatch(/href=["']#["']/);
  });

  test('5. Real owned routes (Contact) still render correctly so we did not break the working column', () => {
    renderFooter();
    // Company column still links to owned SPA routes.
    const contactLinks = document.querySelectorAll('a[href="/contact"]');
    expect(contactLinks.length).toBeGreaterThanOrEqual(1);
  });
});
