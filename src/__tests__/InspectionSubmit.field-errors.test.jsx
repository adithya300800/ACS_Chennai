// S5 audit: inline + linked field errors on the inspection form.
// The audit found "Inspection errors are a banner/toast rather than
// linked field errors; repeated error contrast findings".
//
// Two new contracts to pin:
//   1. Single-string `error` state has been retired in favour of
//      `formError` (banner) + `fieldErrors` (per-field map).
//   2. Each validated field carries `aria-invalid` + an `aria-describedby`
//      pointing at an inline message.
//   3. The summary banner includes a clickable list of failed fields
//      that focus the matching input.

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const path = resolvePath(__dirname, '../pages/portal/InspectionSubmit.jsx');
const src = readFileSync(path, 'utf8');
const css = readFileSync(resolvePath(__dirname, '../App.css'), 'utf8');

describe('InspectionSubmit — S5 inline + linked field errors', () => {
  describe('state shape', () => {
    test('uses formError + fieldErrors state, not the old single error string', () => {
      expect(src).toMatch(/useState\(['"]\s*['"]\)/);
      // Both halves of the split must exist:
      const formErrorDecl = src.match(/const\s+\[formError,\s*setFormError\]\s*=\s*useState/);
      const fieldErrorsDecl = src.match(/const\s+\[fieldErrors,\s*setFieldErrors\]\s*=\s*useState/);
      expect(formErrorDecl).toBeTruthy();
      expect(fieldErrorsDecl).toBeTruthy();
    });

    test('no longer declares the old `error` state', () => {
      // The single-string variant must be retired — any future
      // re-introduction undoes the WCAG-friendly per-field model.
      const singleError = src.match(/const\s+\[error,\s*setError\]\s*=\s*useState/);
      expect(singleError).toBeFalsy();
    });
  });

  describe('inline field markup', () => {
    test('projectName input wires aria-invalid + aria-describedby', () => {
      const block = src.match(/<input[^>]*id="projectName"[^>]*>/);
      expect(block).toBeTruthy();
      expect(block[0]).toMatch(/aria-invalid=\{fieldErrors\.projectName/);
      expect(block[0]).toMatch(/aria-describedby=\{[^}]*'projectName-error'/);
    });

    test('location input wires aria-invalid + aria-describedby', () => {
      const block = src.match(/<input[^>]*id="location"[^>]*>/);
      expect(block).toBeTruthy();
      expect(block[0]).toMatch(/aria-invalid=\{fieldErrors\.location/);
      expect(block[0]).toMatch(/aria-describedby=\{[^}]*'location-error'/);
    });

    test('reportDate input wires aria-invalid + aria-describedby', () => {
      const block = src.match(/<input[^>]*id="reportDate"[^>]*>/);
      expect(block).toBeTruthy();
      expect(block[0]).toMatch(/aria-invalid=\{fieldErrors\.reportDate/);
      expect(block[0]).toMatch(/aria-describedby=\{[^}]*'reportDate-error'/);
    });

    test('renders an inline error div under each validated field', () => {
      for (const f of ['projectName', 'location', 'reportDate']) {
        expect(src).toContain(`id="${f}-error"`);
        expect(src).toContain('className="form-field-error"');
      }
    });
  });

  describe('summary banner with focus links', () => {
    test('renders summary banner with role="alert" + aria-live', () => {
      expect(src).toMatch(/id="inspection-form-error-summary"[^>]*role="alert"/);
      expect(src).toMatch(/aria-live="polite"/);
    });

    test('summary list contains a button per failed field that calls focusFirstInvalid', () => {
      expect(src).toMatch(/<ul[^>]*className="inspection-form-summary-list"/);
      expect(src).toMatch(/inspection-form-summary-link/);
      expect(src).toMatch(/onClick=\{\(\) => focusFirstInvalid\(\{ \[k\]: true \}\)\}/);
    });
  });

  describe('focus-first-invalid behaviour', () => {
    test('defines focusFirstInvalid that focuses each field ref', () => {
      expect(src).toMatch(/const\s+focusFirstInvalid\s*=\s*useCallback/);
      expect(src).toMatch(/projectNameRef/);
      expect(src).toMatch(/locationRef/);
      expect(src).toMatch(/reportDateRef/);
      expect(src).toMatch(/workEntryRef/);
    });

    test('submit clears both banner + per-field error state at the start', () => {
      // The handleSubmit entry must reset both halves before validating.
      expect(src).toMatch(/clearErrors\(\);\s*\/\/\s*\[DR-006 client\]/);
    });
  });
});

describe('App.css — S5 inline error + summary styles', () => {
  test('defines .form-input-invalid (red border for invalid fields)', () => {
    expect(css).toMatch(/\.form-input-invalid\s*\{/);
  });

  test('defines .form-field-error (inline message style, AA-passing)', () => {
    expect(css).toMatch(/\.form-field-error\s*\{/);
    // #991b1b on white is 9.62:1 — well above AA.
    expect(css).toMatch(/\.form-field-error\s*\{[^}]*color:\s*#991b1b/);
  });

  test('defines .inspection-form-summary-link (clickable focus link)', () => {
    expect(css).toMatch(/\.inspection-form-summary-link\s*\{/);
    expect(css).toMatch(/\.inspection-form-summary-link:focus-visible\s*\{/);
  });
});
