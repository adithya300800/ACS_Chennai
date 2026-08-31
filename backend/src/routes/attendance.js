const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { buildTimesheetRows } = require('../lib/timesheet');
const { pickWriter } = require('../lib/excelWriter');
const { hashIdentifier } = require('../lib/pii');

// Helper: Get local start and end of a month (YYYY-MM format) for the
// configured timezone (Asia/Kolkata; set in src/index.js). Returns the
// full month inclusive of the last day's last millisecond.
function getMonthRange(yearMonth) {
  const [year, month] = yearMonth.split('-').map(Number);
  // Local-time constructors — `Date.UTC(...)` would compute a UTC boundary
  // and miss / double-count days for users east of UTC. Once TZ=Asia/Kolkata
  // is set in src/index.js, "local midnight" IS IST midnight.
  const startDate = new Date(year, month - 1, 1, 0, 0, 0, 0);
  // Last day of (year, month) at 23:59:59.999 local — `new Date(y, m, 0)`
  // is the last day of the previous index, so passing the input month
  // (1-indexed in the query string) gives the last day of the queried
  // month, which is what `lte` needs to be inclusive.
  const endDate = new Date(year, month, 0, 23, 59, 59, 999);
  return { startDate, endDate };
}

// Helper: Parse YYYY-MM-DD string to local midnight for storage.
// Once TZ=Asia/Kolkata is set in src/index.js, "local midnight" IS
// IST midnight — matching the calendar day the user clicked.
function parseLocalDate(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day);
}

// Helper: Get date string YYYY-MM-DD from a Date object. Uses the server's
// LOCAL timezone (which is Asia/Kolkata after src/index.js boots with
// `process.env.TZ = 'Asia/Kolkata'`). Prisma reads `@db.Date` columns as
// midnight-local JS Dates, so `getDate/getMonth/getFullYear` on a freshly
// read row always returns the calendar day the user clicked — provided the
// server's local TZ matches the user's calendar TZ (true for an Indian
// workforce).
function toLocalDateString(date) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Helper: compute the attendance "day bucket" for a given instant, in the
// user's own timezone (IANA name from `Intl.DateTimeFormat().resolvedOptions
// .timeZone`). Falls back to the server's local TZ (Asia/Kolkata) when no
// clientTimezone is supplied — preserves backward compat with old frontends
// and with the existing IST workforce.
//
// Rationale (round-14): the previous code used `new Date(instant).getDate()`,
// which is the SERVER's local calendar day. For an Indian user that matches
// the user's calendar, but for a PST user the bucket can be off by ±1 day.
// Round-14 lets the client send its IANA timezone so we extract the
// calendar day in the user's frame instead.
//
// No data migration: existing rows retain their (potentially off-by-one) date
// values. Only NEW check-ins go through this path. The recorded `checkIn`
// instant (UTC) is unchanged either way — the fix is purely about which
// calendar day the row is bucketed into.
function computeLocalDate(instant, ianaTz) {
  if (typeof ianaTz === 'string' && ianaTz.length > 0 && ianaTz.length < 64) {
    try {
      // en-CA yields YYYY-MM-DD ordered parts.
      const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: ianaTz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
      const parts = fmt.formatToParts(instant);
      const y = parts.find((p) => p.type === 'year').value;
      const m = parts.find((p) => p.type === 'month').value;
      const d = parts.find((p) => p.type === 'day').value;
      // Build a Date that Prisma's @db.Date will store as this calendar day
      // regardless of the server's TZ. Using UTC midnight keeps the column
      // value stable across deploys / TZ changes.
      const utc = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
      if (!Number.isNaN(utc.getTime())) return utc;
    } catch (_e) {
      // Invalid IANA name (or Node Intl missing the tz database) — fall
      // through to the server-local computation.
    }
  }
  return new Date(instant.getFullYear(), instant.getMonth(), instant.getDate());
}

// Helper: Get today's date in the server's local timezone for the
// attendance-record day bucket. With TZ=Asia/Kolkata set in src/index.js,
// this returns IST midnight today — matching the user's calendar.
function getTodayLocalDate() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

// All routes require auth
router.use(requireAuth);

// GET /api/attendance?month=YYYY-MM
router.get('/', async (req, res) => {
  const prisma = req.app.get('prisma');
  const { month } = req.query;

  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'month query param required (YYYY-MM)' });
  }

  try {
    const { startDate, endDate } = getMonthRange(month);

    const records = await prisma.attendance.findMany({
      where: {
        employeeId: req.employeeId,
        date: {
          gte: startDate,
          lte: endDate,
        },
      },
      include: { sessions: { orderBy: { checkIn: 'asc' } } },
      orderBy: { date: 'asc' },
    });

    // Transform dates to local timezone strings for frontend
    const transformed = records.map(r => ({
      ...r,
      date: toLocalDateString(r.date),
      sessions: r.sessions.map(s => ({
        ...s,
        checkIn: s.checkIn ? s.checkIn.toISOString() : null,
        checkOut: s.checkOut ? s.checkOut.toISOString() : null,
      })),
    }));

    res.json(transformed);
  } catch (err) {
    console.error('Attendance list error:', err);
    res.status(500).json({ error: 'Failed to fetch attendance' });
  }
});

// GET /api/attendance/today?localDate=YYYY-MM-DD
router.get('/today', async (req, res) => {
  const prisma = req.app.get('prisma');
  const { localDate } = req.query;

  // Use frontend-provided local date if available, otherwise fall back to server UTC date
  let attendanceDate;
  if (localDate && /^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
    const [year, month, day] = localDate.split('-').map(Number);
    // Local constructor — once TZ=Asia/Kolkata is set in src/index.js,
    // this becomes IST midnight of the day the frontend sent (the user's
    // browser-local day, also IST).
    attendanceDate = new Date(year, month - 1, day);
  } else {
    attendanceDate = getTodayLocalDate();
  }

  try {
    const record = await prisma.attendance.findFirst({
      where: {
        employeeId: req.employeeId,
        date: attendanceDate,
      },
      include: { sessions: { orderBy: { checkIn: 'asc' } } },
    });

    if (!record) {
      return res.json(null);
    }

    // Transform dates to local timezone strings
    const transformed = {
      ...record,
      date: toLocalDateString(record.date),
      sessions: record.sessions.map(s => ({
        ...s,
        checkIn: s.checkIn ? s.checkIn.toISOString() : null,
        checkOut: s.checkOut ? s.checkOut.toISOString() : null,
      })),
    };

    res.json(transformed);
  } catch (err) {
    console.error('Today attendance error:', err);
    res.status(500).json({ error: 'Failed to fetch today attendance' });
  }
});

// GET /api/attendance/status
// P3: lightweight status ping (auth-required). Returns the current session status
// (none / active / already-checked-out) without creating or modifying anything.
// Express auto-handles HEAD on the same path (headers only).
router.get('/status', async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    const attendanceDate = getTodayLocalDate();
    const record = await prisma.attendance.findFirst({
      where: { employeeId: req.employeeId, date: attendanceDate },
      include: { sessions: { orderBy: { checkIn: 'asc' } } },
    });

    if (!record) {
      return res.json({ status: 'none', activeSession: null, attendanceId: null });
    }

    const activeSession = record.sessions.find(s => !s.checkOut) || null;
    const status = activeSession
      ? 'active'
      : (record.sessions.length > 0 ? 'already-checked-out' : 'none');

    res.json({
      status,
      activeSession: activeSession
        ? { id: activeSession.id, checkIn: activeSession.checkIn.toISOString() }
        : null,
      attendanceId: record.id,
    });
  } catch (err) {
    console.error('Attendance status error:', err);
    res.status(500).json({ error: 'Failed to fetch attendance status' });
  }
});

// POST /api/attendance/check-in
// P0#6: Atomic find-or-create for the Attendance record. Two concurrent
// check-ins both pass findFirst(); instead, try create() and on P2002 (unique
// violation on @@unique([employeeId, date])) look up the row another winner
// inserted. This eliminates the race-window 500.
// P0#4: Drop the (0,0) hard-rejection. Allow (0,0) as valid coordinates; if
// the client also provides no address, reject as 'Location required' (soft).
// P2: Server time (UTC) is ALWAYS the source of truth for checkIn. The client
// localDateTime is validated for drift (to detect clock-skew / abuse) and
// echoed back in the response as `claimedLocalDateTime` for UI display, but
// never persisted as the check-in timestamp.
router.post('/check-in', async (req, res) => {
  const prisma = req.app.get('prisma');
  const { latitude, longitude, address, localDateTime, clientTimezone } = req.body;

  if (latitude === undefined || latitude === null || longitude === undefined || longitude === null) {
    return res.status(400).json({ error: 'latitude and longitude are required' });
  }

  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: 'Coordinates must be numeric' });
  }
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return res.status(400).json({ error: 'Coordinates out of range' });
  }
  // P0#4: (0,0) is now valid. Reject only if the client also failed to send
  // an address — i.e. truly no location signal.
  const addressText = typeof address === 'string' ? address.trim() : '';
  if (lat === 0 && lng === 0 && addressText === '') {
    return res.status(400).json({ error: 'Location required' });
  }

  // P2: Validate client-supplied localDateTime drift, but never trust it as
  // the source of truth. The server clock wins; the client value is for UI.
  let claimedLocalDateTime = null;
  if (localDateTime) {
    const ts = new Date(localDateTime);
    if (Number.isNaN(ts.getTime())) {
      return res.status(400).json({ error: 'Invalid localDateTime format' });
    }
    const driftMs = Math.abs(ts.getTime() - Date.now());
    if (driftMs > 15 * 60 * 1000) {
      return res.status(400).json({ error: 'Check-in timestamp drift too large (max 15 minutes)' });
    }
    claimedLocalDateTime = ts.toISOString();
  }

  // P2 (revised): the EFFECTIVE click time is the client-claimed instant
  // if it passes the drift check above; otherwise the server wall clock.
  // The bucket for the Attendance row uses the same effective time. Round-14:
  // the date is computed in the USER's local timezone (clientTimezone) when
  // provided, falling back to the server's local TZ (Asia/Kolkata) for IST
  // workforce backward compat. This collapses the previous off-by-one bug
  // where a check-in at 23:00 PST landed in the next IST day.
  const checkInTime = claimedLocalDateTime ? new Date(claimedLocalDateTime) : new Date();
  const attendanceDate = computeLocalDate(checkInTime, clientTimezone);

  try {
    // P0#6: atomic find-or-create via try-create + P2002 catch.
    let attendance;
    try {
      attendance = await prisma.attendance.create({
        data: {
          employeeId: req.employeeId,
          date: attendanceDate,
          status: 'Present',
        },
      });
    } catch (createErr) {
      // P2002 = unique violation on (employeeId, date). A concurrent request
      // won the race; look up the row it created and reuse it.
      if (createErr && createErr.code === 'P2002') {
        attendance = await prisma.attendance.findFirst({
          where: { employeeId: req.employeeId, date: attendanceDate },
        });
        if (!attendance) {
          // Extremely unlikely (delete-between-create-and-find); bubble up.
          throw createErr;
        }
      } else {
        throw createErr;
      }
    }

    // Create the new session with server time (P2 source-of-truth).
    const session = await prisma.attendanceSession.create({
      data: {
        attendanceId: attendance.id,
        checkIn: checkInTime,
        checkInLat: latitude,
        checkInLng: longitude,
        checkInAddr: addressText || null,
      },
    });

    // Return full attendance with all sessions
    const fullAttendance = await prisma.attendance.findUnique({
      where: { id: attendance.id },
      include: { sessions: { orderBy: { checkIn: 'asc' } } },
    });

    // Transform for frontend
    const transformed = {
      ...fullAttendance,
      date: toLocalDateString(fullAttendance.date),
      sessions: fullAttendance.sessions.map(s => ({
        ...s,
        checkIn: s.checkIn ? s.checkIn.toISOString() : null,
        checkOut: s.checkOut ? s.checkOut.toISOString() : null,
      })),
      // P2: client-claimed local datetime, for UI display only.
      claimedLocalDateTime,
    };

    res.status(201).json(transformed);
  } catch (err) {
    console.error('Check-in error:', err);
    res.status(500).json({ error: 'Check-in failed' });
  }
});

// PUT /api/attendance/check-out/:sessionId
// P0#7: TOCTOU-safe check-out via updateMany() with a checkOut:null guard.
// The previous design did findUnique() (read checkOut), decided it was null,
// then called unconditional update(). Two concurrent check-outs could both
// pass the null check; the second silently overwrote the first's checkOut
// timestamp. updateMany() translates the guard into a single SQL UPDATE
// WHERE check_out IS NULL — atomic at the DB layer.
// P0#4: same (0,0) softening as check-in.
router.put('/check-out/:sessionId', async (req, res) => {
  const prisma = req.app.get('prisma');
  const { sessionId } = req.params;
  const { latitude, longitude, address } = req.body;

  if (latitude === undefined || latitude === null || longitude === undefined || longitude === null) {
    return res.status(400).json({ error: 'latitude and longitude are required' });
  }

  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: 'Coordinates must be numeric' });
  }
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return res.status(400).json({ error: 'Coordinates out of range' });
  }
  // P0#4: soft (0,0) check — only reject if also no address.
  const addressText = typeof address === 'string' ? address.trim() : '';
  if (lat === 0 && lng === 0 && addressText === '') {
    return res.status(400).json({ error: 'Location required' });
  }

  try {
    // Auth / ownership check (non-race read — these don't change).
    const existing = await prisma.attendanceSession.findUnique({
      where: { id: sessionId },
      include: { attendance: { select: { employeeId: true } } },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (existing.attendance.employeeId !== req.employeeId) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    // P0#7: atomic guard via updateMany(). Returns { count }.
    // SQL: UPDATE attendance_sessions SET check_out=$now, ... WHERE id=$id AND check_out IS NULL
    const checkOutTime = new Date();
    const updateResult = await prisma.attendanceSession.updateMany({
      where: {
        id: sessionId,
        checkOut: null,
      },
      data: {
        checkOut: checkOutTime,
        checkOutLat: latitude,
        checkOutLng: longitude,
        checkOutAddr: addressText || null,
      },
    });

    if (updateResult.count === 0) {
      // Another request already checked out this session between our auth
      // read and this update. Surface a clear 409 to the client.
      return res.status(409).json({ error: 'Already checked out' });
    }

    // Re-read with relations for the response payload.
    const updated = await prisma.attendanceSession.findUnique({
      where: { id: sessionId },
      include: { attendance: { include: { sessions: { orderBy: { checkIn: 'asc' } } } } },
    });

    // Transform for frontend
    const transformed = {
      ...updated,
      checkIn: updated.checkIn ? updated.checkIn.toISOString() : null,
      checkOut: updated.checkOut ? updated.checkOut.toISOString() : null,
      attendance: {
        ...updated.attendance,
        date: toLocalDateString(updated.attendance.date),
        sessions: updated.attendance.sessions.map(s => ({
          ...s,
          checkIn: s.checkIn ? s.checkIn.toISOString() : null,
          checkOut: s.checkOut ? s.checkOut.toISOString() : null,
        })),
      },
    };

    res.json(transformed);
  } catch (err) {
    console.error('Check-out error:', err);
    res.status(500).json({ error: 'Check-out failed' });
  }
});

// GET /api/attendance/all - Admin only: get all employees attendance
router.get('/all', async (req, res) => {
  const prisma = req.app.get('prisma');
  const { month } = req.query;

  // Check if admin
  const employee = await prisma.employee.findUnique({ where: { id: req.employeeId } });
  if (!employee || !employee.isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'month query param required (YYYY-MM)' });
  }

  try {
    const { startDate, endDate } = getMonthRange(month);

    const records = await prisma.attendance.findMany({
      where: {
        date: { gte: startDate, lte: endDate },
      },
      include: {
        employee: { select: { id: true, name: true, email: true, department: true } },
        sessions: { orderBy: { checkIn: 'asc' } },
      },
      orderBy: [{ date: 'asc' }, { employee: { name: 'asc' } }],
    });

    // Transform dates for frontend
    const transformed = records.map(r => ({
      ...r,
      date: toLocalDateString(r.date),
      sessions: r.sessions.map(s => ({
        ...s,
        checkIn: s.checkIn ? s.checkIn.toISOString() : null,
        checkOut: s.checkOut ? s.checkOut.toISOString() : null,
      })),
    }));

    res.json(transformed);
  } catch (err) {
    console.error('Admin attendance error:', err);
    res.status(500).json({ error: 'Failed to fetch attendance' });
  }
});

// Round-13: GET /api/attendance/export?month=YYYY-MM[&employeeId=...]
// Admin-only. Streams an XLSX (or CSV fallback) of the attendance month.
// Memory-flat via WorkbookWriter; gracefully falls back to CSV if the
// exceljs native shim is missing. Overlaps APPROVED LeaveRequest rows on
// top of attendance so 'L' cells render in the spreadsheet.
//
// IMPORTANT: this route writes the response body itself. Do not call
// res.status(200).json() here — only set headers, then stream.
router.get('/export', async (req, res) => {
  const prisma = req.app.get('prisma');
  const { month, employeeId } = req.query;

  // Admin gate — use the JWT claim first (cheap), confirm with a fresh
  // DB read so a recently-granted admin role is honored without waiting
  // for the 24h access-token window to expire.
  if (!req.isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const employee = await prisma.employee.findUnique({ where: { id: req.employeeId }, select: { isAdmin: true } });
  if (!employee || !employee.isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'month query param required (YYYY-MM)' });
  }

  // Reject months outside a sane range — defends against DOS via "year 0001"
  // queries that explode the row iteration. Lower bound matches when the
  // org started using this system; upper bound caps future-dated abuse.
  const [yearStr, monthStr] = month.split('-');
  const year = Number(yearStr);
  const monthNum = Number(monthStr);
  if (!Number.isInteger(year) || !Number.isInteger(monthNum) || monthNum < 1 || monthNum > 12) {
    return res.status(400).json({ error: 'INVALID_MONTH', message: 'month must be YYYY-MM with 01 ≤ MM ≤ 12' });
  }
  if (year < 2024 || year > 2100) {
    return res.status(400).json({ error: 'OUT_OF_RANGE', message: 'month year out of supported range' });
  }

  try {
    const { startDate, endDate } = getMonthRange(month);

    // Filter to one employee if requested. Otherwise include everyone —
    // admins and non-admins both go in the timesheet.
    const employeeWhere = employeeId ? { id: String(employeeId) } : {};

    const employees = await prisma.employee.findMany({
      where: employeeWhere,
      select: { id: true, name: true, email: true, department: true },
      orderBy: { name: 'asc' },
    });

    if (employees.length === 0) {
      return res.status(404).json({ error: 'NO_EMPLOYEES', message: 'No employees match the filter' });
    }

    const attendanceRows = await prisma.attendance.findMany({
      where: {
        date: { gte: startDate, lte: endDate },
        employeeId: { in: employees.map((e) => e.id) },
      },
      include: { sessions: { orderBy: { checkIn: 'asc' } } },
    });

    // Pull APPROVED leave that overlaps the month. Overlap SQL:
    //   startDate <= month-end AND endDate >= month-start
    const leaveRows = await prisma.leaveRequest.findMany({
      where: {
        status: 'APPROVED',
        employeeId: { in: employees.map((e) => e.id) },
        startDate: { lte: endDate },
        endDate: { gte: startDate },
      },
      select: { id: true, employeeId: true, startDate: true, endDate: true, leaveType: true, status: true },
    });

    const { rows, summary } = buildTimesheetRows({
      employees,
      attendanceRows,
      leaveRequests: leaveRows,
      month,
      today: new Date(),
    });

    // Pick writer BEFORE calling it — we want to log the format chosen.
    const writer = pickWriter();

    console.log('[attendance/export]', {
      requester: hashIdentifier(req.employeeId),
      month,
      employeeId: employeeId || 'ALL',
      format: writer.format,
      rows: rows.length,
    });

    // Body is streamed from here on. Errors past this point can only
    // truncate the response (browser sees a partial download). Wrap in
    // try/catch to set a trailer header if streaming hasn't begun.
    try {
      await writer.write(res, { rows, summary, month });
    } catch (writeErr) {
      console.error('[attendance/export] writer error:', writeErr.message?.split('\n')[0]);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Export failed' });
      } else {
        res.end();
      }
    }
  } catch (err) {
    console.error('Attendance export error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to build export' });
    } else {
      res.end();
    }
  }
});

module.exports = router;