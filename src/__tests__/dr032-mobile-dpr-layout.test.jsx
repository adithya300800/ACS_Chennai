// DR-032 (audit, 2026-09-08) — mobile DPR progress strip + restored-draft
// banner render correctly at narrow widths (≤390px).
//
// Audit findings:
//   1. App.css:162 (`nav { display: flex; align-items: center; gap: 0.2rem; }`)
//      applied to every <nav>, so FormProgress's <nav className="form-progress">
//      laid out its three children (meta / bar / steps) as a single horizontal
//      row with 0.2rem gap. At 375px that squeezed the step pills and
//      fragmented the recovery banner message.
//   2. DprSubmit.jsx:1164 (restored-draft banner) and DprSubmit.jsx:1855
//      (editing-saved-draft banner) had inline `style={{ flex: 1 }}` on the
//      text span. `flex: 1` expands to `flex: 1 1 0%`, which overrides the
//      stylesheet's intended `flex: 1 1 200px; min-width: 0;` contract at
//      .draft-banner > span. The 0% flex-basis + flex-shrink:1 caused the
//      text to wrap one character per line at 375px.
//
// Source-text contracts pin:
//   - .form-progress declares `display: block` to override the global
//     `nav { display: flex }`.
//   - Neither draft-banner text span carries an inline `flex: 1` override;
//     the children pick up the stylesheet contract instead.
//
// Run: cd src && npx jest __tests__/dr032-mobile-dpr-layout.test.jsx
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const cssPath = resolvePath(__dirname, '../App.css');
const dprPath = resolvePath(__dirname, '../pages/portal/DprSubmit.jsx');

const cssSrc = readFileSync(cssPath, 'utf8');
const dprSrc = readFileSync(dprPath, 'utf8');

// Extract just the .form-progress rule — anchored by class selector and
// closing brace. The stylesheet has multiple `{ ... }` blocks so we slice
// from `.form-progress {` to its matching close using a counting brace scan.
function extractRule(src, selector) {
  const start = src.indexOf(`${selector} {`);
  if (start === -1) return '';
  let i = src.indexOf('{', start);
  let depth = 1;
  let j = i + 1;
  while (j < src.length && depth > 0) {
    const ch = src[j];
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    j += 1;
  }
  return src.slice(start, j);
}

const formProgressRule = extractRule(cssSrc, '.form-progress');

describe('DR-032 — mobile DPR progress + restored-draft layout', () => {
  test('1. .form-progress overrides the inherited `nav { display: flex }`', () => {
    expect(formProgressRule).toBeTruthy();
    // `display: block` resets the element back to default block layout
    // so .form-progress-meta / .form-progress-bar / .form-progress-steps
    // stack vertically on their own internal flex layouts, rather than
    // being squashed into a single row by App.css:162.
    expect(formProgressRule).toMatch(/display:\s*block/);
  });

  test('2. Restored-draft banner span no longer carries inline flex: 1', () => {
    // Find the .draft-banner block in DprSubmit (there are two).
    const draftBannerMatches = [
      ...dprSrc.matchAll(/className="draft-banner"[\s\S]*?<\/div>/g),
    ];
    expect(draftBannerMatches.length).toBeGreaterThanOrEqual(2);
    for (const m of draftBannerMatches) {
      const block = m[0];
      // Pin the regression so no future round reintroduces `flex: 1` and
      // re-shrinks the recovery message at 375px.
      expect(block).not.toMatch(/<span\s+style=\{\{\s*flex:\s*1\s*\}\}/);
      // The banner still contains a span (the message text).
      expect(block).toMatch(/<span>/);
    }
  });

  test('3. .draft-banner > span stylesheet contract preserved (regression guard)', () => {
    // The CSS that the inline override was breaking. Verify it has
    // flex: 1 1 200px (not flex: 1 — that's what crashed the layout).
    const draftBannerSpanRule = extractRule(cssSrc, '.draft-banner > span');
    expect(draftBannerSpanRule).toMatch(/flex:\s*1\s+1\s+200px/);
    expect(draftBannerSpanRule).toMatch(/min-width:\s*0/);
  });
});
