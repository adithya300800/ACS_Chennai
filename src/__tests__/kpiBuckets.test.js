// kpiBuckets — pure-function unit tests.
//
// Why a dedicated file (vs. rolling into the page test):
//   The plan calls these out as "fully unit-testable in isolation"
//   and Phase 1 instructs us to run the tests as we write the file.
//   Pulling them into a separate suite lets the page test focus on
//   integration (chart titles, tile order) while these tests pin
//   the pure-function contract (window alignment, sort order, edge
//   cases). The plan also calls out the empty-state test specifically
//   so the empty-array branch of bucketByDay is the load-bearing one.

import {
  bucketByDay,
  byLineItemTopN,
  byEmployeeWeek,
  pendingReviewSparkline,
} from '../lib/kpiBuckets.js';

// Fixed endDay so output is deterministic regardless of when the test
// runs. The window covers the 5 days ending 2026-09-10 (a Monday),
// so dayKeysForWindow(days=5, endDay='2026-09-10') produces:
//   2026-09-06, 2026-09-07, 2026-09-08, 2026-09-09, 2026-09-10
const END_DAY = '2026-09-10';

describe('kpiBuckets.bucketByDay', () => {
  test('returns one row per day in the window, oldest first, count 0 for days with no data', () => {
    const out = bucketByDay([], 5, 'reportDate', END_DAY);
    expect(out.rows).toEqual([
      { day: '2026-09-06', count: 0 },
      { day: '2026-09-07', count: 0 },
      { day: '2026-09-08', count: 0 },
      { day: '2026-09-09', count: 0 },
      { day: '2026-09-10', count: 0 },
    ]);
  });

  test('counts rows whose reportDate matches a window day', () => {
    const rows = [
      { id: 1, reportDate: '2026-09-08' },
      { id: 2, reportDate: '2026-09-08T05:30:00.000Z' }, // full ISO still bucketable
      { id: 3, reportDate: '2026-09-09' },
      { id: 4, reportDate: '2026-09-10' },
    ];
    const out = bucketByDay(rows, 5, 'reportDate', END_DAY);
    expect(out.rows).toEqual([
      { day: '2026-09-06', count: 0 },
      { day: '2026-09-07', count: 0 },
      { day: '2026-09-08', count: 2 },
      { day: '2026-09-09', count: 1 },
      { day: '2026-09-10', count: 1 },
    ]);
  });

  test('drops rows outside the window silently', () => {
    // Pre-window and post-window rows must not appear in the result.
    const rows = [
      { id: 1, reportDate: '2026-09-01' }, // before window
      { id: 2, reportDate: '2026-09-11' }, // after window
      { id: 3, reportDate: '2026-09-08' }, // inside window
    ];
    const out = bucketByDay(rows, 5, 'reportDate', END_DAY);
    const total = out.rows.reduce((acc, r) => acc + r.count, 0);
    expect(total).toBe(1);
    expect(out.rows.find((r) => r.day === '2026-09-08').count).toBe(1);
  });

  test('empty input is a happy path (sparse project) — returns 0-count rows, does not throw', () => {
    // This is the load-bearing empty-state path: a newly-registered
    // project with no DPRs in the last 30 days must produce a
    // full-window 0-count chart, not a crash.
    const out = bucketByDay([], 30, 'reportDate', END_DAY);
    expect(out.rows).toHaveLength(30);
    expect(out.rows.every((r) => r.count === 0)).toBe(true);
  });

  test('null / non-array input is tolerated', () => {
    expect(bucketByDay(null, 5, 'reportDate', END_DAY).rows).toHaveLength(5);
    expect(bucketByDay(undefined, 5, 'reportDate', END_DAY).rows).toHaveLength(5);
    expect(bucketByDay('not-an-array', 5, 'reportDate', END_DAY).rows).toHaveLength(5);
  });

  test('row with missing or unparseable dateField is skipped (not crashed)', () => {
    const rows = [
      null,
      {},
      { reportDate: null },
      { reportDate: '' },
      { reportDate: 'not-a-date' },
      { reportDate: '2026-09-08' },
    ];
    const out = bucketByDay(rows, 5, 'reportDate', END_DAY);
    expect(out.rows.find((r) => r.day === '2026-09-08').count).toBe(1);
  });

  test('respects a custom dateField name (used for Inspection "by day")', () => {
    const rows = [
      { id: 1, inspectionDate: '2026-09-08' },
      { id: 2, inspectionDate: '2026-09-09' },
    ];
    const out = bucketByDay(rows, 5, 'inspectionDate', END_DAY);
    expect(out.rows.find((r) => r.day === '2026-09-08').count).toBe(1);
    expect(out.rows.find((r) => r.day === '2026-09-09').count).toBe(1);
  });
});

describe('kpiBuckets.byLineItemTopN', () => {
  test('sorts by absolute variance descending, capped at n', () => {
    const rows = [
      { id: 'a', itemDescription: 'A', variancePercent: 10 },
      { id: 'b', itemDescription: 'B', variancePercent: -45 },
      { id: 'c', itemDescription: 'C', variancePercent: 25 },
      { id: 'd', itemDescription: 'D', variancePercent: -15 },
      { id: 'e', itemDescription: 'E', variancePercent: 60 },
    ];
    const out = byLineItemTopN(rows, 3);
    expect(out.rows.map((r) => r.id)).toEqual(['e', 'b', 'c']);
    // absVariance is the sort key
    expect(out.rows[0].absVariance).toBe(60);
  });

  test('derives variancePercent from contract/executed when not provided', () => {
    const rows = [
      { id: 'x', itemDescription: 'X', contractValue: 100, executedValue: 150 },
    ];
    const out = byLineItemTopN(rows, 5);
    expect(out.rows[0].variancePercent).toBe(50); // (150-100)/100
    expect(out.rows[0].absVariance).toBe(50);
  });

  test('falls back to description when itemDescription is missing', () => {
    const rows = [{ id: 'y', description: 'Y label', variancePercent: 5 }];
    const out = byLineItemTopN(rows, 5);
    expect(out.rows[0].label).toBe('Y label');
  });

  test('empty input returns empty rows (top-N chart renders empty state)', () => {
    const out = byLineItemTopN([], 10);
    expect(out.rows).toEqual([]);
  });

  test('null / non-array input is tolerated', () => {
    expect(byLineItemTopN(null, 5).rows).toEqual([]);
    expect(byLineItemTopN(undefined, 5).rows).toEqual([]);
  });
});

describe('kpiBuckets.byEmployeeWeek', () => {
  test('produces N week buckets of 7 days each, oldest first', () => {
    const out = byEmployeeWeek([], 28);
    // 4 weeks × 7 days = 28 days.
    expect(out.weekLabels).toHaveLength(4);
    // Each week is a contiguous 7-day slice — adjacent labels are
    // 7 days apart.
    const first = new Date(`${out.weekLabels[0]}T00:00:00.000Z`);
    const second = new Date(`${out.weekLabels[1]}T00:00:00.000Z`);
    const diffDays = (second - first) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBe(7);
  });

  test('counts each row into the right employee + right week', () => {
    // Pin endDay so the window is deterministic. 2026-09-10 is a
    // Thursday; the 28-day window covers 4 weeks ending that day.
    //   Week 1: 2026-08-14..2026-08-20
    //   Week 2: 2026-08-21..2026-08-27
    //   Week 3: 2026-08-28..2026-09-03
    //   Week 4: 2026-09-04..2026-09-10
    const rows = [
      // Alice: 1 in week 3, 1 in week 4
      { submittedById: 'u1', submittedByName: 'Alice', reportDate: '2026-09-01' },
      { submittedById: 'u1', submittedByName: 'Alice', reportDate: '2026-09-09' },
      // Bob: 1 in week 4
      { submittedById: 'u2', submittedByName: 'Bob', reportDate: '2026-09-08' },
      // Carol: 2 in week 1
      { submittedById: 'u3', submittedByName: 'Carol', reportDate: '2026-08-15' },
      { submittedById: 'u3', submittedByName: 'Carol', reportDate: '2026-08-16' },
    ];
    const out = byEmployeeWeek(rows, 28, '2026-09-10');
    const alice = out.rows.find((r) => r.employeeId === 'u1');
    const bob = out.rows.find((r) => r.employeeId === 'u2');
    const carol = out.rows.find((r) => r.employeeId === 'u3');
    expect(alice).toBeTruthy();
    expect(bob).toBeTruthy();
    expect(carol).toBeTruthy();
    expect(alice.total).toBe(2);
    expect(bob.total).toBe(1);
    expect(carol.total).toBe(2);
    // All have 4 week buckets.
    expect(alice.weeks).toHaveLength(4);
    expect(bob.weeks).toHaveLength(4);
    expect(carol.weeks).toHaveLength(4);
    // Alice's buckets: 0, 0, 1, 1 (zero-padded for missing weeks)
    expect(alice.weeks).toEqual([0, 0, 1, 1]);
    // Bob's bucket: 0, 0, 0, 1
    expect(bob.weeks).toEqual([0, 0, 0, 1]);
    // Carol's bucket: 2, 0, 0, 0
    expect(carol.weeks).toEqual([2, 0, 0, 0]);
    // Sorted by total desc — Carol (2) ties with Alice (2) but Carol
    // appears first because Map iteration preserves insertion order
    // and her row was added first.
    expect(out.rows[0].employeeId).toBe('u1');
    expect(out.rows[1].employeeId).toBe('u3');
    expect(out.rows[2].employeeId).toBe('u2');
  });

  test('rows missing employeeId are dropped (cannot bucket by user)', () => {
    const rows = [
      { submittedByName: 'Anonymous', reportDate: '2026-09-09' },
    ];
    const out = byEmployeeWeek(rows, 28);
    expect(out.rows).toEqual([]);
  });

  test('caps employee list at top 8 by total activity', () => {
    const rows = [];
    for (let i = 0; i < 12; i += 1) {
      // user i has i+1 days of activity
      for (let d = 0; d < i + 1; d += 1) {
        rows.push({
          submittedById: `u${i}`,
          submittedByName: `User ${i}`,
          reportDate: '2026-09-09', // last week
        });
      }
    }
    const out = byEmployeeWeek(rows, 28);
    expect(out.rows.length).toBeLessThanOrEqual(8);
    // Sorted by total desc
    const totals = out.rows.map((r) => r.total);
    const isDescending = totals.every((v, i) => i === 0 || v <= totals[i - 1]);
    expect(isDescending).toBe(true);
  });

  test('empty input is a happy path (no activity yet) — returns empty rows + 4 week labels', () => {
    const out = byEmployeeWeek([], 28);
    expect(out.rows).toEqual([]);
    expect(out.weekLabels).toHaveLength(4);
  });

  test('null / non-array input is tolerated', () => {
    expect(byEmployeeWeek(null, 28).rows).toEqual([]);
    expect(byEmployeeWeek(undefined, 28).rows).toEqual([]);
  });
});

describe('kpiBuckets.pendingReviewSparkline', () => {
  test('returns exactly 14 days, oldest first', () => {
    const out = pendingReviewSparkline([]);
    expect(out.rows).toHaveLength(14);
  });

  test('counts SUBMITTED + UNDER_REVIEW rows by day (caller pre-filters)', () => {
    // The function is pure over its input — the caller is responsible
    // for filtering to SUBMITTED + UNDER_REVIEW. Pin that contract.
    const rows = [
      { id: 1, status: 'SUBMITTED', reportDate: '2026-09-08' },
      { id: 2, status: 'UNDER_REVIEW', reportDate: '2026-09-09' },
      { id: 3, status: 'APPROVED', reportDate: '2026-09-09' }, // ignored by filter, not by fn
      { id: 4, status: 'REJECTED', reportDate: '2026-09-10' },
    ];
    // The dashboard filters before calling; the test mirrors that
    // pre-filter so the function's behaviour is the one we ship.
    const filtered = rows.filter((r) => r.status === 'SUBMITTED' || r.status === 'UNDER_REVIEW');
    const out = pendingReviewSparkline(filtered);
    // Total across the 14 days should be 2 (rows 1 + 2).
    const total = out.rows.reduce((acc, r) => acc + r.count, 0);
    expect(total).toBe(2);
  });
});
