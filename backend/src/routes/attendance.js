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
// DR-023: the returned Date is now ALWAYS UTC midnight of the resolved
// calendar day, regardless of whether the IANA path or the fallback path
// ran. This is the contract the canonical helper in lib/dateOnly.js
// guarantees and is the fix for the IST off-by-one (00:30 IST check-ins
// were being bucketed under the previous UTC date).
//
// DR-024 (round-20): the IANA name was previously TRUSTED from the
// client. A malicious or buggy client could send any string — including
// a syntactically valid IANA name like "Pacific/Kiritimati" (UTC+14)
// that shifts the bucket by a day — and silently shift which Attendance
// row the check-in lands in. The check-in handler now validates the
// clientTimezone against the runtime IANA database BEFORE using it
// (rejects unknown strings as 400 INVALID_TIMEZONE), and falls back to
// the server-configured business TZ (IST) on any validation failure.
// The IANA path still exists for non-IST users, but the trust boundary
// is now closed.
//
// No data migration: existing rows retain their (potentially off-by-one)
// date values. Only NEW check-ins go through this path. The recorded
// `checkIn` instant (UTC) is unchanged either way — the fix is purely
// about which calendar day the row is bucketed into.
function computeLocalDate(instant, ianaTz) {
  if (typeof ianaTz === 'string' && ianaTz.length > 0 && ianaTz.length < 64) {
    if (isValidIanaTimezone(ianaTz)) {
      try {
        // en-CA yields YYYY-MM-DD ordered parts.
        const fmt = new Intl.DateTimeFormat('en-CA', {
          timeZone: ianaTz,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        });
        const parts = fmt.formatToParts(instant);
        const y = Number(parts.find((p) => p.type === 'year').value);
        const m = Number(parts.find((p) => p.type === 'month').value);
        const d = Number(parts.find((p) => p.type === 'day').value);
        // DR-023: UTC midnight of the resolved calendar day — same encoding
        // the helper layer guarantees everywhere else in this module.
        const utc = new Date(Date.UTC(y, m - 1, d));
        if (!Number.isNaN(utc.getTime())) return utc;
      } catch (_e) {
        // IANA name was structurally valid but Intl rejected it at format
        // time (rare — happens with leap-second edge cases or stripped
        // ICU data). Fall through to the server-local computation.
      }
    }
    // Unknown / invalid IANA name — silently fall back to IST. The
    // caller's request handler has already validated this if it needs
    // to 400; this helper is also used by /today where the silent
    // fallback is the right behavior (no IANA from the client).
  }
  // Fallback: derive today in the server's configured business TZ (IST)
  // and return its UTC midnight. DR-023 changes this from
  // `new Date(y, m, d)` (local midnight) to the canonical helper so the
  // bucket encoding matches the IANA path above.
  return getTodayBusinessDate(instant);
}

// DR-024: validate a client-supplied IANA timezone string against the
// runtime ICU/Intl database. Accepts the canonical IANA names (e.g.
// "Asia/Kolkata", "America/Los_Angeles") and rejects arbitrary garbage.
// Node 20+'s Intl is backed by full-icu by default, so this works in
// any deployment that ships full-icu (we pin it in package.json).
//
// We resolve the timezone via Intl.DateTimeFormat, which throws
// RangeError on an unknown name — that's the signal. We don't use
// `Intl.supportedValuesOf('timeZone')` because it enumerates 400+
// names and is overkill for a per-request validation; one Intl
// construction is cheap and accurate.
function isValidIanaTimezone(tz) {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length >= 64) return false;
  try {
    // Throws RangeError on an unknown IANA name.
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return true;
  } catch (_e) {
    return false;
  }
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
// DR-024 (round-20): tighten the trust boundary around
// `clientTimezone`. The previous check-in flow accepted any string the
// client sent and ran it through Intl with a try/catch — a malicious
// or buggy client could shift the bucket by sending an extreme timezone
// (e.g. "Pacific/Kiritimati", UTC+14, makes a 18:30 IST check-in land
// in the NEXT day's bucket from the server's frame). Now the handler
// validates `clientTimezone` against the runtime ICU/Intl database
// BEFORE using it (rejects unknown strings as 400 INVALID_TIMEZONE);
// the IANA path is kept for non-IST users but is now closed-trust.
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

  // DR-024: validate clientTimezone against the IANA database BEFORE
  // using it. Unknown / malformed strings return 400 INVALID_TIMEZONE
  // rather than being silently passed to Intl. Empty / missing string
  // is fine — that's the IST fallback path used by the entire
  // existing workforce.
  if (clientTimezone !== undefined && clientTimezone !== null && clientTimezone !== '') {
    if (typeof clientTimezone !== 'string' || !isValidIanaTimezone(clientTimezone)) {
      return res.status(400).json({
        error: 'clientTimezone must be a valid IANA timezone name',
        code: 'INVALID_TIMEZONE',
      });
    }
  }

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