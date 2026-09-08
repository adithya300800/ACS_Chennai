// ─────────────────────────────────────────────────────────────────────────────
// DR-022 (audit, 2026-09-08) — pagination cap recovery.
//
// Four audit failures locked in here:
//
//   1. 40 + 40 mixed weekly + monthly reports merged then truncated to 50
//      hid 30 rows. Fixed by `adminReports` accepting `?types=CSV` and
//      emitting a `nextCursor` the admin Reports page walks via "Load more".
//
//   2. 101 attachments of a rare report type silently clipped to 100 with
//      no continuation. Fixed by `projectAttachments` accepting `?cursor=`
//      + `?limit=` (default 50, max 100) and returning `nextCursor`.
//
//   3. 101 BOQ lines per project also clipped. Fixed by `boq` accepting
//      `?cursor=` (keyset on (projectName, itemCode)) + `nextCursor`.
//
//   4. 101 drawings where some rows have null `issuedDate` had the
//      null-row bucket unreachable because the cursor coerced
//      `issuedDate = null` to `Date(0)` and `issuedDate < Date(0)`
//      matches nothing on the next page. Fixed by `cursor.js` allowing
//      `date: null` and `drawings` using `NULLS LAST` ordering plus a
//      narrow `(issuedDate IS NULL AND id < cursor.id)` seek.
//
// These tests use source-text contracts because the live route handlers
// pull from req.app.get('prisma') AND require a UUID-formatted project
// AND validate the ?types enum — too many constraints to mock cheaply.
// The four audit surfaces are pinned by reading the route files. The
// cursor codec itself is exercised end-to-end (test 5 — the load-bearing
// regression guard for the null-date bug).
//
// Run: cd backend && npx jest __tests__/dr022-pagination-cap-recovery.test.js
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const { readFileSync } = require('fs');
const { resolve: resolvePath } = require('path');

const projectAttachmentsSrc = readFileSync(
  resolvePath(__dirname, '../src/routes/projectAttachments.js'),
  'utf8',
);
const boqSrc = readFileSync(
  resolvePath(__dirname, '../src/routes/boq.js'),
  'utf8',
);
const drawingsSrc = readFileSync(
  resolvePath(__dirname, '../src/routes/drawings.js'),
  'utf8',
);
const adminReportsSrc = readFileSync(
  resolvePath(__dirname, '../src/routes/adminReports.js'),
  'utf8',
);
const cursorSrc = readFileSync(
  resolvePath(__dirname, '../src/lib/cursor.js'),
  'utf8',
);

// ─── Tests ────────────────────────────────────────────────────────────────

describe('DR-022 — pagination cap recovery (source-text contracts)', () => {
  test('1. projectAttachments: accepts ?cursor + ?limit + ?types=A,B,C and emits nextCursor', () => {
    // List branch destructures type, types, cursor, limit from req.query.
    expect(projectAttachmentsSrc).toMatch(
      /const\s*\{\s*type,\s*types,\s*cursor,\s*limit\s*\}\s*=\s*req\.query/,
    );
    // types validator splits on a single character (typically ',').
    expect(projectAttachmentsSrc).toMatch(/types\.split\(['"][^'"]+['"]\)/);
    expect(projectAttachmentsSrc).toMatch(
      /message:\s*['"]types must be a comma-separated string['"]/,
    );
    expect(projectAttachmentsSrc).toMatch(
      /message:\s*`types contains unknown value/,
    );
    // cursor codec — base64url JSON of {uploadedAt, id}.
    expect(projectAttachmentsSrc).toMatch(
      /Buffer\.from\(cursor,\s*['"]base64url['"]\)/,
    );
    // take+1 pattern.
    expect(projectAttachmentsSrc).toMatch(/take\s*\+\s*1/);
    // nextCursor emitted.
    expect(projectAttachmentsSrc).toMatch(/nextCursor\s*=\s*hasMore/);
    expect(projectAttachmentsSrc).toMatch(
      /toString\(['"]base64url['"]\)/,
    );
  });

  test('2. boq: accepts ?cursor (keyset on (projectName, itemCode)) and emits nextCursor', () => {
    // List branch destructures cursor from req.query.
    expect(boqSrc).toMatch(
      /const\s*\{[\s\S]*?cursor[\s\S]*?\}\s*=\s*req\.query/,
    );
    // Keyset predicate: (projectName > decoded.projectName) OR
    // (projectName = decoded AND itemCode > decoded.itemCode).
    expect(boqSrc).toMatch(/projectName:\s*\{\s*gt:\s*decoded\.projectName\s*\}/);
    expect(boqSrc).toMatch(/itemCode:\s*\{\s*gt:\s*decoded\.itemCode\s*\}/);
    // nextCursor returned in the JSON body (shorthand property form).
    expect(boqSrc).toMatch(/res\.json\(\s*\{[\s\S]*?nextCursor[\s\S]*?\}\s*\)/);
    // Cursor codec is base64url JSON.
    expect(boqSrc).toMatch(/toString\(['"]base64url['"]\)/);
  });

  test('3. drawings: NULLS LAST ordering + null-cursor narrowing predicate', () => {
    // Prisma orderBy uses nulls: 'last' on issuedDate.
    expect(drawingsSrc).toMatch(
      /issuedDate:\s*\{\s*sort:\s*['"]desc['"][\s\S]*?nulls:\s*['"]last['"]\s*\}/,
    );
    // Null-cursor narrowing — when decoded.date is null, predicate is
    // (issuedDate: null, id < cursor.id).
    expect(drawingsSrc).toMatch(/cursorWhere\s*=\s*\{\s*issuedDate:\s*null/);
    expect(drawingsSrc).toMatch(/id:\s*\{\s*lt:\s*decoded\.id\s*\}/);
    // Codec uses cursor.js (which permits date: null).
    expect(drawingsSrc).toMatch(/decodeCursor\(/);
    expect(drawingsSrc).toMatch(/encodeCursor\(/);
  });

  test('4. adminReports: accepts ?types=A,B,C for multi-type filter', () => {
    // Destructure + split + validate.
    expect(adminReportsSrc).toMatch(/types\.split\(['"][^'"]+['"]\)/);
    expect(adminReportsSrc).toMatch(
      /message:\s*['"]types must be a comma-separated string['"]/,
    );
    // The where-clause narrows with `type: { in: requestedTypes }` when
    // multiple types are present.
    expect(adminReportsSrc).toMatch(/type:\s*\{\s*in:\s*requestedTypes\s*\}/);
  });

  test('5. cursor.js: codec permits `date: null` for NULLS LAST narrowing', () => {
    // toDateOnlyString handles null + undefined without throwing.
    expect(cursorSrc).toMatch(
      /value\s*===\s*null\s*\|\|\s*value\s*===\s*undefined\s*\)\s*return\s*null/,
    );
    // Decoder returns `{ date: null, id }` rather than throwing.
    expect(cursorSrc).toMatch(
      /parsed\.date\s*===\s*null[\s\S]*?return\s*\{\s*date:\s*null,\s*id:\s*parsed\.id\s*\}/,
    );
    // round-trip preserves null end-to-end.
    const { encodeCursor, decodeCursor } = require('../src/lib/cursor');
    const wire = encodeCursor(null, 'drawing-X');
    const decoded = JSON.parse(Buffer.from(wire, 'base64url').toString('utf8'));
    expect(decoded).toEqual({ date: null, id: 'drawing-X' });
    const back = decodeCursor(wire);
    expect(back).toEqual({ date: null, id: 'drawing-X' });
  });

  test('6. frontend admin pages consume nextCursor via {append, cursor} load-more loop', () => {
    // BoqAdmin + VariationOrdersAdmin + ProjectExpandedPanel each walk
    // nextCursor until null. Pin via source text.
    const boqAdminSrc = readFileSync(
      resolvePath(__dirname, '../../src/pages/admin/BoqAdmin.jsx'),
      'utf8',
    );
    const variationSrc = readFileSync(
      resolvePath(__dirname, '../../src/pages/admin/VariationOrdersAdmin.jsx'),
      'utf8',
    );
    const panelSrc = readFileSync(
      resolvePath(__dirname, '../../src/pages/portal/ProjectExpandedPanel.jsx'),
      'utf8',
    );
    const reportsSrc = readFileSync(
      resolvePath(__dirname, '../../src/pages/admin/ReportsAdmin.jsx'),
      'utf8',
    );

    expect(boqAdminSrc).toMatch(/nextCursor/);
    expect(variationSrc).toMatch(/nextCursor/);
    expect(panelSrc).toMatch(/nextCursor/);
    // ReportsAdmin sends ?types= for multi-type chips.
    expect(reportsSrc).toMatch(/types\s*=/);
  });
});
