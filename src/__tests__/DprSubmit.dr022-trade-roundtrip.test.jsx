// DR-022 (Fresh-24 audit 2026-09-24): the prior manpower serialization
// in DprSubmit.jsx used em-dash (—) and pipe (|) as both field/row
// separators AND as legitimate characters users might type in a trade
// name. A trade like "Senior — Lead" serialized to
//   "Senior — Lead — 6 — 8"
// and parsed back as {trade:"Senior", count:"Lead", hours:"6"} — the
// trailing "8" was silently dropped and the count field was poisoned.
// A trade like "Pipe | Fitter" split into two rows on read.
//
// Acceptance criteria:
//   1. Trade, count, and hours round-trip for any punctuation users can
//      type, including literal em-dash and pipe inside the trade field.
//   3. Decimal hours round-trip.
//   3. Legacy ambiguous records remain unchanged on read until the
//      engineer explicitly reconciles them by editing the row builder.
//
// This file covers (1)–(3) by importing the v2 helpers and exercising
// the round-trip directly. The source-text pins at the bottom assert
// that DprSubmit.jsx actually consumes the helpers (no inline copies).

import {
  parseManpowerSummary,
  serializeManpowerRows,
} from '../lib/manpowerSerialization.js';

describe('DR-022 — manpower serialization round-trips trade text with reserved characters', () => {
  test('1. normal row round-trips unchanged', () => {
    const rows = [{ trade: 'Mason', count: '6', hours: '8' }];
    const ser = serializeManpowerRows(rows);
    expect(ser).toBe('Mason — 6 — 8');
    expect(parseManpowerSummary(ser)).toEqual(rows);
  });

  test('2. trade containing an em-dash (U+2014) round-trips intact', () => {
    // Pre-fix bug: "Senior — Lead — 6 — 8" parsed as
    // {trade:"Senior", count:"Lead", hours:"6"} — the "8" was dropped.
    const rows = [{ trade: 'Senior — Lead', count: '6', hours: '8' }];
    const ser = serializeManpowerRows(rows);
    expect(ser).toBe('Senior \\— Lead — 6 — 8');
    expect(parseManpowerSummary(ser)).toEqual(rows);
  });

  test('3. trade containing a pipe (|) round-trips intact', () => {
    // Pre-fix bug: "Pipe Crew | Fitter — 4 — 7.5" split into TWO rows
    // on read, both corrupted.
    const rows = [{ trade: 'Pipe Crew | Fitter', count: '4', hours: '7.5' }];
    const ser = serializeManpowerRows(rows);
    expect(ser).toBe('Pipe Crew \\| Fitter — 4 — 7.5');
    expect(parseManpowerSummary(ser)).toEqual(rows);
  });

  test('4. trade containing BOTH em-dash and pipe round-trips intact', () => {
    const rows = [{ trade: 'Pipe|Crew — Senior', count: '5', hours: '8.5' }];
    const ser = serializeManpowerRows(rows);
    expect(ser).toBe('Pipe\\|Crew \\— Senior — 5 — 8.5');
    expect(parseManpowerSummary(ser)).toEqual(rows);
  });

  test('5. multi-row payload with reserved chars in only one trade round-trips intact', () => {
    const rows = [
      { trade: 'Mason', count: '6', hours: '8' },
      { trade: 'Senior — Lead', count: '4', hours: '7' },
    ];
    const ser = serializeManpowerRows(rows);
    expect(ser).toBe('Mason — 6 — 8 | Senior \\— Lead — 4 — 7');
    expect(parseManpowerSummary(ser)).toEqual(rows);
  });

  test('6. decimal hours round-trip exactly', () => {
    // Pre-fix already worked for 8.5 (no separator chars in input), but
    // we still assert so a future refactor doesn't accidentally narrow
    // the parse to integer-only hours.
    const rows = [
      { trade: 'Helper', count: '3', hours: '8.5' },
      { trade: 'Welder', count: '2', hours: '10.25' },
    ];
    const ser = serializeManpowerRows(rows);
    expect(parseManpowerSummary(ser)).toEqual(rows);
  });

  test('7. backslash in trade round-trips (escape-of-escape is well-formed)', () => {
    // A user-typed "\" becomes "\\" on the wire and unescapes back to a
    // single "\" on read. Round-trip is symmetric.
    const rows = [{ trade: 'A\\B Crew', count: '1', hours: '2' }];
    const ser = serializeManpowerRows(rows);
    expect(parseManpowerSummary(ser)).toEqual(rows);
  });

  test('8. all three reserved characters in trade round-trip', () => {
    const rows = [{ trade: '\\|—', count: '1', hours: '2' }];
    expect(parseManpowerSummary(serializeManpowerRows(rows))).toEqual(rows);
  });

  test('9. legacy ambiguous record is read with the original buggy parse (unchanged until reconciled)', () => {
    // Acceptance criterion: existing ambiguous records remain unchanged.
    // A legacy string "Senior — Lead — 6 — 8" contains no backslash,
    // so isV2Format() returns false and the original naive split runs.
    // The buggy 3-part outcome is preserved exactly as before:
    // {trade:"Senior", count:"Lead", hours:"6"} — the engineer sees
    // the data as it always was and can reconcile by re-saving.
    const legacy = 'Senior — Lead — 6 — 8';
    expect(parseManpowerSummary(legacy)).toEqual([
      { trade: 'Senior', count: 'Lead', hours: '6' },
    ]);
  });

  test('10. legacy multi-row record (no backslash) parses exactly as before', () => {
    // Two well-formed legacy rows separated by " | ". No escape chars
    // anywhere → v2 path is not triggered → original split runs.
    const legacy = 'Mason — 6 — 8 | Helper — 4 — 8';
    expect(parseManpowerSummary(legacy)).toEqual([
      { trade: 'Mason', count: '6', hours: '8' },
      { trade: 'Helper', count: '4', hours: '8' },
    ]);
  });

  test('11. empty / nullish input returns the empty-row sentinel', () => {
    expect(parseManpowerSummary('')).toEqual([{ trade: '', count: '', hours: '' }]);
    expect(parseManpowerSummary(null)).toEqual([{ trade: '', count: '', hours: '' }]);
    expect(parseManpowerSummary(undefined)).toEqual([{ trade: '', count: '', hours: '' }]);
  });

  test('12. serialize drops rows with empty trade (UI hides them; no separator noise)', () => {
    const rows = [
      { trade: '', count: '6', hours: '8' },
      { trade: 'Mason', count: '4', hours: '7' },
    ];
    const ser = serializeManpowerRows(rows);
    expect(ser).toBe('Mason — 4 — 7');
    expect(parseManpowerSummary(ser)).toEqual([
      { trade: 'Mason', count: '4', hours: '7' },
    ]);
  });
});

// Source-text pins: DprSubmit.jsx must consume the helpers from the
// shared module — no inline copies of the v1 (corrupting) logic.
import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const dprSubmitSrc = readFileSync(
  resolvePath(__dirname, '../pages/portal/DprSubmit.jsx'),
  'utf8',
);

describe('DR-022 — DprSubmit.jsx consumes the shared helpers', () => {
  test('13. DprSubmit imports parseManpowerSummary + serializeManpowerRows from the shared module', () => {
    expect(dprSubmitSrc).toMatch(
      /import\s*\{[^}]*parseManpowerSummary[^}]*\}\s*from\s*['"]\.\.\/\.\.\/lib\/manpowerSerialization\.js['"]/,
    );
    expect(dprSubmitSrc).toMatch(
      /import\s*\{[^}]*serializeManpowerRows[^}]*\}\s*from\s*['"]\.\.\/\.\.\/lib\/manpowerSerialization\.js['"]/,
    );
  });

  test('14. DprSubmit has no inline definition of parseManpowerSummary', () => {
    // The inline `const parseManpowerSummary = (str) => { ... }` block
    // (pre-fix at lines 32-47) is gone — DR-022 moved it to the shared
    // module so the escape logic is in one place and unit-testable.
    expect(dprSubmitSrc).not.toMatch(/^const\s+parseManpowerSummary\s*=\s*\(/m);
  });

  test('15. DprSubmit has no inline definition of serializeManpowerRows', () => {
    expect(dprSubmitSrc).not.toMatch(/^const\s+serializeManpowerRows\s*=\s*\(/m);
  });

  test('16. the DR-022 audit rationale is annotated at the import site', () => {
    // Future refactors that move/rename the helpers should keep the
    // DR-022 marker so the corruption history is traceable.
    expect(dprSubmitSrc).toMatch(/DR-022[^\n]*audit|DR-022[^\n]*Fresh-24/);
  });
});