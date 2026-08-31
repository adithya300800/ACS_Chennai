// Pure timesheet row builder — no I/O, no exceljs, fully unit-testable.
//
// Given an Employee roster, attendance rows (with sessions) for a month, and
// approved LeaveRequest rows overlapping the month, produce a flat list of
// rows ready to be written to a sheet (one row per employee-day).
//
// Status resolution priority (Round-13 design decision):
//   1. APPROVED LeaveRequest covers the date  →  'Leave'
//   2. Attendance row has any session          →  'Present'
//   3. Attendance row exists, no session       →  'Absent'
//   4. Saturday / Sunday                       →  'Weekend'
//   5. Date > today (future in current month)  →  'Future'
//   6. Otherwise                               →  'Absent'  (past date, no record)
//
// Worked-hours computation uses SUM of closed-session durations, not
// (lastOut − firstIn). This avoids inflating hours when the employee took
// a long lunch break. Open sessions (no checkOut) render as '—'.

'use strict';

const MS_PER_HOUR = 1000 * 60 * 60;
const MS_PER_QUARTER_HOUR = MS_PER_HOUR / 4;

// Inclusive day count: how many days does [startDate, endDate] span?
// Used for the leave day-count and for the daysWorked summary stat.
function inclusiveDayCount(start, end) {
  const s = dayKey(start);
  const e = dayKey(end);
  if (!s || !e) return 0;
  const ms = e - s;
  return Math.round(ms / (1000 * 60 * 60 * 24)) + 1;
}

// Parse an ISO YYYY-MM-DD or Date into a local-midnight timestamp. Also
// accepts a numeric timestamp (passes it through). Returns null if invalid.
function dayKey(d) {
  if (d == null) return null;
  if (d instanceof Date) {
    if (Number.isNaN(d.getTime())) return null;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }
  if (typeof d === 'string') {
    // YYYY-MM-DD OR ISO with time — we only care about the calendar day in
    // the server's local TZ (Asia/Kolkata, set globally in index.js).
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  }
  if (typeof d === 'number') {
    if (!Number.isFinite(d)) return null;
    // Treat the number as a local-midnight timestamp — round it down to the
    // nearest day to avoid mid-day drift if a caller passes a Date.getTime()
    // with hour/minute components.
    const dt = new Date(d);
    if (Number.isNaN(dt.getTime())) return null;
    return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()).getTime();
  }
  return null;
}

// Format YYYY-MM-DD from a Date (local TZ). Used for the Date column.
function formatDateStr(d) {
  const t = dayKey(d);
  if (t == null) return '';
  const dt = new Date(t);
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Format HH:mm (24h, local TZ) from a Date for the time columns. Returns '—'
// when the source is missing.
function formatTimeStr(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '—';
  const hh = String(dt.getHours()).padStart(2, '0');
  const mm = String(dt.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

// Round to nearest 0.25h. Returns null if no sessions.
function sumSessionHours(sessions) {
  if (!Array.isArray(sessions) || sessions.length === 0) return null;
  let totalMs = 0;
  for (const s of sessions) {
    if (!s || !s.checkIn) continue;
    const start = new Date(s.checkIn).getTime();
    const end = s.checkOut ? new Date(s.checkOut).getTime() : NaN;
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      totalMs += end - start;
    }
  }
  if (totalMs <= 0) return null;
  const hours = totalMs / MS_PER_HOUR;
  // Round to nearest quarter-hour.
  return Math.round(hours / 0.25) * 0.25;
}

// Decide the status for a given (employee, date, attendanceRow, leaveMap).
// `today` is the local-midnight Date of "today" (for future-date detection).
// `leaveMap` maps dayKey(t) -> leave row when an APPROVED request covers it.
function resolveStatus({ dateMs, attendanceRow, leaveMap, todayMs }) {
  if (leaveMap && leaveMap[dateMs]) return 'Leave';
  const dow = new Date(dateMs).getDay(); // 0 = Sunday, 6 = Saturday
  // Future date check BEFORE weekend so a Saturday next week still shows as Future.
  if (todayMs != null && dateMs > todayMs) return 'Future';
  if (dow === 0 || dow === 6) {
    // Weekend, but if the employee worked (attendance row with sessions), it's
    // Present — they came in on a day off.
    if (attendanceRow && Array.isArray(attendanceRow.sessions) && attendanceRow.sessions.length > 0) {
      return 'Present';
    }
    return 'Weekend';
  }
  if (attendanceRow) {
    if (Array.isArray(attendanceRow.sessions) && attendanceRow.sessions.length > 0) return 'Present';
    return 'Absent';
  }
  return 'Absent';
}

// Build a leave-overlap map keyed by local-midnight day timestamp.
// Only APPROVED leaves overlay the timesheet (per design decision 4.17).
// Pending leaves render as Absent in the timesheet — visible to admin but
// not interfering with payroll until approved.
function buildLeaveMap(leaveRequests, opts) {
  const inclusive = opts && typeof opts.includeStatuses === 'object'
    ? new Set(opts.includeStatuses)
    : new Set(['APPROVED']);
  const map = Object.create(null);
  if (!Array.isArray(leaveRequests)) return map;
  for (const lr of leaveRequests) {
    if (!inclusive.has(lr.status)) continue;
    const startMs = dayKey(lr.startDate);
    const endMs = dayKey(lr.endDate);
    if (startMs == null || endMs == null || endMs < startMs) continue;
    for (let t = startMs; t <= endMs; t += 24 * 60 * 60 * 1000) {
      map[t] = lr; // Last write wins on overlap (shouldn't happen — overlap check at submit).
    }
  }
  return map;
}

// Build the per-day attendance map keyed by employeeId -> dayMs -> row.
function buildAttendanceMap(attendanceRows) {
  const map = Object.create(null);
  if (!Array.isArray(attendanceRows)) return map;
  for (const r of attendanceRows) {
    if (!r || !r.employeeId) continue;
    const dMs = dayKey(r.date);
    if (dMs == null) continue;
    if (!map[r.employeeId]) map[r.employeeId] = Object.create(null);
    map[r.employeeId][dMs] = r;
  }
  return map;
}

// Main builder. Returns { rows, summary }.
//   rows: array of { date, employeeId, employeeName, department, status,
//                     firstCheckIn, lastCheckOut, workedHours, sessionCount,
//                     leaveType, remarks }
//   summary: { employees, daysRendered, totalPresent, totalAbsent,
//              totalLeave, totalWeekend, totalFuture }
function buildTimesheetRows({ employees, attendanceRows, leaveRequests, month, today }) {
  if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) {
    throw new Error('buildTimesheetRows: month must be YYYY-MM');
  }
  const [year, m] = month.split('-').map(Number);
  const daysInMonth = new Date(year, m, 0).getDate(); // local TZ; handles 28/29/30/31.

  const todayMs = today ? dayKey(today) : dayKey(new Date());

  const attendanceMap = buildAttendanceMap(attendanceRows);
  const leaveMap = buildLeaveMap(leaveRequests, { includeStatuses: ['APPROVED'] });

  const rows = [];
  const summary = {
    employees: 0,
    daysRendered: 0,
    totalPresent: 0,
    totalAbsent: 0,
    totalLeave: 0,
    totalWeekend: 0,
    totalFuture: 0,
  };

  const safeEmployees = Array.isArray(employees) ? employees : [];
  summary.employees = safeEmployees.length;

  // Pre-build month-day timestamps (avoid Date churn in the loop).
  const monthDays = [];
  for (let day = 1; day <= daysInMonth; day++) {
    monthDays.push(new Date(year, m - 1, day).getTime());
  }

  for (const emp of safeEmployees) {
    if (!emp || !emp.id) continue;
    const empAtd = attendanceMap[emp.id] || {};
    for (const dateMs of monthDays) {
      const atd = empAtd[dateMs] || null;
      const leave = leaveMap[dateMs] || null;
      const status = resolveStatus({ dateMs, attendanceRow: atd, leaveMap: leave ? { [dateMs]: leave } : null, todayMs });

      let firstCheckIn = '—';
      let lastCheckOut = '—';
      let workedHours = '';
      let sessionCount = 0;
      let remarks = '';

      if (atd && Array.isArray(atd.sessions) && atd.sessions.length > 0) {
        sessionCount = atd.sessions.length;
        const sorted = [...atd.sessions].sort((a, b) =>
          new Date(a.checkIn).getTime() - new Date(b.checkIn).getTime());
        firstCheckIn = formatTimeStr(sorted[0].checkIn);
        const last = sorted[sorted.length - 1];
        lastCheckOut = formatTimeStr(last.checkOut);
        if (!last.checkOut) remarks = 'Open session';
        const h = sumSessionHours(sorted);
        workedHours = h == null ? '' : h.toFixed(2);
      } else if (atd && atd.status && atd.status !== 'Present') {
        remarks = atd.notes || '';
      }

      rows.push({
        date: formatDateStr(dateMs),
        employeeId: emp.id,
        employeeName: emp.name || '',
        department: emp.department || '',
        status,
        firstCheckIn,
        lastCheckOut,
        workedHours,
        sessionCount,
        leaveType: leave ? leave.leaveType : '',
        remarks,
      });

      summary.daysRendered += 1;
      if (status === 'Present') summary.totalPresent += 1;
      else if (status === 'Absent') summary.totalAbsent += 1;
      else if (status === 'Leave') summary.totalLeave += 1;
      else if (status === 'Weekend') summary.totalWeekend += 1;
      else if (status === 'Future') summary.totalFuture += 1;
    }
  }

  return { rows, summary };
}

// Header row + column widths for the timesheet sheet.
const TIMESHEET_COLUMNS = [
  { header: 'Date',             key: 'date',          width: 12 },
  { header: 'Employee ID',      key: 'employeeId',    width: 14 },
  { header: 'Employee Name',    key: 'employeeName',  width: 28 },
  { header: 'Department',       key: 'department',    width: 22 },
  { header: 'Status',           key: 'status',        width: 10 },
  { header: 'First Check-In',   key: 'firstCheckIn',  width: 14 },
  { header: 'Last Check-Out',   key: 'lastCheckOut',  width: 14 },
  { header: 'Worked Hours',     key: 'workedHours',    width: 13 },
  { header: 'Sessions',         key: 'sessionCount',  width: 9  },
  { header: 'Leave Type',       key: 'leaveType',     width: 12 },
  { header: 'Remarks',          key: 'remarks',       width: 30 },
];

module.exports = {
  buildTimesheetRows,
  TIMESHEET_COLUMNS,
  // Exported for unit tests.
  resolveStatus,
  buildLeaveMap,
  buildAttendanceMap,
  sumSessionHours,
  inclusiveDayCount,
  dayKey,
  formatDateStr,
  formatTimeStr,
};
