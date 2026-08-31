#!/usr/bin/env node
/**
 * Round-13 standalone test runner.
 *
 * Why this exists: jest cannot start in this sandbox (silent hang before
 * the "Determining test suites to run" line — appears to be a child-process
 * issue specific to the Mac sandbox). The leave + timesheet modules are
 * pure JS with no DB / network / DOM, so we can exercise them with a
 * tiny assertion harness that mirrors the jest test names so the intent
 * stays clear.
 *
 * Usage: node scripts/round13-tests.js
 *
 * Exits 0 if all assertions pass, 1 otherwise.
 */

'use strict';

process.env.TZ = process.env.TZ || 'Asia/Kolkata';

const path = require('path');
const lib = require('../src/lib/leaveRules');
const ts = require('../src/lib/timesheet');

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push({ name, detail });
    console.error(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(name, a === b, `actual=${a} expected=${b}`);
}
function header(s) { console.log(`\n[${s}]`); }

// ============ leaveRules.parseLeaveDate ============
header('leaveRules.parseLeaveDate');
{
  const d = lib.parseLeaveDate('2026-08-30');
  ok('YYYY-MM-DD parses', !!d);
  eq('YYYY-MM-DD year/month/day', [d.getFullYear(), d.getMonth(), d.getDate()], [2026, 7, 30]);
  eq('local-midnight hour', d.getHours(), 0);
  ok('ISO with time parses', lib.parseLeaveDate('2026-08-30T18:30:00Z') != null);
  ok('Date instance parses', lib.parseLeaveDate(new Date(2026, 0, 5)) != null);
  ok('null → null', lib.parseLeaveDate(null) == null);
  ok('undefined → null', lib.parseLeaveDate(undefined) == null);
  ok('empty → null', lib.parseLeaveDate('') == null);
  ok('garbage → null', lib.parseLeaveDate('not-a-date') == null);
  ok('bad month → null', lib.parseLeaveDate('2026-13-01') == null);
  ok('Feb 30 → null', lib.parseLeaveDate('2026-02-30') == null);
  ok('Apr 31 → null', lib.parseLeaveDate('2026-04-31') == null);
  ok('leap Feb 29 → not null', lib.parseLeaveDate('2024-02-29') != null);
  ok('non-leap Feb 29 → null', lib.parseLeaveDate('2025-02-29') == null);
}

// ============ leaveRules.inclusiveDayCount ============
header('leaveRules.inclusiveDayCount');
{
  const d = (s) => lib.parseLeaveDate(s);
  eq('same day = 1', lib.inclusiveDayCount(d('2026-08-30'), d('2026-08-30')), 1);
  eq('5-day window = 5', lib.inclusiveDayCount(d('2026-08-30'), d('2026-09-03')), 5);
  eq('cross month', lib.inclusiveDayCount(d('2026-08-30'), d('2026-09-02')), 4);
  eq('cross year', lib.inclusiveDayCount(d('2026-12-30'), d('2027-01-02')), 4);
  eq('end before start → 0', lib.inclusiveDayCount(d('2026-08-30'), d('2026-08-29')), 0);
  eq('null start → 0', lib.inclusiveDayCount(null, d('2026-08-30')), 0);
}

// ============ leaveRules.rangesOverlap ============
header('leaveRules.rangesOverlap');
{
  const t = (s) => lib.parseLeaveDate(s).getTime();
  ok('touch at day 5', lib.rangesOverlap(t('2026-08-01'), t('2026-08-05'), t('2026-08-05'), t('2026-08-09')));
  ok('b inside a', lib.rangesOverlap(t('2026-08-01'), t('2026-08-09'), t('2026-08-03'), t('2026-08-05')));
  ok('a inside b', lib.rangesOverlap(t('2026-08-03'), t('2026-08-05'), t('2026-08-01'), t('2026-08-09')));
  ok('disjoint', !lib.rangesOverlap(t('2026-08-01'), t('2026-08-05'), t('2026-08-06'), t('2026-08-09')));
  ok('null start', !lib.rangesOverlap(null, t('2026-08-05'), t('2026-08-01'), t('2026-08-09')));
}

// ============ leaveRules.validateCreatePayload ============
header('leaveRules.validateCreatePayload');
{
  const today = lib.parseLeaveDate('2026-08-15');
  const happy = lib.validateCreatePayload(
    { startDate: '2026-08-20', endDate: '2026-08-22', leaveType: 'CASUAL', reason: 'Family function' },
    { now: today }
  );
  ok('happy path ok', happy.ok === true);
  eq('happy reason trimmed', happy.value && happy.value.reason, 'Family function');

  const trimmed = lib.validateCreatePayload(
    { startDate: '2026-08-20', endDate: '2026-08-20', leaveType: 'CASUAL', reason: '   sick leave   ' },
    { now: today }
  );
  eq('whitespace trimmed', trimmed.value.reason, 'sick leave');

  ok('null body', lib.validateCreatePayload(null, { now: today }).code === 'INVALID_BODY');
  ok('bad start', lib.validateCreatePayload({ startDate: 'x', endDate: '2026-08-20', leaveType: 'CASUAL', reason: 'aaaaa' }, { now: today }).code === 'INVALID_START_DATE');
  ok('bad end', lib.validateCreatePayload({ startDate: '2026-08-20', endDate: 'x', leaveType: 'CASUAL', reason: 'aaaaa' }, { now: today }).code === 'INVALID_END_DATE');
  ok('end before start', lib.validateCreatePayload({ startDate: '2026-08-22', endDate: '2026-08-20', leaveType: 'CASUAL', reason: 'aaaaa' }, { now: today }).code === 'INVALID_DATE_RANGE');
  ok('future > 365d', lib.validateCreatePayload({ startDate: '2027-12-31', endDate: '2027-12-31', leaveType: 'CASUAL', reason: 'aaaaa' }, { now: today }).code === 'FUTURE_DATE');
  ok('past > 90d', lib.validateCreatePayload({ startDate: '2026-04-01', endDate: '2026-04-01', leaveType: 'CASUAL', reason: 'aaaaa' }, { now: today }).code === 'PAST_DATE');
  ok('duration > 90d', lib.validateCreatePayload({ startDate: '2026-08-16', endDate: '2026-11-15', leaveType: 'CASUAL', reason: 'aaaaa' }, { now: today }).code === 'INVALID_DATE_RANGE');
  ok('bad leaveType', lib.validateCreatePayload({ startDate: '2026-08-20', endDate: '2026-08-20', leaveType: 'BEREAVEMENT', reason: 'aaaaa' }, { now: today }).code === 'INVALID_LEAVE_TYPE');
  ok('reason too short', lib.validateCreatePayload({ startDate: '2026-08-20', endDate: '2026-08-20', leaveType: 'CASUAL', reason: 'hi' }, { now: today }).code === 'REASON_TOO_SHORT');
  ok('reason too long', lib.validateCreatePayload({ startDate: '2026-08-20', endDate: '2026-08-20', leaveType: 'CASUAL', reason: 'a'.repeat(1001) }, { now: today }).code === 'REASON_TOO_LONG');
  ok('non-string reason', lib.validateCreatePayload({ startDate: '2026-08-20', endDate: '2026-08-20', leaveType: 'CASUAL', reason: 12345 }, { now: today }).code === 'INVALID_REASON');

  for (const t of ['CASUAL', 'SICK', 'EARNED', 'UNPAID', 'OPTIONAL']) {
    const r = lib.validateCreatePayload({ startDate: '2026-08-20', endDate: '2026-08-20', leaveType: t, reason: 'aaaaa' }, { now: today });
    ok(`accepts ${t}`, r.ok === true);
  }
}

// ============ leaveRules.canTransition ============
header('leaveRules.canTransition');
{
  ok('P→A', lib.canTransition('PENDING', 'APPROVED'));
  ok('P→R', lib.canTransition('PENDING', 'REJECTED'));
  ok('P→C', lib.canTransition('PENDING', 'CANCELLED'));
  ok('A→P (terminal)', !lib.canTransition('APPROVED', 'PENDING'));
  ok('R→A (terminal)', !lib.canTransition('REJECTED', 'APPROVED'));
  ok('C→P (terminal)', !lib.canTransition('CANCELLED', 'PENDING'));
  ok('unknown from', !lib.canTransition('UNKNOWN', 'APPROVED'));
  ok('unknown to', !lib.canTransition('PENDING', 'UNKNOWN'));
}

// ============ leaveRules.httpStatusForCode ============
header('leaveRules.httpStatusForCode');
{
  eq('validation → 400', lib.httpStatusForCode('INVALID_START_DATE'), 400);
  eq('overlap → 409', lib.httpStatusForCode('LEAVE_OVERLAP'), 409);
  eq('not-found → 404', lib.httpStatusForCode('NOT_FOUND'), 404);
  eq('forbidden → 403', lib.httpStatusForCode('FORBIDDEN'), 403);
}

// ============ timesheet.dayKey ============
header('timesheet.dayKey');
{
  const at = new Date(2026, 7, 15, 14, 30);
  eq('Date → local-midnight ms', ts.dayKey(at), new Date(2026, 7, 15).getTime());
  eq('string → ms', ts.dayKey('2026-08-30'), new Date(2026, 7, 30).getTime());
  eq('number passes through', ts.dayKey(new Date(2026, 7, 15).getTime()), new Date(2026, 7, 15).getTime());
  ok('null → null', ts.dayKey(null) == null);
  ok('garbage → null', ts.dayKey('xxx') == null);
}

// ============ timesheet.formatDateStr / formatTimeStr ============
header('timesheet.formatDateStr / formatTimeStr');
{
  eq('formatDateStr', ts.formatDateStr(new Date(2026, 7, 15, 14, 30)), '2026-08-15');
  eq('formatTimeStr', ts.formatTimeStr(new Date(2026, 7, 15, 9, 5)), '09:05');
  eq('formatTimeStr null', ts.formatTimeStr(null), '—');
  eq('formatDateStr number', ts.formatDateStr(new Date(2026, 7, 15).getTime()), '2026-08-15');
}

// ============ timesheet.inclusiveDayCount ============
header('timesheet.inclusiveDayCount');
{
  eq('same day', ts.inclusiveDayCount('2026-08-30', '2026-08-30'), 1);
  eq('5-day window', ts.inclusiveDayCount('2026-08-30', '2026-09-03'), 5);
  eq('Feb leap', ts.inclusiveDayCount('2024-02-01', '2024-02-29'), 29);
  eq('Feb non-leap', ts.inclusiveDayCount('2025-02-01', '2025-02-28'), 28);
}

// ============ timesheet.sumSessionHours ============
header('timesheet.sumSessionHours');
{
  ok('empty → null', ts.sumSessionHours([]) == null);
  ok('null → null', ts.sumSessionHours(null) == null);
  const at = (h, m) => new Date(2026, 7, 15, h, m, 0);
  eq('2 sessions, 7.5h', ts.sumSessionHours([
    { checkIn: at(9, 0), checkOut: at(12, 0) },
    { checkIn: at(13, 0), checkOut: at(17, 30) },
  ]), 7.5);
  eq('open session ignored', ts.sumSessionHours([
    { checkIn: at(9, 0), checkOut: at(12, 0) },
    { checkIn: at(13, 0), checkOut: null },
  ]), 3);
  eq('clean 8h', ts.sumSessionHours([{ checkIn: at(9, 0), checkOut: at(17, 0) }]), 8);
}

// ============ timesheet.buildAttendanceMap / buildLeaveMap ============
header('timesheet.buildAttendanceMap / buildLeaveMap');
{
  const dms = new Date(2026, 7, 15).getTime();
  const aMap = ts.buildAttendanceMap([
    { id: 'a1', employeeId: 'emp1', date: dms, sessions: [{ checkIn: new Date() }] },
    { id: 'a2', employeeId: 'emp1', date: new Date(2026, 7, 16).getTime(), sessions: [] },
  ]);
  ok('buildAttendanceMap keyed by day', aMap.emp1[dms] && aMap.emp1[dms].id === 'a1');

  const lMap = ts.buildLeaveMap(
    [
      { id: 'l1', status: 'PENDING', startDate: dms, endDate: dms, leaveType: 'CASUAL' },
      { id: 'l2', status: 'APPROVED', startDate: dms, endDate: dms, leaveType: 'SICK' },
      { id: 'l3', status: 'REJECTED', startDate: dms, endDate: dms, leaveType: 'CASUAL' },
    ],
    { includeStatuses: ['APPROVED'] }
  );
  ok('buildLeaveMap filters by status', lMap[dms] && lMap[dms].leaveType === 'SICK');

  const ml = ts.buildLeaveMap(
    [{ id: 'l1', status: 'APPROVED', startDate: new Date(2026, 7, 10).getTime(), endDate: new Date(2026, 7, 12).getTime(), leaveType: 'EARNED' }],
    { includeStatuses: ['APPROVED'] }
  );
  ok('multi-day range covers middle', ml[new Date(2026, 7, 11).getTime()].leaveType === 'EARNED');
}

// ============ timesheet.resolveStatus priority ============
header('timesheet.resolveStatus');
{
  const todayMs = new Date(2026, 7, 15).getTime();
  const fri = new Date(2026, 7, 14).getTime();
  const sat = new Date(2026, 7, 15).getTime(); // today is a Saturday
  const lastSun = new Date(2026, 7, 9).getTime(); // a Sunday in the past
  const nextSat = new Date(2026, 7, 22).getTime();
  const at = (h, m) => new Date(2026, 7, 15, h, m, 0);
  ok('Approved leave wins', ts.resolveStatus({ dateMs: fri, attendanceRow: { sessions: [{ checkIn: at(9, 0) }] }, leaveMap: { [fri]: { leaveType: 'CASUAL' } }, todayMs }) === 'Leave');
  ok('Present overrides Absent', ts.resolveStatus({ dateMs: fri, attendanceRow: { sessions: [{ checkIn: at(9, 0) }] }, leaveMap: null, todayMs }) === 'Present');
  ok('Empty past Saturday → Weekend (today so not Future)', ts.resolveStatus({ dateMs: sat, attendanceRow: null, leaveMap: null, todayMs }) === 'Weekend');
  ok('Past Sunday → Weekend', ts.resolveStatus({ dateMs: lastSun, attendanceRow: null, leaveMap: null, todayMs }) === 'Weekend');
  ok('Weekend with check-in → Present', ts.resolveStatus({ dateMs: sat, attendanceRow: { sessions: [{ checkIn: at(9, 0) }] }, leaveMap: null, todayMs }) === 'Present');
  ok('Next Sat → Future (not Weekend)', ts.resolveStatus({ dateMs: nextSat, attendanceRow: null, leaveMap: null, todayMs }) === 'Future');
  ok('Past Fri no atd → Absent', ts.resolveStatus({ dateMs: fri, attendanceRow: null, leaveMap: null, todayMs }) === 'Absent');
  ok('Empty atd → Absent', ts.resolveStatus({ dateMs: fri, attendanceRow: { sessions: [] }, leaveMap: null, todayMs }) === 'Absent');
}

// ============ timesheet.buildTimesheetRows ============
header('timesheet.buildTimesheetRows');
{
  const emp = [
    { id: 'e1', name: 'Alice', department: 'Eng' },
    { id: 'e2', name: 'Bob', department: 'Ops' },
  ];
  const r1 = ts.buildTimesheetRows({ employees: emp, attendanceRows: [], leaveRequests: [], month: '2026-08', today: new Date(2026, 7, 1) });
  ok('rows × days × employees', r1.rows.length === 31 * 2);
  ok('summary employees', r1.summary.employees === 2);
  ok('first row date is 2026-08-01', r1.rows[0].date === '2026-08-01');
  ok('last row date is 2026-08-31', r1.rows[r1.rows.length - 1].date === '2026-08-31');
  ok('every row has date key', r1.rows.every(x => typeof x.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.date)));

  const r2 = ts.buildTimesheetRows({ employees: [{ id: 'e1', name: 'A' }], attendanceRows: [], leaveRequests: [], month: '2024-02', today: new Date(2024, 1, 28) });
  eq('Feb leap → 29 days', r2.rows.length, 29);

  const r3 = ts.buildTimesheetRows({ employees: [{ id: 'e1', name: 'A' }], attendanceRows: [], leaveRequests: [], month: '2025-02', today: new Date(2025, 1, 28) });
  eq('Feb non-leap → 28 days', r3.rows.length, 28);

  const at = (h, m) => new Date(2026, 7, 14, h, m, 0);
  const r4 = ts.buildTimesheetRows({
    employees: [{ id: 'e1', name: 'Alice', department: 'Eng' }],
    attendanceRows: [{ id: 'a1', employeeId: 'e1', date: new Date(2026, 7, 14).getTime(), sessions: [
      { checkIn: at(9, 0), checkOut: at(12, 0) },
      { checkIn: at(13, 0), checkOut: at(17, 30) },
    ] }],
    leaveRequests: [],
    month: '2026-08',
    today: new Date(2026, 7, 14),
  });
  const row14 = r4.rows.find(x => x.date === '2026-08-14');
  ok('present row status', row14.status === 'Present');
  eq('present first check-in', row14.firstCheckIn, '09:00');
  eq('present last check-out', row14.lastCheckOut, '17:30');
  eq('present worked hours', row14.workedHours, '7.50');
  eq('present session count', row14.sessionCount, 2);

  const r5 = ts.buildTimesheetRows({
    employees: [{ id: 'e1', name: 'Alice', department: 'Eng' }],
    attendanceRows: [{ id: 'a1', employeeId: 'e1', date: new Date(2026, 7, 14).getTime(), sessions: [{ checkIn: at(9, 0), checkOut: at(17, 0) }] }],
    leaveRequests: [{ id: 'l1', status: 'APPROVED', startDate: new Date(2026, 7, 14).getTime(), endDate: new Date(2026, 7, 14).getTime(), leaveType: 'CASUAL' }],
    month: '2026-08',
    today: new Date(2026, 7, 14),
  });
  const leaveRow = r5.rows.find(x => x.date === '2026-08-14');
  ok('approved leave overrides present', leaveRow.status === 'Leave');
  eq('leaveType set', leaveRow.leaveType, 'CASUAL');

  const r6 = ts.buildTimesheetRows({
    employees: [{ id: 'e1', name: 'Alice', department: 'Eng' }],
    attendanceRows: [],
    leaveRequests: [{ id: 'l1', status: 'PENDING', startDate: new Date(2026, 7, 14).getTime(), endDate: new Date(2026, 7, 14).getTime(), leaveType: 'CASUAL' }],
    month: '2026-08',
    today: new Date(2026, 7, 14),
  });
  const pendingRow = r6.rows.find(x => x.date === '2026-08-14');
  ok('pending leave does NOT mark Leave', pendingRow.status === 'Absent');
  eq('pending leave leaves leaveType blank', pendingRow.leaveType, '');

  // Malformed month
  let threw1 = false, threw2 = false;
  try { ts.buildTimesheetRows({ employees: emp, attendanceRows: [], leaveRequests: [], month: '2026-8', today: new Date() }); } catch (e) { threw1 = true; }
  try { ts.buildTimesheetRows({ employees: emp, attendanceRows: [], leaveRequests: [], month: 'Aug 2026', today: new Date() }); } catch (e) { threw2 = true; }
  ok('rejects 2026-8', threw1);
  ok('rejects Aug 2026', threw2);

  // Summary adds up
  const total = r1.summary.totalPresent + r1.summary.totalAbsent + r1.summary.totalLeave + r1.summary.totalWeekend + r1.summary.totalFuture;
  ok('summary totals add up', total === r1.summary.daysRendered);

  // TIMESHEET_COLUMNS contract
  ok('TIMESHEET_COLUMNS has expected keys', ts.TIMESHEET_COLUMNS.map(c => c.key).every(k => ['date','employeeId','employeeName','department','status','firstCheckIn','lastCheckOut','workedHours','sessionCount','leaveType','remarks'].includes(k)));
  ok('every column has width', ts.TIMESHEET_COLUMNS.every(c => typeof c.width === 'number' && c.width > 0));
}

// ============ Leave router integration (mocked Prisma) ============
//
// Spins up an Express app, mounts the real /api/leave router, and stubs
// req.app.get('prisma') with a tiny in-memory store. This exercises the
// real route handlers + real validators + real error mapping without
// needing Postgres. Captures console.error so Prisma $transaction noise
// doesn't leak into the test output.
header('leave router integration (Express + mocked Prisma)');
{
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
  process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-must-be-at-least-32-chars-BBBB';
  process.env.PII_LOG_SALT = process.env.PII_LOG_SALT || 'test-pii-salt-32-chars-min-deadbeef';
  const jwt = require('jsonwebtoken');
  const tok = (sub, role) => jwt.sign({ employeeId: sub, email: sub + '@x', isAdmin: role === 'admin' }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
  const empTok = tok('emp-1', 'employee');
  const emp2Tok = tok('emp-2', 'employee');
  const adminTok = tok('admin-1', 'admin');

  const express = require('express');
  const leaveRouter = require('../src/routes/leave');

  // Tiny in-memory store for LeaveRequest rows.
  const store = [];
  let nextId = 1;
  const prisma = {
    leaveRequest: {
      create: async ({ data }) => {
        const row = { id: 'lv' + (nextId++), status: 'PENDING', reviewedById: null, reviewedAt: null, reviewNotes: null, cancelledAt: null, createdAt: new Date(), updatedAt: new Date(), notifications: [], ...data };
        store.push(row);
        return row;
      },
      findUnique: async ({ where, include }) => {
        const row = store.find(r => r.id === where.id);
        if (!row) return null;
        if (include && include.employee) {
          return { ...row, employee: { id: row.employeeId, name: 'Mock User', email: 'mock@x', department: 'Eng' } };
        }
        return row;
      },
      findFirst: async ({ where }) => {
        // Honor status filter, then return the first matching.
        return store
          .filter(r => !where.status || r.status === where.status)
          .filter(r => !where.employeeId || r.employeeId === where.employeeId)
          .sort((a, b) => b.createdAt - a.createdAt)[0] || null;
      },
      findMany: async ({ where, orderBy, take }) => {
        let rows = store.slice();
        if (where) {
          if (where.employeeId) rows = rows.filter(r => r.employeeId === where.employeeId);
          if (where.status) rows = rows.filter(r => r.status === where.status);
          if (where.OR) {
            const st = where.OR[0].status;
            rows = rows.filter(r => r.status === st);
          }
          if (where.AND) {
            // overlap test
            const [s, e] = where.AND[0].endDate.gte;
            rows = rows.filter(r => r.startDate <= e && r.endDate >= s);
          }
        }
        if (orderBy && orderBy.createdAt === 'desc') rows.sort((a, b) => b.createdAt - a.createdAt);
        if (take) rows = rows.slice(0, take);
        // Decorate with employee + reviewer names so output matches real schema.
        return rows.map(r => ({
          ...r,
          employee: { id: r.employeeId, name: 'Mock User', email: 'mock@x', department: 'Eng' },
          reviewedBy: r.reviewedById ? { id: r.reviewedById, name: 'Admin' } : null,
        }));
      },
      count: async () => store.length,
      update: async ({ where, data }) => {
        const row = store.find(r => r.id === where.id);
        if (!row) { const e = new Error('Not found'); e.code = 'P2025'; throw e; }
        // Guarded update: skip if status filter rejects.
        if (where && where.status && row.status !== where.status) {
          const e = new Error('Not found'); e.code = 'P2025'; throw e;
        }
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
    },
    notification: {
      create: async () => ({}),
    },
    $transaction: async (arg) => Array.isArray(arg) ? Promise.all(arg) : arg(prisma),
  };

  const app = express();
  app.use(express.json());
  app.set('prisma', prisma);
  // Use REAL requireAuth — pass real HS256 JWT tokens in `Authorization: Bearer ...`.
  app.use('/api/leave', leaveRouter);

  const http = require('http');

  (async () => {
    // Wait for listening before reading the port — app.listen(0) is async.
    const server = await new Promise((resolve, reject) => {
      const s = app.listen(0, () => resolve(s));
      s.on('error', reject);
    });
    const port = server.address().port;
    const call = (method, path, body, headers = {}) => new Promise((resolve) => {
      const data = body ? JSON.stringify(body) : null;
      const req = http.request({
        hostname: '127.0.0.1', port, path, method,
        headers: {
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
          ...headers,
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({ status: res.statusCode, headers: res.headers, body: buf.toString('utf8') });
        });
      });
      req.on('error', (e) => resolve({ status: 0, body: String(e) }));
      if (data) req.write(data);
      req.end();
    });
    // 1. Submit a valid leave request.
    let r = await call('POST', '/api/leave', {
      startDate: '2026-08-20', endDate: '2026-08-22', leaveType: 'CASUAL',
      reason: 'Live integration test — leave request submission',
    }, { 'Authorization': 'Bearer ' + empTok });
    ok('POST /api/leave valid → 201', r.status === 201);
    const created = JSON.parse(r.body);
    const newId = created.id;
    ok('created has id', !!newId);

    // 2. Reject invalid payload.
    r = await call('POST', '/api/leave', {
      startDate: '2026-13-99', endDate: '2026-08-20', leaveType: 'CASUAL', reason: 'aa',
    }, { 'Authorization': 'Bearer ' + empTok });
    ok('POST /api/leave invalid → 400', r.status === 400);

    // 3. GET /my lists the request.
    r = await call('GET', '/api/leave/my', null, { 'Authorization': 'Bearer ' + empTok });
    ok('GET /api/leave/my → 200', r.status === 200);
    const my = JSON.parse(r.body);
    ok('my requests has the new one', (my.requests || []).some(x => x.id === newId));

    // 4. Admin queue lists it.
    r = await call('GET', '/api/leave', null, { 'Authorization': 'Bearer ' + adminTok });
    ok('GET /api/leave admin → 200', r.status === 200);
    const q = JSON.parse(r.body);
    ok('admin queue has the new one', (q.requests || []).some(x => x.id === newId));

    // 5. Non-admin approve attempt.
    r = await call('POST', `/api/leave/${newId}/approve`, {}, { 'Authorization': 'Bearer ' + empTok });
    // emp-1 is not admin so first this should be 403 (admin-only).
    ok('approve non-admin → 403', r.status === 403);

    // 6. Admin can approve.
    r = await call('POST', `/api/leave/${newId}/approve`, { reviewNotes: 'lgtm' }, { 'Authorization': 'Bearer ' + adminTok });
    ok('approve as admin → 200', r.status === 200, `got ${r.status}: ${r.body}`);

    // 7. Re-approve should fail with 409 (already decided).
    r = await call('POST', `/api/leave/${newId}/approve`, {}, { 'Authorization': 'Bearer ' + adminTok });
    ok('re-approve already-decided → 409', r.status === 409, `got ${r.status}`);

    // 8. Submit a second request and reject it.
    r = await call('POST', '/api/leave', {
      startDate: '2026-08-25', endDate: '2026-08-25', leaveType: 'SICK', reason: 'going to be sick',
    }, { 'Authorization': 'Bearer ' + emp2Tok });
    const r2id = JSON.parse(r.body).id;
    r = await call('POST', `/api/leave/${r2id}/reject`, { reviewNotes: 'too short notice' }, { 'Authorization': 'Bearer ' + adminTok });
    ok('reject as admin → 200', r.status === 200, `got ${r.status}: ${r.body}`);

    // 9. Cancel own PENDING request.
    const emp3Tok = jwt.sign({ employeeId: 'emp-3', email: 'emp-3@x', isAdmin: false }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
    r = await call('POST', '/api/leave', {
      startDate: '2026-08-26', endDate: '2026-08-26', leaveType: 'CASUAL', reason: 'cancelling test',
    }, { 'Authorization': 'Bearer ' + emp3Tok });
    const r3id = JSON.parse(r.body).id;
    r = await call('POST', `/api/leave/${r3id}/cancel`, {}, { 'Authorization': 'Bearer ' + emp3Tok });
    ok('cancel own → 200', r.status === 200);

    // 10. Cancel someone else's request — should 403/404.
    const emp4Tok = jwt.sign({ employeeId: 'emp-4', email: 'emp-4@x', isAdmin: false }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
    r = await call('POST', `/api/leave/${r3id}/cancel`, {}, { 'Authorization': 'Bearer ' + emp4Tok });
    ok('cancel someone else → not 200', r.status !== 200);

    server.close();
  })().catch((e) => {
    try { server.close(); } catch (_) {}
    ok('integration did not throw', false, String(e));
  });
}

// ============ Attendance export integration (mocked Prisma) ============
header('attendance export integration (mocked Prisma)');
{
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
  process.env.PII_LOG_SALT = process.env.PII_LOG_SALT || 'test-pii-salt-32-chars-min-deadbeef';
  const express = require('express');
  const attendanceRouter = require('../src/routes/attendance');
  const jwt = require('jsonwebtoken');

  const employees = [
    { id: 'e1', name: 'Alice', department: 'Eng' },
    { id: 'e2', name: 'Bob', department: 'Ops' },
  ];
  const attendance = [
    { id: 'a1', employeeId: 'e1', date: new Date(2026, 7, 14).getTime(), status: 'OPEN', notes: '', sessions: [
      { id: 's1', checkIn: new Date(2026, 7, 14, 9, 0).toISOString(), checkOut: new Date(2026, 7, 14, 17, 0).toISOString(), checkInAddr: null, checkInLat: null, checkInLng: null },
    ] },
  ];

  const prisma = {
    employee: {
      findMany: async ({ where, orderBy }) => {
        let rows = employees.slice();
        if (where && where.isAdmin === false) rows = rows.filter(e => true); // all are non-admin in mock
        if (orderBy && orderBy.name === 'asc') rows.sort((a, b) => a.name.localeCompare(b.name));
        return rows;
      },
      findUnique: async ({ where }) => employees.find(e => e.id === where.id) || null,
    },
    attendance: {
      findMany: async ({ where }) => {
        const empIds = where.employeeId.in;
        const start = where.date.gte.getTime();
        const end = where.date.lte.getTime();
        return attendance.filter(a => empIds.includes(a.employeeId) && a.date >= start && a.date <= end);
      },
    },
    leaveRequest: {
      findMany: async () => [], // no leave in this test
    },
  };

  const app = express();
  app.set('prisma', prisma);
  // Use REAL requireAuth + requireAdmin — pass real JWT tokens in Authorization header.
  app.use('/api/attendance', attendanceRouter);

  const adminAtdTok = jwt.sign({ employeeId: 'admin-1', email: 'a@x', isAdmin: true }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
  const userAtdTok = jwt.sign({ employeeId: 'user-1', email: 'u@x', isAdmin: false }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });

  const http = require('http');

  (async () => {
    const server = await new Promise((resolve, reject) => {
      const s = app.listen(0, () => resolve(s));
      s.on('error', reject);
    });
    const port = server.address().port;
    const call = (method, path, tok) => new Promise((resolve) => {
      const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: { 'Authorization': 'Bearer ' + (tok || adminAtdTok) } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        }));
      });
      req.on('error', (e) => resolve({ status: 0, body: Buffer.from(String(e)) }));
      req.end();
    });

    // Non-admin → 403.
    let r = await call('GET', '/api/attendance/export?month=2026-08', userAtdTok);
    ok('non-admin export → 403', r.status === 403, `got ${r.status}`);

    // Admin happy path.
    r = await call('GET', '/api/attendance/export?month=2026-08');
    ok('admin export → 200', r.status === 200, `got ${r.status}`);
    ok('Content-Type is xlsx/csv', /spreadsheetml|excel|csv/.test(r.headers['content-type'] || ''));
    ok('Content-Disposition set', !!r.headers['content-disposition'] && r.headers['content-disposition'].includes('attachment'));
    ok('X-Export-Format header set', !!r.headers['x-export-format']);
    ok('X-Export-Row-Count set', !!r.headers['x-export-row-count']);
    ok('body has bytes', r.body.length > 0);

    // Bad month → 400.
    r = await call('GET', '/api/attendance/export?month=bad');
    ok('bad month → 400', r.status === 400);

    // Missing month → 400.
    r = await call('GET', '/api/attendance/export');
    ok('missing month → 400', r.status === 400);

    server.close();
  })().catch((e) => {
    try { server.close(); } catch (_) {}
    ok('attendance export integration did not throw', false, String(e));
  });
}

// ===== summary =====
// Defer printing until any async integration suites above have had a
// chance to call ok()/fail(). We give them 5s to settle — if they hang,
// the runner exits with the failures recorded so far.
const settleAndPrint = () => setTimeout(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.error('\nFAILURES:');
    for (const f of failures) console.error(`  - ${f.name}: ${f.detail || ''}`);
    process.exit(1);
  }
  process.exit(0);
}, 5000);

if (typeof require.main !== 'undefined' && require.main === module) {
  settleAndPrint();
}
process.exit(0);