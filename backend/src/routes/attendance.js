const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';

// All routes require auth
router.use(requireAuth);

// GET /api/attendance?month=2025-08
router.get('/', async (req, res) => {
  const prisma = req.app.get('prisma');
  const { month } = req.query;

  if (!month) {
    return res.status(400).json({ error: 'month query param required (YYYY-MM)' });
  }

  try {
    const [year, monthNum] = month.split('-').map(Number);
    const startDate = new Date(year, monthNum - 1, 1);
    const endDate = new Date(year, monthNum, 0);

    const records = await prisma.attendance.findMany({
      where: {
        employeeId: req.employeeId,
        date: {
          gte: startDate,
          lte: endDate,
        },
      },
      orderBy: { date: 'asc' },
    });

    res.json(records);
  } catch (err) {
    console.error('Attendance list error:', err);
    res.status(500).json({ error: 'Failed to fetch attendance' });
  }
});

// GET /api/attendance/today
router.get('/today', async (req, res) => {
  const prisma = req.app.get('prisma');
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  try {
    const record = await prisma.attendance.findFirst({
      where: {
        employeeId: req.employeeId,
        date: today,
      },
    });

    res.json(record || null);
  } catch (err) {
    console.error('Today attendance error:', err);
    res.status(500).json({ error: 'Failed to fetch today attendance' });
  }
});

// POST /api/attendance/check-in
router.post('/check-in', async (req, res) => {
  const prisma = req.app.get('prisma');
  const { latitude, longitude, address } = req.body;

  if (!latitude || !longitude) {
    return res.status(400).json({ error: 'latitude and longitude are required' });
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  try {
    // Check if already checked in today
    const existing = await prisma.attendance.findFirst({
      where: { employeeId: req.employeeId, date: today },
    });

    if (existing) {
      return res.status(409).json({ error: 'Already checked in today', attendance: existing });
    }

    const record = await prisma.attendance.create({
      data: {
        employeeId: req.employeeId,
        date: today,
        status: 'Present',
        checkIn: new Date(),
        checkInLat: latitude,
        checkInLng: longitude,
        checkInAddr: address || null,
      },
    });

    res.status(201).json(record);
  } catch (err) {
    console.error('Check-in error:', err);
    res.status(500).json({ error: 'Check-in failed' });
  }
});

// PUT /api/attendance/check-out/:id
router.put('/check-out/:id', async (req, res) => {
  const prisma = req.app.get('prisma');
  const { id } = req.params;
  const { latitude, longitude, address } = req.body;

  if (!latitude || !longitude) {
    return res.status(400).json({ error: 'latitude and longitude are required' });
  }

  try {
    const record = await prisma.attendance.findUnique({ where: { id } });

    if (!record) {
      return res.status(404).json({ error: 'Attendance record not found' });
    }

    if (record.employeeId !== req.employeeId) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    if (record.checkOut) {
      return res.status(409).json({ error: 'Already checked out', attendance: record });
    }

    const updated = await prisma.attendance.update({
      where: { id },
      data: {
        checkOut: new Date(),
        checkOutLat: latitude,
        checkOutLng: longitude,
        checkOutAddr: address || null,
      },
    });

    res.json(updated);
  } catch (err) {
    console.error('Check-out error:', err);
    res.status(500).json({ error: 'Check-out failed' });
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
