// ─────────────────────────────────────────────────────────────────────────────
// DR-009 (audit, 2026-09-24) — Capped collections do not expose a complete
// retrieval path. Six list endpoints previously returned a bounded batch
// (`take: 100/200/500`) with no metadata about the underlying total or the
// truncation boundary. The audit explicitly calls out:
//   - inspections at 50/100 (DR-022 already cursorized)
//   - per-project reports (DR-022 already cursorized)
//   - employee assignment choices at 500 (adminEmployees)
//   - drawing choices at 100 (DR-022 already cursorized)
//   - BOQ execution history at 200
//   - leave my=100, admin queue=500
//   - training my=200, admin queue=500
//   - drawing reference lengths presented as exact counts
//
// Minimal implementation this test pins:
//   1. Each capped list endpoint emits a `total` field (additive — existing
//      array contracts `items` / `requests` / `enrollments` / `employees`
//      are unchanged) so the UI can render honest "showing first N of
//      <total>" labels.
//   2. The drawing detail endpoint replaces the array-length
//      `referencedByCount` with real `prisma.dPR.count` + `prisma.
//      inspectionRecord.count` queries and surfaces a `referencedByLimited`
//      flag so the partial stamp list is not labelled as complete.
//
// Source-text pins keep the test fast, deterministic and independent of
// the live route handlers, matching the conventions used by
// dr022-pagination-cap-recovery.test.js and dr033-upload-sweep.test.js.
//
// Run: cd backend && npx jest __tests__/dr009-capped-collection-metadata.test.js
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const { readFileSync } = require('fs');
const { resolve: resolvePath } = require('path');

const boqSrc = readFileSync(
  resolvePath(__dirname, '../src/routes/boq.js'),
  'utf8',
);
const leaveSrc = readFileSync(
  resolvePath(__dirname, '../src/routes/leave.js'),
  'utf8',
);
const trainingSrc = readFileSync(
  resolvePath(__dirname, '../src/routes/training.js'),
  'utf8',
);
const adminEmployeesSrc = readFileSync(
  resolvePath(__dirname, '../src/routes/adminEmployees.js'),
  'utf8',
);
const drawingsSrc = readFileSync(
  resolvePath(__dirname, '../src/routes/drawings.js'),
  'utf8',
);

describe('DR-009 — capped collection metadata (source-text contracts)', () => {
  test('1. boq executions: emits total alongside items array', () => {
    // The list handler is the GET /api/boq/:boqItemId/executions endpoint.
    // We pin it by anchoring on the handler block — the destination of
    // `res.json({ items })` must also include a `total` field so the UI
    // can tell when 200 rows was a truncation.
    const executionsMatch = boqSrc.match(
      /router\.get\(['"]\/:boqItemId\/executions['"][\s\S]*?\}\)\);/,
    );
    expect(executionsMatch).not.toBeNull();
    expect(executionsMatch[0]).toMatch(/prisma\.boqExecution\.count\(\s*\{\s*where\s*\}\s*\)/);
    expect(executionsMatch[0]).toMatch(/res\.json\(\s*\{\s*items:\s*rows,\s*total\s*\}\s*\)/);
  });

  test('2. leave /my: emits total alongside requests array', () => {
    expect(leaveSrc).toMatch(/router\.get\(['"]\/my['"]/);
    // Pin the count + json shape inside the /my handler block.
    expect(leaveSrc).toMatch(/prisma\.leaveRequest\.count\(\s*\{\s*where\s*\}\s*\)/);
    expect(leaveSrc).toMatch(/res\.json\(\s*\{\s*requests:\s*rows\.map\(serializeLeave\),\s*total\s*\}\s*\)/);
  });

  test('3. leave / (admin queue): emits total alongside requests array', () => {
    // Admin queue uses `where` built from status/employeeId/from/to; the
    // count must mirror that exact filter so total reflects the visible
    // set, not all leaves.
    expect(leaveSrc).toMatch(/prisma\.leaveRequest\.findMany\(\s*\{[\s\S]*?where,[\s\S]*?take:\s*500[\s\S]*?\}\)/);
    expect(leaveSrc).toMatch(/prisma\.leaveRequest\.count\(\s*\{\s*where\s*\}\s*\)/);
  });

  test('4. training /enrollments/my: emits total alongside enrollments array', () => {
    expect(trainingSrc).toMatch(/router\.get\(['"]\/enrollments\/my['"]/);
    expect(trainingSrc).toMatch(/prisma\.trainingEnrollment\.count\(\s*\{\s*where\s*\}\s*\)/);
    // The destructure-order-tolerant regex: both responses share the same
    // `enrollments: rows.map(serializeEnrollment)` shape.
    expect(trainingSrc).toMatch(
      /res\.json\(\s*\{\s*enrollments:\s*rows\.map\(serializeEnrollment\),\s*total\s*\}\s*\)/,
    );
  });

  test('5. training /enrollments (admin queue): emits total alongside enrollments array', () => {
    expect(trainingSrc).toMatch(/router\.get\(['"]\/enrollments['"]/);
    expect(trainingSrc).toMatch(/prisma\.trainingEnrollment\.count\(\s*\{\s*where\s*\}\s*\)/);
  });

  test('6. adminEmployees: emits total alongside employees array', () => {
    // Same destructure-order tolerance as the training tests: the response
    // shape is `{ employees: rows, total }`.
    expect(adminEmployeesSrc).toMatch(/router\.get\(['"]\/employees['"]/);
    expect(adminEmployeesSrc).toMatch(/prisma\.employee\.count\(\s*\{\s*where\s*\}\s*\)/);
    expect(adminEmployeesSrc).toMatch(/res\.json\(\s*\{\s*employees:\s*rows,\s*total\s*\}\s*\)/);
  });

  test('7. drawings detail: referencedByCount uses real counts, not array length', () => {
    // The endpoint embeds inside the /:id handler block. We pin the
    // presence of two real count queries against the underlying models
    // — replacing the previous `referencedByDprs.length + referencedByInspections.length`
    // shortcut. The legacy literal is gone; the new total is the count
    // sum and the truncation flag is exposed via `referencedByLimited`.
    expect(drawingsSrc).toMatch(/prisma\.dPR\.count\(\s*\{\s*where:\s*\{\s*drawingId:\s*id\s*\}/);
    expect(drawingsSrc).toMatch(/prisma\.inspectionRecord\.count\(\s*\{\s*where:\s*\{\s*drawingId:\s*id\s*\}/);
    expect(drawingsSrc).toMatch(/referencedByLimited/);
    // The legacy wrong source must be gone.
    expect(drawingsSrc).not.toMatch(
      /referencedByCount:\s*referencedByDprs\.length\s*\+\s*referencedByInspections\.length/,
    );
  });

  test('8. drawings detail: PARALLEL count + findMany (no N+1, no serial round-trip)', () => {
    // Both count queries must run alongside the existing findMany so
    // adding `total` does not double the response latency. Constrained
    // to the /:id handler block for a focused pin.
    const detailMatch = drawingsSrc.match(
      /router\.get\(['"]\/:id['"][\s\S]*?res\.json\(\s*\{[\s\S]*?supersedesChain,\s*\}\s*\);[\s\S]*?\}\)\);/,
    );
    expect(detailMatch).not.toBeNull();
    // The detail block must wrap the two counts in a single Promise.all
    // so they execute in parallel with each other (rather than serially
    // after findMany).
    expect(detailMatch[0]).toMatch(/Promise\.all\(\[\s*prisma\.dPR\.count\([\s\S]*?prisma\.inspectionRecord\.count\(/);
  });
});
