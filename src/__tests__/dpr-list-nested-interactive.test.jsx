// SOL S5-dpr-a11y — DPR list row no longer has a nested interactive.
//
// Audit report (section 5, table row "DPR list"):
//   "Interactive row contains nested Resume button; axe flagged
//    nested-interactive. Use a semantic link/card action plus a
//    separate sibling action."
//
// Pre-fix pattern (axe-rejected):
//   <div role="button" onClick={...} onKeyDown={...}>
//     ...project name...
//     <button onClick={...}>Resume</button>   ← nested interactive
//   </div>
//
// Post-fix pattern (this test pins):
//   <div>
//     <button onClick={...}>{project name}</button>   ← primary
//     <button onClick={...}>Resume</button>          ← sibling
//   </div>
//
// Why source-text checks instead of a mount: DprList pulls in
// StatusBadge, Breadcrumb, PhotoDownloadButton, auth + toast +
// api.js + env. Mirroring the TrainingDashboard mount approach would
// require mocking every one of those, and a regression in the
// structural issue would not necessarily break the mock-stripped
// render. The structural fix lives in JSX text so we assert on JSX
// text — same pattern as DR-020's App.test.jsx regression test.
//
// What this test covers:
//   - the row .map() block no longer hands the row an interactive role
//   - the project-title cell is a <button> with the open-detail handler
//   - the Resume button is rendered as a direct sibling of that button
//     (not a descendant — verified via simple ancestor/descendant scan)

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const dprListPath = resolvePath(__dirname, '../pages/portal/DprList.jsx');
const source = readFileSync(dprListPath, 'utf8');

describe('SOL S5-dpr-a11y — DPR list row is non-interactive wrapper', () => {
  test('row map() no longer gives the row container role=button', () => {
    // The audit caught role=button on the row (a div claiming to be
    // keyboard-activatable) with a nested <button> for Resume. The
    // fix replaces role=button with a plain div and lifts the open-
    // detail action into a child button.
    expect(source).not.toMatch(/dprs\.map[\s\S]{0,200}role="button"/);
  });

  test('row map() no longer hands the row a tabIndex (focusable div)', () => {
    expect(source).not.toMatch(/dprs\.map[\s\S]{0,200}tabIndex=\{0\}/);
  });

  test('project-title cell is a <button> with the open-detail handler', () => {
    // The first <button after the row opens should be the project-
    // title detail-button, not some other widget. Match on the
    // className we added (.dpr-list-item-detail) and the handler
    // reference we kept (handleRowClick).
    expect(source).toMatch(
      /<button[\s\S]{0,200}className="dpr-list-item-detail"[\s\S]{0,400}onClick=\{[^}]*handleRowClick/
    );
  });

  test('Resume is rendered as a SIBLING of the detail button, not a descendant', () => {
    // Find the section: className="dpr-list-item-detail" ... </button>
    // and assert that the next interactive <button> with "Resume" text
    // is OUTSIDE that section. Equivalent to "Resume is not nested
    // inside detail button".
    const detailMatch = source.match(
      /className="dpr-list-item-detail"[\s\S]*?<\/button>/
    );
    expect(detailMatch).not.toBeNull();
    const detailBlock = detailMatch[0];
    // Find the literal "Resume" string after the detail button closes.
    // The JSX writes `>Resume` (with optional whitespace before the
    // closing tag), so a substring search for "Resume" is enough.
    const resumeIndex = source.indexOf('Resume', detailMatch.index + detailBlock.length);
    expect(resumeIndex).toBeGreaterThan(-1);
    // Cross-check: a nested resume would put "Resume" inside the
    // detailBlock. Verify it's NOT there.
    expect(detailBlock).not.toMatch(/Resume/);
  });

  test('CSS focus-visible rule still applies, but to the inner button', () => {
    // The original selector ".dpr-list-item:focus-visible" pinned
    // focus on the row. After the fix, focus lives on the inner
    // detail button. The selector must have been moved there.
    const cssPath = resolvePath(__dirname, '../App.css');
    const css = readFileSync(cssPath, 'utf8');
    expect(css).toMatch(/\.dpr-list-item > \.dpr-list-item-detail:focus-visible/);
  });

  test('row no longer claims pointer cursor (cursor was the row-click affordance)', () => {
    // The .dpr-list-item rule used to set `cursor: pointer` because
    // the row itself was clickable. Now the only clickable surface
    // is the inner detail button, so the row should not advertise a
    // pointer cursor.
    const cssPath = resolvePath(__dirname, '../App.css');
    const css = readFileSync(cssPath, 'utf8');
    expect(css).not.toMatch(/\.dpr-list-item \{[^}]*cursor: pointer/);
  });
});
