// Tests for the static privacy-policy page and the homepage + footer
// links that point at it.
//
// Background: Google's OAuth consent screen requires a public privacy
// policy URL that returns HTTP 200, is readable without JavaScript, and
// is linked from the app homepage. The ACS portal is a HashRouter SPA
// served from GitHub Pages, so a React route would 404 the static URL
// check and the JS-rendered footer link is invisible to crawlers.
//
// The fix is a static `public/privacy.html` (Vite copies it to dist/
// as-is) plus a crawler-visible <a> in index.html and an <a> in the
// SPA footer. The Footer test in footer-dr043-no-placeholders.test.jsx
// pins the rendered DOM contract; this file pins the on-disk and
// source-text contracts so a future regression that deletes the file
// or breaks the homepage link is caught without spinning up a browser.
//
// Source-text pins (rather than jsdom) are deliberate: the page is
// served as raw HTML, so the contract is "the file exists on disk and
// contains the required clauses" — not "it renders correctly under a
// specific React tree".

import React from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync, existsSync } from 'fs';
import { resolve as resolvePath } from 'path';

import Footer from '../components/Footer.jsx';

const PRIVACY_HTML_PATH = resolvePath(__dirname, '../../public/privacy.html');
const INDEX_HTML_PATH = resolvePath(__dirname, '../../index.html');

const renderFooter = () =>
  render(
    <MemoryRouter>
      <Footer />
    </MemoryRouter>
  );

describe('Privacy policy — static page + crawlable links', () => {
  test('1. public/privacy.html exists on disk (Vite will copy it to dist/ as-is)', () => {
    expect(existsSync(PRIVACY_HTML_PATH)).toBe(true);
  });

  test('2. privacy.html contains the Google API Services User Data Policy compliance statement (Google OAuth requirement)', () => {
    const html = readFileSync(PRIVACY_HTML_PATH, 'utf8');
    // The exact clause Google's Limited Use policy requires.
    expect(html).toMatch(/Google API Services User Data Policy/);
    expect(html).toMatch(/Limited Use/);
  });

  test('3. privacy.html contains the operator contact email and the revocation URL', () => {
    const html = readFileSync(PRIVACY_HTML_PATH, 'utf8');
    expect(html).toMatch(/info@acschennai\.com/);
    // The revocation URL must be the canonical Google one, not a
    // substring of a different host or path. Anchor it to the href
    // attribute so an attacker can't satisfy the test by sticking the
    // host name inside some other attribute or text node.
    expect(html).toMatch(/href=["']https:\/\/myaccount\.google\.com\/permissions["']/);
  });

  test('4. privacy.html has no <script> tags and no external font/analytics requests (JS-free, indexable)', () => {
    const html = readFileSync(PRIVACY_HTML_PATH, 'utf8');
    // No JS — Google must be able to read the page without executing.
    expect(html).not.toMatch(/<script[\s>]/i);
    // No external font / stylesheet / image requests either — the page
    // is fully self-contained (Google's crawler does not need to wait
    // for subresources to render the policy text).
    expect(html).not.toMatch(/<link[^>]+href=["']https?:/i);
    expect(html).not.toMatch(/@import|googleapis|gstatic/i);
    // No analytics, ads, or third-party trackers.
    expect(html).not.toMatch(/gtag|googletagmanager|hotjar|sentry|mixpanel|segment|amplitude|posthog|facebook\.net/i);
  });

  test('5. privacy.html is not marked noindex (Google must index it)', () => {
    const html = readFileSync(PRIVACY_HTML_PATH, 'utf8');
    // Default if absent is index, follow; the explicit positive form
    // is what the file ships.
    expect(html).toMatch(/<meta\s+name=["']robots["']\s+content=["']index,\s*follow["']/i);
    expect(html).not.toMatch(/<meta\s+name=["']robots["']\s+content=["'][^"']*noindex/i);
  });

  test('6. privacy.html has a visible link back to the apex site (https://acschennai.com)', () => {
    const html = readFileSync(PRIVACY_HTML_PATH, 'utf8');
    expect(html).toMatch(/href=["']https:\/\/acschennai\.com["']/);
  });

  test('7. index.html contains a crawler-visible link to /privacy.html', () => {
    const html = readFileSync(INDEX_HTML_PATH, 'utf8');
    // The link is an <a href="/privacy.html"> in <body>, hidden visually
    // via the .sr-only class so it does not break the marketing chrome.
    // It must exist in the raw HTML (not require JS to render) so
    // Google's consent-screen check can find it.
    expect(html).toMatch(/<a\s+[^>]*href=["']\/privacy\.html["'][^>]*>\s*Privacy Policy\s*<\/a>/i);
  });

  test('8. index.html also declares <link rel="privacy-policy" href="/privacy.html"> in <head> (machine-readable hint)', () => {
    const html = readFileSync(INDEX_HTML_PATH, 'utf8');
    expect(html).toMatch(/<link\s+[^>]*rel=["']privacy-policy["'][^>]*href=["']\/privacy\.html["']/i);
  });

  test('9. Rendered footer has an <a href="/privacy.html">Privacy Policy</a> link', () => {
    renderFooter();
    const links = Array.from(
      document.querySelectorAll('a[href="/privacy.html"]')
    );
    const labels = links.map((a) => a.textContent.trim());
    expect(labels).toContain('Privacy Policy');
  });
});
