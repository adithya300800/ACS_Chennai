// DR-010 — Qualified presence remark.
//
// The audit's original "Open session" copy on the timesheet Remarks
// column implied an employee forgot to check out. The attendance
// model is now presence-only (DR-024): a null checkOut is the
// expected end-of-day state, NOT a forgotten check-out. The remark
// now reads "Present since HH:MM" so admins can verify the employee
// is on-site without implying they missed a check-out action.
//
// Coverage:
//   1. Single session, no checkOut → remarks matches /^Present since \d{2}:\d{2}$/
//   2. Last session HAS checkOut → remarks === ''
//   3. All sessions checked-out → remarks === '' (regression guard)
//   4. Source-text pin: timesheet.js no longer contains the literal
//      'Open session' so a future revert is caught at CI time.

const { readFileSync } = require('fs');
const { resolve: resolvePath } = require('path');
const { buildTimesheetRows } = require('../src/lib/timesheet.js');

const timesheetPath = resolvePath(__dirname, '../src/lib/timesheet.js');
const timesheetSrc = readFileSync(timesheetPath, 'utf8');

// Frozen "today" so the test stays deterministic regardless of when
// it runs. The presence-only model only writes a remark when the
// LAST session of the day has no checkOut, so we only need a single
// session-bearing attendance row that sits in the current month.
const TODAY = new Date();
const MONTH = `${TODAY.getFullYear()}-${String(TODAY.getMonth() + 1).padStart(2, '0')}`;
const TODAY_KEY = new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate()).getTime();
const TODAY_ISO_DATE = `${TODAY.getFullYear()}-${String(TODAY.getMonth() + 1).padStart(2, '0')}-${String(TODAY.getDate()).padStart(2, '0')}`;

const baseEmployees = [
  { id: 'emp-1', name: 'Test Employee', department: 'Engineering' },
];

function buildRows(attendanceRows) {
  return buildTimesheetRows({
    employees: baseEmployees,
    attendanceRows,
    leaveRequests: [],
    month: MONTH,
    today: TODAY,
  });
}

// Pull the row matching "today" out of the month-long rowset.
// buildTimesheetRows emits one row per employee-day for the whole
// month, so the day-keyed assertion is more focused than asserting
// on a positional index.
function rowForToday(rows) {
  const today = rows.find((r) => r.date === TODAY_ISO_DATE);
  if (!today) {
    throw new Error(`No row found for today (${TODAY_ISO_DATE})`);
  }
  return today;
}

describe('DR-010 — Qualified presence remark', () => {
  test('1. single session with no checkOut → remarks matches /^Present since HH:MM$/', () => {
    // Single session that never closed — the presence-only model
    // expects this state. The remark should surface the check-in
    // time (09:30 local) so an admin can verify the employee is
    // on-site without reading it as "forgot to check out".
    const checkIn = new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate(), 9, 30, 0);
    const result = buildRows([
      {
        employeeId: 'emp-1',
        date: TODAY_KEY,
        status: 'Present',
        sessions: [{ checkIn: checkIn.toISOString() }],
      },
    ]);
    const today = rowForToday(result.rows);
    expect(today.remarks).toMatch(/^Present since \d{2}:\d{2}$/);
    // The surfaced time should be 09:30 — matches the check-in.
    expect(today.remarks).toBe('Present since 09:30');
    // Status remains Present — the remark change is content-only.
    expect(today.status).toBe('Present');
  });

  test('2. last session HAS checkOut → remarks === "" (regression guard)', () => {
    // A full session (checked in AND checked out) should not produce
    // a "Present since" remark — the employee has already left, so
    // the Remarks column stays empty (mirrors the pre-fix behaviour
    // for closed sessions).
    const checkIn = new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate(), 9, 0, 0);
    const checkOut = new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate(), 17, 30, 0);
    const result = buildRows([
      {
        employeeId: 'emp-1',
        date: TODAY_KEY,
        status: 'Present',
        sessions: [{ checkIn: checkIn.toISOString(), checkOut: checkOut.toISOString() }],
      },
    ]);
    const today = rowForToday(result.rows);
    expect(today.remarks).toBe('');
    expect(today.firstCheckIn).toBe('09:00');
  });

  test('3. all sessions checked-out → remarks === "" (regression guard)', () => {
    // Legacy multi-session day where every session has a checkOut.
    // No open session → no "Present since" remark.
    const result = buildRows([
      {
        employeeId: 'emp-1',
        date: TODAY_KEY,
        status: 'Present',
        sessions: [
          { checkIn: new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate(), 9, 0, 0).toISOString(),
            checkOut: new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate(), 12, 0, 0).toISOString() },
          { checkIn: new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate(), 13, 0, 0).toISOString(),
            checkOut: new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate(), 17, 0, 0).toISOString() },
        ],
      },
    ]);
    const today = rowForToday(result.rows);
    expect(today.remarks).toBe('');
    // Sanity: firstCheckIn should still be set (the export contract
    // is unchanged — only the remarks copy was retuned).
    expect(today.firstCheckIn).toBe('09:00');
  });

  test('4. source-text pin: timesheet.js no longer contains the literal "Open session"', () => {
    // Guard against a revert that re-introduces the misleading copy.
    // The literal 'Open session' is what the audit flagged; any
    // re-introduction must be deliberate (a new test pin would then
    // need updating).
    expect(timesheetSrc).not.toMatch(/['"]Open session['"]/);
    // Sanity: the new qualified copy is actually present in source
    // so a future refactor that drops the remark altogether (silent
    // regression) also trips a pin.
    expect(timesheetSrc).toMatch(/Present since/);
  });
});
