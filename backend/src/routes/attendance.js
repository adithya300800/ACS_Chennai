const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';

// Helper: Get UTC start and end of a local date (YYYY-MM format)
function getMonthRange(yearMonth) {
  const [year, month] = yearMonth.split('-').map(Number);
  const startDate = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  const endDate = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
  return { startDate, endDate };
}

// Helper: Get today's date at UTC midnight
function getTodayUTC() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

// Helper: Parse YYYY-MM-DD string to UTC midnight
function parseLocalDate(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

// Helper: Get date string YYYY-MM-DD from Date object (local timezone)
function toLocalDateString(date) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Helper: Get UTC date for today (matches frontend's local date)
function getTodayForEmployee() {
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

// GET /api/attendance/today
router.get('/today', async (req, res) => {
  const prisma = req.app.get('prisma');
  const today = getTodayForEmployee();

  try {
    const record = await prisma.attendance.findFirst({
      where: {
        employeeId: req.employeeId,
        date: today,
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

// POST /api/attendance/check-in
router.post('/check-in', async (req, res) => {
  const prisma = req.app.get('prisma');
  const { latitude, longitude, address } = req.body;

  if (latitude === undefined || latitude === null || longitude === undefined || longitude === null) {
    return res.status(400).json({ error: 'latitude and longitude are required' });
  }

  // Use employee's local date for attendance record
  const attendanceDate = getTodayForEmployee();

  try {
    // Find or create attendance record for today
    let attendance = await prisma.attendance.findFirst({
      where: { employeeId: req.employeeId, date: attendanceDate },
    });

    if (!attendance) {
      attendance = await prisma.attendance.create({
        data: {
          employeeId: req.employeeId,
          date: attendanceDate,
          status: 'Present',
        },
      });
    }

    // Create new session
    const session = await prisma.attendanceSession.create({
      data: {
        attendanceId: attendance.id,
        checkIn: new Date(), // Store current timestamp in UTC
        checkInLat: latitude,
        checkInLng: longitude,
        checkInAddr: address || null,
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
    };

    res.status(201).json(transformed);
  } catch (err) {
    console.error('Check-in error:', err);
    res.status(500).json({ error: 'Check-in failed' });
  }
});

// PUT /api/attendance/check-out/:sessionId
router.put('/check-out/:sessionId', async (req, res) => {
  const prisma = req.app.get('prisma');
  const { sessionId } = req.params;
  const { latitude, longitude, address } = req.body;

  if (latitude === undefined || latitude === null || longitude === undefined || longitude === null) {
    return res.status(400).json({ error: 'latitude and longitude are required' });
  }

  try {
    const session = await prisma.attendanceSession.findUnique({
      where: { id: sessionId },
      include: { attendance: true },
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (session.attendance.employeeId !== req.employeeId) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    if (session.checkOut) {
      return res.status(409).json({ error: 'Already checked out' });
    }

    const updated = await prisma.attendanceSession.update({
      where: { id: sessionId },
      data: {
        checkOut: new Date(),
        checkOutLat: latitude,
        checkOutLng: longitude,
        checkOutAddr: address || null,
      },
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

// Middleware: require auth
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization required' });
  }

  const token = authHeader.slice(7);

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.employeeId = decoded.employeeId;
    req.email = decoded.email;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = router;
