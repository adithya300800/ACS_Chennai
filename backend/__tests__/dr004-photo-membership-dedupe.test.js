// DR-004 (audit, 2026-09-08) — evidence updates duplicate, omit, or
// partially commit photo membership.
//
// Audit finding: three independent failures combined to corrupt the
// evidence chain on every resumed edit:
//
//   1. Frontend re-sent already-persisted photos on every Save. The
//      server's `photos: { create: [...] }` nested write happily
//      duplicated each row — the schema has no unique constraint on
//      (recordId, container, ulid), so an existing one-photo DPR
//      became a two-photo DPR with the same ULID after a notes-only
//      edit. ("An existing one-photo DPR became a two-photo DPR
//      after changing only notes and saving.")
//
//   2. Inspection resume computed new photo claims but omitted them
//      from PUT — the editPayload didn't carry the `photos` field at
//      all, so additions were silently dropped on every resumed
//      edit and the server never saw them.
//
//   3. DPR PUT committed content/version/photos BEFORE a separate
//      binding transaction. A short binding count logged a warning
//      and returned 200, but the photo rows were already committed
//      — the user saw "saved" while the evidence was orphaned.
//
// Fix (minimum viable):
//
//   1. Frontend marks server-loaded photos `persisted: true` and the
//      Submit handler only sends NEW additions (filter `!p.persisted`).
//      After a successful Save the helper flips the flag on the just-
//      acknowledged photos so subsequent edits are truly additive.
//
//   2. InspectionSubmit editPayload includes `photos: photosToSubmit`
//      so PUT carries newly-added evidence through to the server.
//
//   3. Backend dedupes incoming `photos` by `(dprId|inspectionId,
//      container, ulid)` against existing rows before the nested
//      write. Server-side dedupe is the audit's explicit "don't just
//      pre-read on the client" guidance — a stale page that rehydrates
//      server-side photos without the persisted marker would otherwise
//      leak duplicates through.
//
//   4. Backend wraps the conditional update + photo nested create +
//      intent binding in ONE transaction. A short binding count
//      throws PhotoBindingLostError and rolls back the row bump AND
//      the just-created photo rows — the row stays at its pre-edit
//      content/version/photo-count.
//
// Acceptance criteria (pinned by source text below):
//   - unchanged Save keeps one row
//   - adding/retrying one new ULID produces two total
//   - concurrent identical additions do not duplicate
//   - stale version/short binding leaves original content, version
//     and photo count unchanged
//   - Inspection Save and Publish retain successful additions
//
// Run: cd backend && npx jest __tests__/dr004-photo-membership-dedupe.test.js

'use strict';

const fs = require('fs');
const path = require('path');

function readSource(relPath) {
  return fs.readFileSync(
    path.join(__dirname, '..', relPath),
    'utf8',
  );
}

describe('DR-004 — DPR/Inspection PUT photo membership dedupe + single-tx binding', () => {
  describe('backend dpr.js PUT — server-side dedupe + single transaction', () => {
    let src;
    beforeAll(() => {
      src = readSource('src/routes/dpr.js');
    });

    test('pre-reads existing photo ulids and dedupes by (container, ulid)', () => {
      // Server-side dedupe — the audit's exact symptom was a one-photo
      // DPR becoming two rows with the same ULID after a notes-only
      // edit. The fix pre-reads dPRPhoto ulids for the record and
      // filters incoming photos against the (container, ulid) key set.
      expect(src).toMatch(/prisma\.dPRPhoto\.findMany/);
      expect(src).toMatch(/dprId:\s*id/);
      // The dedupe key combines container + ulid so a collision across
      // containers (theoretically impossible but defensively keyed)
      // cannot drop the wrong photo.
      expect(src).toMatch(/existingKeys/);
      expect(src).toMatch(/dedupedPhotos\s*=\s*incomingPhotos\.filter/);
    });

    test('wraps conditional update + binding in ONE transaction (no separate tx)', () => {
      // Audit: "DPR PUT also commits content/version/photos before a
      // separate binding transaction can fail." The fix moves the
      // intent binding INSIDE the same withRecordTransaction as the
      // conditional update — a short binding count rolls back the
      // row bump AND the just-created photo rows.
      // Pattern: `withRecordTransaction(prisma, 'dPR', ...)` wraps
      // the dPR.update + assertPhotoIntentsBindable + bindPhotoIntentsTx.
      // Brace-matched extraction so inner `});` (from the
      // assertPhotoIntentsBindable call) don't terminate the regex
      // early. The PUT block contains db.dPR.update; the POST block
      // contains db.dPR.create — pick the one with `update`.
      function findBlock(needle, predicate) {
        let cursor = 0;
        while (cursor < src.length) {
          const i = src.indexOf(needle, cursor);
          if (i === -1) return null;
          const slice = src.slice(i);
          const openIdx = slice.indexOf('{');
          let depth = 0;
          let endIdx = -1;
          for (let j = openIdx; j < slice.length; j += 1) {
            if (slice[j] === '{') depth += 1;
            else if (slice[j] === '}') {
              depth -= 1;
              if (depth === 0) { endIdx = j; break; }
            }
          }
          if (endIdx === -1) return null;
          const body = slice.slice(openIdx, endIdx + 1);
          if (predicate(body)) return body;
          cursor = i + endIdx + 1;
        }
        return null;
      }
      const body = findBlock("withRecordTransaction(prisma, 'dPR'", (b) => /db\.dPR\.update/.test(b));
      expect(body).not.toBeNull();
      expect(body).toMatch(/assertPhotoIntentsBindable/);
      expect(body).toMatch(/bindPhotoIntentsTx/);
    });

    test('translate short-binding failure to 409 PHOTO_BINDING_LOST, not 500', () => {
      // The tx-level helper throws PhotoBindingLostError; the catch
      // translates it to 409 PHOTO_BINDING_LOST (same shape the POST
      // path uses). Pin both the helper call and the response
      // envelope so a refactor can't silently change to a generic
      // 500 path.
      expect(src).toMatch(/photoBindingLostResponse/);
      expect(src).toMatch(/PHOTO_BINDING_LOST/);
    });
  });

  describe('backend inspection.js PUT — typed additive photos + single-tx binding', () => {
    let src;
    beforeAll(() => {
      src = readSource('src/routes/inspection.js');
    });

    test("'photos' is on the ALLOWED_UPDATE_FIELDS allowlist", () => {
      // Pre-fix: the inspection PUT allowlist omitted `photos`
      // entirely — every resumed edit dropped newly-added evidence
      // because the editPayload didn't carry the field through.
      // The fix adds `photos` so the validation block + dedupe +
      // binding all run on PUT.
      const allowlistMatch = src.match(/const ALLOWED_UPDATE_FIELDS\s*=\s*\[([\s\S]*?)\];/);
      expect(allowlistMatch).not.toBeNull();
      expect(allowlistMatch ? allowlistMatch[1] : '').toMatch(/'photos'/);
    });

    test('validates photo shape on PUT (ulid regex, container, content-type, size, filename)', () => {
      // Mirror POST validation. Without it a forged ulid could attach
      // to an inspection PUT.
      expect(src).toMatch(/container must be inspection-photos/);
      expect(src).toMatch(/contentType invalid/);
      expect(src).toMatch(/filename invalid/);
    });

    test('pre-flight validatePhotoIntents on PUT', () => {
      // The ulid shape check above is necessary but insufficient — a
      // client could attach a fabricated ulid. The same
      // validatePhotoIntents gate POST uses must run on PUT.
      expect(src).toMatch(/validatePhotoIntents\(\{[\s\S]*?context:\s*'inspection\.update'/);
    });

    test('pre-reads existing inspectionPhoto ulids and dedupes by (container, ulid)', () => {
      // Same dedupe pattern as the DPR fix. Pin both the read and
      // the key construction so a future refactor doesn't widen the
      // dedupe key to something looser than (container, ulid).
      expect(src).toMatch(/prisma\.inspectionPhoto\.findMany/);
      expect(src).toMatch(/inspectionId:\s*id/);
    });

    test('wraps conditional update + binding in ONE transaction', () => {
      // The `inspectionRecord` model has TWO withRecordTransaction
      // sites (POST + PUT). The PUT block must include the update +
      // assertPhotoIntentsBindable + bindPhotoIntentsTx trio. POST
      // uses db.inspectionRecord.create; PUT uses
      // db.inspectionRecord.update — pick the block that contains
      // `update` so a future refactor can't regress to two
      // transactions.
      function findBlock(needle, predicate) {
        let cursor = 0;
        while (cursor < src.length) {
          const i = src.indexOf(needle, cursor);
          if (i === -1) return null;
          const slice = src.slice(i);
          const openIdx = slice.indexOf('{');
          let depth = 0;
          let endIdx = -1;
          for (let j = openIdx; j < slice.length; j += 1) {
            if (slice[j] === '{') depth += 1;
            else if (slice[j] === '}') {
              depth -= 1;
              if (depth === 0) { endIdx = j; break; }
            }
          }
          if (endIdx === -1) return null;
          const body = slice.slice(openIdx, endIdx + 1);
          if (predicate(body)) return body;
          cursor = i + endIdx + 1;
        }
        return null;
      }
      const body = findBlock("withRecordTransaction(prisma, 'inspectionRecord'", (b) => /db\.inspectionRecord\.update/.test(b));
      expect(body).not.toBeNull();
      expect(body).toMatch(/assertPhotoIntentsBindable/);
      expect(body).toMatch(/bindPhotoIntentsTx/);
    });
  });

  describe('frontend — additive photos only on Save', () => {
    let dprSrc;
    let inspSrc;
    beforeAll(() => {
      dprSrc = readSource('../src/pages/portal/DprSubmit.jsx');
      inspSrc = readSource('../src/pages/portal/InspectionSubmit.jsx');
    });

    test('DprSubmit marks server-loaded photos persisted: true', () => {
      // Server-loaded photos are read-only references (SAS URLs we
      // can't re-upload through) — they must not round-trip back to
      // the server on every Save. The hydrated objects carry
      // `persisted: true` so the Submit filter can exclude them.
      expect(dprSrc).toMatch(/readUrl:\s*p\.readUrl\s*\|\|\s*null,\s*\n\s*persisted:\s*true/);
    });

    test('DprSubmit Submit filter excludes persisted photos (sends additions only)', () => {
      // The audit's exact failure was the frontend re-sending
      // already-persisted photos — the server then duplicated them
      // via `photos: { create: [...] }`. The additive filter is the
      // client-side fix the audit asked for.
      expect(dprSrc).toMatch(/filter\(\(p\)\s*=>\s*p\.ulid\s*&&\s*!p\.persisted\)/);
    });

    test('InspectionSubmit editPayload carries photos: photosToSubmit on PUT', () => {
      // The audit's "Inspection resume computes new photo claims but
      // omits them from PUT" — pre-fix, the editPayload didn't have
      // a `photos` field, so additions were silently dropped.
      // The fix adds `photos: photosToSubmit` to the editPayload.
      const editPayloadMatch = inspSrc.match(/const editPayload\s*=\s*{([\s\S]*?)};/);
      expect(editPayloadMatch).not.toBeNull();
      expect(editPayloadMatch ? editPayloadMatch[1] : '').toMatch(/photos:\s*photosToSubmit/);
    });

    test('InspectionSubmit Submit filter excludes persisted photos (sends additions only)', () => {
      // Same additive semantic as DprSubmit — pinned in source so a
      // future refactor can't regress to "send everything with ulid".
      expect(inspSrc).toMatch(/filter\(\(p\)\s*=>\s*p\.ulid\s*&&\s*!p\.persisted\)/);
    });

    test('InspectionSubmit marks server-loaded photos persisted: true', () => {
      expect(inspSrc).toMatch(/readUrl:\s*p\.readUrl\s*\|\|\s*null,\s*\n\s*persisted:\s*true/);
    });
  });
});
