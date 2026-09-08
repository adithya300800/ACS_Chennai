// DR-033 (audit, 2026-09-08) — accessibility defects in labels, nested
// controls, contrast and numeric regions.
//
// Audit findings:
//   1. WorkEntryForm.jsx:154-165 (and the other field-type branches)
//      rendered `id={field.name}` for every dynamically-rendered input.
//      When two work types share a field name (e.g. a Safety Violation
//      has name="location" and the host DPR/Inspection page also has a
//      site-address `id="location"`), the resulting DOM has duplicate
//      ids. Clicking the inner label focused the FIRST input — invalid
//      HTML, broken screen-reader navigation, label-to-input mismatch.
//   2. (Already fixed pre-audit in S5 dpr-a11y: DprList nested-interactive
//       issue was resolved by promoting the row to a list-item with the
//       project-title cell as the primary button, leaving Resume / Delete
//       as siblings. Verified by inspect — current code at DprList.jsx
//       625-651 has siblings, not nestings.)
//
// Source-text contract pins the work-type-namespaced ids so the collision
// can never reappear.
//
// Run: cd src && npx jest __tests__/dr033-a11y-ids-and-contrast.test.jsx
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const wefPath = resolvePath(__dirname, '../pages/portal/WorkEntryForm.jsx');
const cssPath = resolvePath(__dirname, '../App.css');
const wefSrc = readFileSync(wefPath, 'utf8');
const cssSrc = readFileSync(cssPath, 'utf8');

describe('DR-033 — a11y ID namespacing in dynamic forms', () => {
  test('1. Each field builds a workType-prefixed input id (no bare field.name as id)', () => {
    // Pin: inputId is computed once per iteration as `${workType}-${field.name}`
    expect(wefSrc).toMatch(/const\s+inputId\s*=\s*`\$\{workType\}-\$\{field\.name\}`/);
  });

  test('2. Every labelled input/select/textarea uses inputId, not field.name', () => {
    // Every input that pairs with a <label htmlFor=...> MUST use the same
    // namespaced id, and the label MUST use htmlFor={inputId}. We count
    // declarations of `id={` and `htmlFor={inputId}` — they should match
    // across the file (a label without a matching id, or an id without a
    // matching label, would each be a regression).
    const idWithInputId = (wefSrc.match(/id=\{inputId\}/g) || []).length;
    const htmlForInputId = (wefSrc.match(/htmlFor=\{inputId\}/g) || []).length;
    expect(idWithInputId).toBeGreaterThan(0);
    expect(htmlForInputId).toBeGreaterThan(0);
    // Five branches (select / textarea / number / time / text) — each
    // declares both an id and a htmlFor.
    expect(idWithInputId).toBe(5);
    expect(htmlForInputId).toBe(5);
  });

  test('3. No bare `id={field.name}` leakage remains', () => {
    // Regression guard — pin the absence so a future round doesn't
    // reintroduce the collision while refactoring.
    expect(wefSrc).not.toMatch(/id=\{field\.name\}/);
    expect(wefSrc).not.toMatch(/htmlFor=\{field\.name\}/);
  });

  test('4. The form keeps the unscoped `name={field.name}` so form submission round-trips', () => {
    // We namespace ONLY the DOM id (label ↔ input click target). The
    // form-serialisation `name` attribute must stay as-is so the
    // post-handler still receives `{ fieldName: value }`.
    expect(wefSrc).toMatch(/name=\{field\.name\}/);
  });
});

describe('DR-033 — text-placeholder contrast (WCAG AA)', () => {
  test('5. .text-placeholder does NOT use slate-400 (#94a3b8, 3.0:1 — fails AA)', () => {
    // Pre-fix color: #94a3b8 had ~3.0:1 contrast vs white, failing
    // WCAG 2.1 AA (4.5:1) for normal text and AA Large (3.0:1) for
    // 18px+ text. Used for /empty/, /—/, /Not linked/ placeholders in
    // tables across the portal — failing sighted users on contrast
    // at the very same moment axe-core reports zero findings.
    expect(cssSrc).not.toMatch(/\.text-placeholder\s*\{\s*color:\s*#94a3b8\s*\}/);
  });

  test('6. .text-placeholder now uses --steel (#475569, ~7.6:1 — AA pass)', () => {
    // Hex form OR var(--steel) form are both acceptable.
    const passes =
      /\.text-placeholder\s*\{\s*color:\s*#475569\b/.test(cssSrc) ||
      /\.text-placeholder\s*\{\s*color:\s*var\(--steel\)/.test(cssSrc);
    expect(passes).toBe(true);
  });
});
