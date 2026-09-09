// SOL DR-021 regression coverage. The audit caught that:
//
//   1. A new rejection notification used a numeric streamed ID
//      (`id: Date.now()` from emitNotification) and the client
//      `PUT /:notifId/read` came back 404 because the actual
//      persisted row's id is a UUID.
//   2. Full reload supplied its UUID and read 200.
//   3. The bell's stream/list dedupe broke because the SSE-emitted
//      numeric id never matched the persisted UUID returned by /list —
//      so a stream push followed by /list showed duplicates.
//   4. Other target types (inspection / leave / training) lack
//      equivalent transport / navigation — the bell's `notif.dprId`
//      branch was the only handler.
//   5. Inspection notifications did not carry `inspectionId` so the
//      bell had no way to navigate to the detail page even if it
//      wanted to.
//
// Source pinning (NOT a fresh integration test — these tests assert
// the source text the live backend relies on):
//
//   - The schema migration file (forwards-only, additive nullable
//     `inspection_id` column) is present.
//   - `inspection.js` writes `inspectionId` on the per-record
//     notification row created inside the transition tx.
//   - `dpr.js` `emitNotification` no longer fabricates an `id` via
//     `Date.now()` — it carries the persisted notification's real
//     UUID.
//   - `dpr.js` `notifications/list` SELECT includes
//     `inspectionId` / `leaveRequestId` / `trainingEnrollmentId`
//     so the bell can route every typed target.
//   - `NotificationBell.jsx` click handler routes inspection /
//     training / leave notifications to the correct destinations.

process.env.NODE_ENV = 'test';

const fs = require('fs');
const path = require('path');

describe('SOL DR-021 — notification identity, targets and commit outcomes', () => {
  const repoRoot = path.resolve(__dirname, '..');
  const inspectionRoute = fs.readFileSync(
    path.join(repoRoot, 'src/routes/inspection.js'),
    'utf8',
  );
  const dprRoute = fs.readFileSync(
    path.join(repoRoot, 'src/routes/dpr.js'),
    'utf8',
  );
  const schema = fs.readFileSync(
    path.join(repoRoot, 'prisma/schema.prisma'),
    'utf8',
  );
  const migration = fs.readFileSync(
    path.join(repoRoot, 'prisma/migrations/20260910200000_dr021_notification_inspection_target/migration.sql'),
    'utf8',
  );
  const bellSrc = fs.readFileSync(
    path.join(repoRoot, '../src/components/NotificationBell.jsx'),
    'utf8',
  );

  test('schema carries the additive nullable inspectionId on Notification', () => {
    // The schema adds `inspectionId` as a nullable column with its
    // own index. We pin the field name + map + index — those three
    // are the minimum contract.
    expect(schema).toMatch(/model Notification\b[\s\S]*inspectionId\s+String\?\s+@map\("inspection_id"\)/);
    expect(schema).toMatch(/@@index\(\[inspectionId\]\)/);
  });

  test('migration is additive (forward-only) and creates the index', () => {
    expect(migration).toMatch(/ALTER TABLE "notification"\s+ADD COLUMN "inspection_id" TEXT/);
    expect(migration).toMatch(/CREATE INDEX "notification_inspection_id_idx"/);
    // Guardrail: no destructive operation on existing columns.
    expect(migration).not.toMatch(/DROP COLUMN/);
    expect(migration).not.toMatch(/DELETE FROM/);
  });

  test('inspection.js writes inspectionId on the per-record notification row', () => {
    // The transition tx persists a notification row with inspectionId
    // bound to the inspection id so the bell can route to the detail
    // page. We pin the field name + the exact `id` reference the
    // transition argument exposes — pin the field name only, not the
    // surrounding whitespace, so a future cosmetic refactor doesn't
    // break the contract.
    expect(inspectionRoute).toMatch(/inspectionId:\s*id/);
    // And the persisted row is captured (selected fields, not just
    // create-void) so the SSE wire shape carries the real UUID.
    expect(inspectionRoute).toMatch(/const notification = await tx\.notification\.create\(\{[\s\S]*?inspectionId: id,[\s\S]*?select:\s*\{[\s\S]*?id: true/);
  });

  test('inspection.js helper returns { record, transitioned, notification }', () => {
    // The smallest complete fix requires the transition helper to
    // expose its commit outcome so the route can return the record
    // AND the SSE emit / fan-out can use the persisted UUID. We pin
    // the shape with explicit destructuring on the call site.
    expect(inspectionRoute).toMatch(/result\.record/);
    expect(inspectionRoute).toMatch(/result\.transitioned/);
    expect(inspectionRoute).toMatch(/result\.notification/);
  });

  test('dpr.js /:id/reject emits the persisted notification UUID, not Date.now()', () => {
    // The numeric-id bug surfaced on the reject route in the audit
    // (a fresh rejection notification arrived with id=Date.now()).
    // We pin the absence of `Date.now()` in the emitNotification
    // call AND the presence of the persisted row's id as the SSE
    // payload id. The bulk-review route shares the same fix.
    //
    // Use a greedy capture from the route signature through to the
    // next `router.` mount, otherwise the non-greedy `\}\);\s*\n`
    // matches the inner `const prisma = getPrisma(req); })` and
    // never reaches the emitNotification call.
    const rejectBlock = dprRoute.match(/router\.post\('\/:id\/reject'[\s\S]*?(?=router\.post\()/);
    expect(rejectBlock).not.toBeNull();
    expect(rejectBlock[0]).not.toMatch(/id:\s*Date\.now\(\)/);
    expect(rejectBlock[0]).toMatch(/id:\s*_notification\.id/);
  });

  test('dpr.js /:id/approve and /:id/review emit the persisted notification UUID', () => {
    // Same fix applies to approve + review (single endpoints). Pin
    // the wire-shape id field for both.
    const approveBlock = dprRoute.match(/router\.post\('\/:id\/approve'[\s\S]*?(?=router\.post\()/);
    const reviewBlock = dprRoute.match(/router\.post\('\/:id\/review'[\s\S]*?(?=router\.post\()/);
    expect(approveBlock).not.toBeNull();
    expect(reviewBlock).not.toBeNull();
    expect(approveBlock[0]).not.toMatch(/id:\s*Date\.now\(\)/);
    expect(reviewBlock[0]).not.toMatch(/id:\s*Date\.now\(\)/);
    expect(approveBlock[0]).toMatch(/id:\s*updated\.notification\.id/);
    expect(reviewBlock[0]).toMatch(/id:\s*updated\.notification\.id/);
  });

  test('dpr.js notifications/list selects every typed target id', () => {
    // The list endpoint must return inspectionId / leaveRequestId /
    // trainingEnrollmentId alongside dprId so the bell can route
    // every typed notification. Pin each field name in the select
    // clause.
    const listBlock = dprRoute.match(/router\.get\('\/notifications\/list'[\s\S]*?(?=router\.put\()/);
    expect(listBlock).not.toBeNull();
    expect(listBlock[0]).toMatch(/inspectionId:\s*true/);
    expect(listBlock[0]).toMatch(/leaveRequestId:\s*true/);
    expect(listBlock[0]).toMatch(/trainingEnrollmentId:\s*true/);
    expect(listBlock[0]).toMatch(/dprId:\s*true/);
  });

  test('NotificationBell routes inspection / training / leave notifications', () => {
    // The bell click handler must check every typed target id and
    // navigate to its authorized detail surface. Pin the route
    // shapes against the existing portal route table at App.jsx.
    expect(bellSrc).toMatch(/if \(notif\.dprId\)/);
    expect(bellSrc).toMatch(/else if \(notif\.inspectionId\)/);
    expect(bellSrc).toMatch(/\/portal\/inspection\/\$\{notif\.inspectionId\}/);
    expect(bellSrc).toMatch(/else if \(notif\.trainingEnrollmentId\)/);
    expect(bellSrc).toMatch(/\/portal\/training\/\$\{notif\.trainingEnrollmentId\}/);
    expect(bellSrc).toMatch(/else if \(notif\.leaveRequestId\)/);
    expect(bellSrc).toMatch(/\/portal\/leave/);
  });
});