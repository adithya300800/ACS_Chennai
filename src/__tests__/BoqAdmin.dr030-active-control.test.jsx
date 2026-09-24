// DR-030 (Fresh24 audit, 2026-09-24) — BOQ Active toggle was inert.
//
// Pre-fix, the BoqFormModal rendered an enabled "Active" checkbox that
// bound to local state via handleChange but handleSubmit's `trimmed`
// payload NEVER included `isActive` — and the backend PATCH allowlist
// (backend/src/routes/boq.js ALLOWED_UPDATE_FIELDS) explicitly excludes
// `isActive` with a comment: "soft-delete only via DELETE". So the
// admin could click the box, watch it visually flip, hit Save, and the
// change silently did nothing.
//
// Post-fix (Path A — the smallest fix that meets the acceptance
// criteria "either persists OR cannot be attempted with a misleading
// editable control"), the checkbox is rendered as a read-only display
// of the current activity status with an inline hint pointing at the
// row's Archive action. No backend change — the soft-delete contract is
// preserved.
//
// Mirrors Boq.frontend.test.jsx + BoqVariance.dr029-unit-grouping.test.jsx:
// source-text pins for the fix; the BoqFormModal is not mounted (see
// Boq.frontend.test.jsx header for the jsdom/lazy-router rationale).

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const adminPath = resolvePath(__dirname, '../pages/admin/BoqAdmin.jsx');
const apiPath = resolvePath(__dirname, '../lib/api.js');
const backendBoqPath = resolvePath(__dirname, '../../backend/src/routes/boq.js');
const adminSource = readFileSync(adminPath, 'utf8');
const apiSource = readFileSync(apiPath, 'utf8');
const backendSource = readFileSync(backendBoqPath, 'utf8');

describe('DR-030 — BOQ Active toggle is read-only, not a dangling editable', () => {
  describe('form control — Active checkbox is disabled + carries guidance', () => {
    test('the Active input element is rendered with disabled', () => {
      // The toggle must be uneditable. Without this, the admin sees a
      // click that "saves" but the backend silently discards.
      // Match the Active checkbox specifically, not any checkbox in
      // the file (the exec form has its own `accepted` checkbox).
      const activeCheckbox = adminSource.match(
        /<input\s+[^>]*name=["']isActive["'][^>]*\/>/,
      );
      expect(activeCheckbox).not.toBeNull();
      expect(activeCheckbox[0]).toMatch(/\bdisabled\b/);
    });

    test('the Active input element is rendered with readOnly', () => {
      // Belt-and-braces — disabled stops clicks; readOnly stops any
      // future keyboard/IME path that bypasses the click. Pin both.
      const activeCheckbox = adminSource.match(
        /<input\s+[^>]*name=["']isActive["'][^>]*\/>/,
      );
      expect(activeCheckbox).not.toBeNull();
      expect(activeCheckbox[0]).toMatch(/\breadOnly\b/);
    });

    test('the Active checkbox exposes a tooltip pointing to the Archive flow', () => {
      // The user needs to know WHERE to go to actually deactivate.
      // The title attribute carries the longer tooltip text for
      // hover/AT users.
      const activeCheckbox = adminSource.match(
        /<input\s+[^>]*name=["']isActive["'][^>]*\/>/,
      );
      expect(activeCheckbox).not.toBeNull();
      expect(activeCheckbox[0]).toMatch(/\btitle=/);
      expect(activeCheckbox[0]).toMatch(/[Aa]rchive/);
    });

    test('a visible small element below the checkbox points to the Archive action', () => {
      // Mirror of the tooltip for sighted users — the inline small
      // text reads "Use the row's Archive action to deactivate." so
      // the affordance reads as intentional rather than broken.
      // Match `<small .../>Read-only. ... Archive ...</small>` literally.
      expect(adminSource).toMatch(
        /<small[\s\S]{0,400}>[\s\S]*Read-only[\s\S]*[Aa]rchive[\s\S]*<\/small>/,
      );
    });
  });

  describe('handleSubmit — the trimmed payload does NOT carry isActive', () => {
    test('no isActive key in the trimmed object literal sent to onSave', () => {
      // Mirrors the source: the `trimmed` object that handleSubmit
      // constructs must remain free of `isActive`. If anyone re-adds
      // it as a regular field (not realising the backend ignores it),
      // this test fires — and they'll see the comment that points at
      // the soft-delete contract.
      const trimmedBlock = adminSource.match(
        /const trimmed = \{[\s\S]*?\};/,
      );
      expect(trimmedBlock).not.toBeNull();
      expect(trimmedBlock[0]).not.toMatch(/\bisActive\b/);
    });

    test('handleSubmit still calls onSave only after the trimmed-literal block', () => {
      // Regression guard: the trimmed-payload discipline is the
      // load-bearing piece of the fix. If it ever moves out of the
      // function, we want to know.
      const handleSubmit = adminSource.match(
        /const handleSubmit = async \(e\) => \{[\s\S]*?await onSave\(trimmed\);[\s\S]*?\};/,
      );
      expect(handleSubmit).not.toBeNull();
      expect(handleSubmit[0]).toMatch(/await onSave\(trimmed\)/);
    });
  });

  describe('backend — soft-delete contract preserved', () => {
    test('PATCH ALLOWED_UPDATE_FIELDS does NOT include isActive', () => {
      // The deliberate contract: PATCH edits shape, DELETE archives.
      // If someone "helpfully" adds isActive to the PATCH allowlist
      // without thinking it through, DR-030 re-opens — this pins the
      // current contract so the next agent sees the test fail.
      const allowBlock = backendSource.match(
        /const ALLOWED_UPDATE_FIELDS = \[[\s\S]*?\];/,
      );
      expect(allowBlock).not.toBeNull();
      expect(allowBlock[0]).not.toMatch(/\bisActive\b/);
    });

    test('the PATCH allowlist comment explicitly explains the soft-delete rule', () => {
      // The DR-030 fix relies on the existing backend comment that
      // says soft-delete is via DELETE only. Pin the comment so it
      // can't be silently dropped during a refactor — losing the
      // explanation would be how the same bug gets re-introduced.
      expect(backendSource).toMatch(/isActive[^\n]*\(soft-delete[\s\S]*?only\s+via\s+DELETE\)/i);
    });
  });

  describe('archive wiring — the actual deactivation path still exists', () => {
    test('api.js exposes softDeleteBoqItem that calls DELETE /boq/:id', () => {
      // DR-030 only disabled the form control; the underlying archive
      // mechanism must still be reachable. If anyone deletes the
      // api wrapper as "dead code" the admin loses the only way to
      // archive items.
      expect(apiSource).toMatch(
        /softDeleteBoqItem:\s*\([^)]*\)\s*=>\s*api\.delete\(`?\/boq\/\$\{[^}]+\}`?/,
      );
    });

    test('the page calls api.softDeleteBoqItem from its archive handler', () => {
      // The Archive button in the row actions menu must be wired to
      // the DELETE wrapper — that's the path we just told users to
      // use. If this drops, the form's new hint points users at a
      // broken feature.
      expect(adminSource).toMatch(/api\.softDeleteBoqItem\(/);
    });

    test('row actions wire an onClick to the archive confirmation', () => {
      // Belt-and-braces: confirm there's a row-level click handler
      // bound to setConfirmArchive / similar, so the "Archive
      // action" the hint references actually exists in the DOM tree.
      expect(adminSource).toMatch(/setConfirmArchive\s*\(/);
    });
  });
});
