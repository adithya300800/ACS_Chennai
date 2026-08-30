const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');

// Helper: Get UTC start and end of a local date (YYYY-MM format)
function getMonthRange(yearMonth) {
  const [year, month] = yearMonth.split('-').map(Number);
  // Convert local date to UTC range for database query
  const startDate = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  const endDate = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
  return { startDate, endDate };
}

// Helper: Parse YYYY-MM-DD string to UTC midnight for storage
function parseLocalDate(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

// Helper: Get date string YYYY-MM-DD from Date object (local timezone for display)
function toLocalDateString(date) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Helper: Get today's UTC date for attendance record (uses server time)
function getTodayUTCDate() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
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
    attendanceDate = new Date(Date.UTC(year, month - 1, day));
  } else {
    attendanceDate = getTodayUTCDate();
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
    const attendanceDate = getTodayUTCDate();
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
  const { latitude, longitude, address, localDateTime } = req.body;

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

  // P2: server time is the source of truth — use it for both checkInAt and
  // the attendance-date bucket (UTC day of the server clock).
  const checkInTime = new Date();
  const attendanceDate = new Date(
    Date.UTC(checkInTime.getUTCFullYear(), checkInTime.getUTCMonth(), checkInTime.getUTCDate())
  );

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

module.exports = router;