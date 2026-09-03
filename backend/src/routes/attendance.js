const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { buildTimesheetRows, TIMESHEET_COLUMNS } = require('../lib/timesheet');
const { pickWriter } = require('../lib/excelWriter');
const { hashIdentifier } = require('../lib/pii');
const {
  parseDateOnlyToUtc,
  getTodayBusinessDate,
  getMonthRangeUtc,
  formatDateOnly,
  InvalidMonthRangeError,
} = require('../lib/dateOnly');

// Helper: compute the attendance "day bucket" for a given instant.
//
// Round-20 (post-DR-024): the previous implementation accepted a
// client-supplied IANA timezone and ran it through Intl.DateTimeFormat
// with a try/catch. That worked, but it was a per-request Intl call,
// added a 400 INVALID_TIMEZONE failure mode, and let a non-IST user
// bucket a check-in into a different calendar day — fine in theory,
// confusing in practice for a workforce that is uniformly in IST.
//
// The company is based in India. Every employee works in IST. The
// user confirmed that even when they (PST) check the portal, they're
// happy to see IST-day records — there is no per-user day boundary
// to negotiate. So we collapsed the two paths (IANA-aware + IST
// fallback) into ONE: always bucket by Asia/Kolkata. The `ianaTz`
// parameter is preserved for backward compat with the existing
// frontend (which still sends `clientTimezone`) but ignored.
//
// DR-023 contract: the returned Date is ALWAYS UTC midnight of the
// resolved calendar day. That encoding is what the canonical helper
// `getTodayBusinessDate` produces, and what the Prisma `@db.Date`
// round-trip expects. An IST 00:30 check-in (`2026-09-01T19:00:00Z`
// UTC) is now bucketed under `2026-09-02`, not the previous
// `2026-09-01` UTC date.
//
// DR-024 is structurally impossible in this single-TZ model: there is
// no client-controlled timezone to validate, so the trust-boundary
// bug ("client picks the authoritative day") cannot exist.
function computeLocalDate(instant, _ianaTz) {
  // _ianaTz is intentionally ignored. The frontend still sends
  // clientTimezone; accepting and ignoring it preserves the wire
  // shape. A future refactor can drop the field if desired.
  return getTodayBusinessDate(instant, 'Asia/Kolkata');
}

// All routes require auth
router.use(requireAuth);

// DR-030: routes that take a `month` query param route the canonical
// helper's shape error into the same 400 INVALID_MONTH contract the
// /export endpoint already publishes. The regex pre-check above each
// call site already rejects bad shapes early — this is a belt-and-braces
// net for any future caller that forgets to pre-validate. The helper
// returns null and writes the 400 itself when it sees
// InvalidMonthRangeError; non-shape errors (DB, etc.) re-throw.
function monthRangeOrBadRequest(req, res, month) {
  try {
    return getMonthRangeUtc(month);
  } catch (err) {
    if (err instanceof InvalidMonthRangeError) {
      res.status(400).json({
        error: 'INVALID_MONTH',
        message: 'month must be YYYY-MM with 01 ≤ MM ≤ 12',
      });
      return null;
    }
    throw err;
  }
}

// GET /api/attendance?month=YYYY-MM
router.get('/', async (req, res) => {
  const prisma = req.app.get('prisma');
  const { month } = req.query;

  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'month query param required (YYYY-MM)' });
  }

  // DR-030: getMonthRangeUtc now validates month/year strictly and
  // throws InvalidMonthRangeError on out-of-range input. The helper
  // translates that to a 400 INVALID_MONTH so the caller never sees
  // a silent month-roll (e.g. "2026-13" → 2027-02-01).
  const range = monthRangeOrBadRequest(req, res, month);
  if (!range) return; // 400 already written

  try {
    const { startDate, endDate } = range;

    const records = await prisma.attendance.findMany({
      where: {
        employeeId: req.employeeId,
        date: {
          gte: startDate,
          lt: endDate,
        },
      },
      include: { sessions: { orderBy: { checkIn: 'asc' } } },
      orderBy: { date: 'asc' },
    });

    // Transform dates to YYYY-MM-DD strings (UTC components) for frontend
    const transformed = records.map(r => ({
      ...r,
      date: formatDateOnly(r.date),
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

  // Resolve the bucket: use frontend-supplied YYYY-MM-DD if it parses,
  // otherwise fall back to today in the business TZ (Asia/Kolkata).
  // DR-023: both paths return UTC midnight so the lookup key matches
  // what check-in writes (the previous local-midnight path was the
  // IST off-by-one bug).
  let attendanceDate;
  if (localDate && /^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
    try {
      attendanceDate = parseDateOnlyToUtc(String(localDate));
    } catch (_e) {
      // Malformed date-only string from the client — fall back to today
      // rather than 500ing. The frontend already gates this shape.
      attendanceDate = getTodayBusinessDate();
    }
  } else {
    attendanceDate = getTodayBusinessDate();
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

    // Transform dates to YYYY-MM-DD strings (UTC components)
    const transformed = {
      ...record,
      date: formatDateOnly(record.date),
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

// GET /api/attendance/status?localDate=YYYY-MM-DD
// P3: lightweight status ping (auth-required). Returns the current session status
// (none / active / already-checked-out) without creating or modifying anything.
// Express auto-handles HEAD on the same path (headers only).
//
// DR-023: accepts an optional `localDate` so the client can ask for a
// specific calendar day (e.g. after a midnight rollover when the tab
// regains focus). Defaults to today in the business TZ. All paths
// produce UTC midnight so the lookup key matches /today and /check-in.
//
// DR-025: `record.sessions.find(s => !s.checkOut) || null` reads "the
// session without a checkOut" — correct under the round-13 single-active-
// session invariant, but a stale 0-checkOut session from a half-written
// row could be reported here. DR-025 will tighten this with a DB-side
// guard; for DR-023 we only fix the date key, not the session invariant.
router.get('/status', async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    let attendanceDate;
    const { localDate } = req.query;
    if (localDate && /^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
      try {
        attendanceDate = parseDateOnlyToUtc(String(localDate));
      } catch (_e) {
        attendanceDate = getTodayBusinessDate();
      }
    } else {
      attendanceDate = getTodayBusinessDate();
    }
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
//
// DR-024 (round-20, simplified): the previous round-20 design tightened
// the trust boundary around `clientTimezone` by validating it against the
// ICU database and rejecting unknown strings as 400 INVALID_TIMEZONE.
// That was correct but heavy — a per-request Intl call, plus a second
// code path through the IANA-aware bucket resolver. The company is
// based in India and every employee works in IST, so the user
// confirmed the IANA-aware path is unnecessary: even when viewing the
// portal from PST, IST-day records are what they want to see. Both
// paths collapsed into ONE: computeLocalDate always buckets by
// Asia/Kolkata; the clientTimezone field is accepted on the wire but
// ignored. The DR-024 trust-boundary bug is structurally impossible
// because there is no client-controlled timezone to validate.
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

  // DR-024 (round-20, simplified): the previous code validated
  // clientTimezone against the IANA database and used it for day-bucket
  // computation. Round-20 collapsed the two-path design (IANA-aware +
  // IST fallback) into ONE: always bucket by Asia/Kolkata. The
  // clientTimezone field is accepted (still on the wire from the
  // frontend) but IGNORED — there is no longer a 400 INVALID_TIMEZONE
  // failure mode. The DR-024 trust-boundary bug ("client picks the
  // authoritative day") is structurally impossible.

  // P2 (DR-024 revised): server wall clock is the SOLE source of truth
  // for checkIn. The client `localDateTime` is validated for drift (to
  // detect clock-skew / abuse) and echoed back in the response as
  // `claimedLocalDateTime` for UI display, but NEVER used to compute
  // the persisted check-in instant. The previous implementation let a
  // client that passed the 15-min drift check overwrite the timestamp
  // — that's the abuse vector the audit caught.
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

  // DR-024: server wall clock is the source of truth, ALWAYS.
  const checkInTime = new Date();
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

    // DR-025 (round-20): one open session per attendance row. The
    // partial unique index at
    //   prisma/migrations/20260902230000_dr025_one_open_attendance_session/
    // enforces this at the DB layer (Postgres raises P2002 on a second
    // open session); the application-level precheck below provides the
    // clean 409 ALREADY_CHECKED_IN message instead of a raw constraint
    // violation. Race-safety: the findFirst + create run inside one
    // $transaction, and the Attendance row's row-level lock (taken by
    // the SELECT FOR UPDATE on the attendance id we just fetched)
    // serializes concurrent check-ins for the same (employee, day).
    // Different employees don't block each other.
    let session;
    try {
      session = await prisma.$transaction(async (tx) => {
        // SELECT … FOR UPDATE on the Attendance row serializes any
        // concurrent /check-in for the same (employee, day).
        const locked = await tx.$queryRaw`
          SELECT id FROM "attendance" WHERE id = ${attendance.id} FOR UPDATE
        `;
        if (!locked || locked.length === 0) {
          // The row vanished between the create/findFirst and the lock
          // — extremely unlikely. Surface as a 500 by throwing.
          throw new Error('Attendance row not found at lock time');
        }

        const open = await tx.attendanceSession.findFirst({
          where: { attendanceId: attendance.id, checkOut: null },
        });
        if (open) {
          // The constraint + precheck both fire here. Throw a typed
          // error so the outer catch can map it to 409 ALREADY_CHECKED_IN.
          const e = new Error('Employee is already checked in for this day');
          e.code = 'ALREADY_CHECKED_IN';
          e.openSession = open;
          throw e;
        }

        return await tx.attendanceSession.create({
          data: {
            attendanceId: attendance.id,
            checkIn: checkInTime,
            checkInLat: latitude,
            checkInLng: longitude,
            checkInAddr: addressText || null,
          },
        });
      });
    } catch (txErr) {
      if (txErr && txErr.code === 'ALREADY_CHECKED_IN') {
        return res.status(409).json({
          error: 'Employee is already checked in for this day',
          code: 'ALREADY_CHECKED_IN',
          activeSession: txErr.openSession ? {
            id: txErr.openSession.id,
            checkIn: txErr.openSession.checkIn.toISOString(),
            checkInLat: txErr.openSession.checkInLat,
            checkInLng: txErr.openSession.checkInLng,
            checkInAddr: txErr.openSession.checkInAddr,
          } : null,
        });
      }
      throw txErr;
    }

    // Return full attendance with all sessions
    const fullAttendance = await prisma.attendance.findUnique({
      where: { id: attendance.id },
      include: { sessions: { orderBy: { checkIn: 'asc' } } },
    });

    // Transform for frontend
    const transformed = {
      ...fullAttendance,
      date: formatDateOnly(fullAttendance.date),
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
        date: formatDateOnly(updated.attendance.date),
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

  // DR-030: see /attendance — same belt-and-braces for /all so a typo
  // never returns data for a silently-rolled month.
  const range = monthRangeOrBadRequest(req, res, month);
  if (!range) return;

  try {
    const { startDate, endDate } = range;

    const records = await prisma.attendance.findMany({
      where: {
        date: { gte: startDate, lt: endDate },
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
      date: formatDateOnly(r.date),
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
    // DR-030: getMonthRangeUtc now validates strictly. The earlier
    // pre-checks above already reject non-canonical inputs with 400;
    // a failure here would mean the pre-check missed something, and
    // a 500 is the right escape.
    const { startDate, endDate } = getMonthRangeUtc(month);

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
        // DR-023: half-open interval — `lt endDate` (first day of next
        // month) keeps the last day of the queried month inclusive
        // without a +1-ms hack that depends on server TZ.
        date: { gte: startDate, lt: endDate },
        employeeId: { in: employees.map((e) => e.id) },
      },
      include: { sessions: { orderBy: { checkIn: 'asc' } } },
    });

    // Pull APPROVED leave that overlaps the month. Same half-open
    // semantics on the @db.Date columns — `lt endDate` matches a leave
    // whose startDate is the last day of the queried month.
    const leaveRows = await prisma.leaveRequest.findMany({
      where: {
        status: 'APPROVED',
        employeeId: { in: employees.map((e) => e.id) },
        startDate: { lt: endDate },
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
    const extension = writer.format === 'xlsx' ? 'xlsx' : 'csv';

    // Include employee name in the filename when the export is scoped to a
    // single employee. safeFilename() in excelWriter.js will sanitize it.
    const filename = (employeeId && employees.length === 1)
      ? `${employees[0].name}-timesheet-${month}.${extension}`
      : `timesheet-${month}.${extension}`;

    console.log('[attendance/export]', {
      requester: hashIdentifier(req.employeeId),
      month,
      employeeId: employeeId || 'ALL',
      format: writer.format,
      rows: rows.length,
      filename,
    });

    // Body is streamed from here on. Errors past this point can only
    // truncate the response (browser sees a partial download). Wrap in
    // try/catch to set a trailer header if streaming hasn't begun.
    try {
      await writer.write(res, {
        columns: TIMESHEET_COLUMNS,
        rows,
        sheetName: 'Timesheet',
        filename,
      });
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