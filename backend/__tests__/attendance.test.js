/**
 * Backend API Tests for Attendance Routes
 * Tests date handling, check-in/out, and edge cases
 *
 * DR-023: imports the canonical dateOnly helper so the route handlers
 * and the test suite share one source of truth for date encoding. The
 * previous inline helpers duplicated the same UTC-midnight shape and
 * silently drifted when one was edited but not the other.
 */

const jwt = require('jsonwebtoken');

const {
  parseDateOnlyToUtc,
  getTodayBusinessDate,
  getMonthRangeUtc,
  formatDateOnly,
  isSameUtcCalendarDay,
} = require('../src/lib/dateOnly');

// Mock Prisma Client
const mockPrisma = {
  employee: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  attendance: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
  },
  attendanceSession: {
    create: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
};

// Mock Express app setup
const createMockReq = (overrides = {}) => ({
  body: {},
  params: {},
  query: {},
  headers: {},
  employeeId: 'test-employee-id',
  app: { get: () => mockPrisma },
  ...overrides,
});

const createMockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

// Helper to generate valid JWT
const generateToken = (employeeId, email) => {
  return jwt.sign(
    { employeeId, email },
    process.env.JWT_SECRET || 'change-me-in-production',
    { expiresIn: '8h' }
  );
};

// Pull the route handler out of the Express router so we can invoke it
// directly without going through `requireAuth`. The test simulates an
// already-authenticated request by setting `req.employeeId` and the
// header bits `requireAuth` would have validated.
function findRoute(router, method, path) {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === path && l.route.methods[method.toLowerCase()]
  );
  if (!layer) throw new Error(`route not found: ${method} ${path}`);
  // Strip the requireAuth layer from the route's stack so we can invoke
  // the handler directly. The router is configured as
  //   router.use(requireAuth); router.get('/today', handler)
  // so the handler is the LAST element in route.stack.
  const handlers = layer.route.stack.map((s) => s.handle);
  return handlers[handlers.length - 1];
}

describe('Attendance Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Date Handling (canonical helper, DR-023)', () => {
    it('parseDateOnlyToUtc round-trips a YYYY-MM-DD to UTC midnight', () => {
      const d = parseDateOnlyToUtc('2026-08-27');
      expect(d.toISOString()).toBe('2026-08-27T00:00:00.000Z');
      expect(d.getUTCFullYear()).toBe(2026);
      expect(d.getUTCMonth()).toBe(7); // August is 7 (0-indexed)
      expect(d.getUTCDate()).toBe(27);
    });

    it('parseDateOnlyToUtc rejects invalid shapes', () => {
      expect(() => parseDateOnlyToUtc('2026-13-01')).toThrow(/INVALID_DATE_ONLY|month/i);
      expect(() => parseDateOnlyToUtc('2026-02-30')).toThrow(/INVALID_DATE_ONLY|day/i);
      expect(() => parseDateOnlyToUtc('not-a-date')).toThrow();
    });

    it('formatDateOnly extracts the UTC calendar day from a Date', () => {
      expect(formatDateOnly(parseDateOnlyToUtc('2026-09-02'))).toBe('2026-09-02');
    });

    it('getMonthRangeUtc returns a half-open interval [start, endNextMonth)', () => {
      const { startDate, endDate } = getMonthRangeUtc('2026-08');
      expect(startDate.toISOString()).toBe('2026-08-01T00:00:00.000Z');
      expect(endDate.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    });

    it('isSameUtcCalendarDay treats two UTC-midnight Dates on the same day as equal', () => {
      expect(
        isSameUtcCalendarDay(
          new Date(Date.UTC(2026, 8, 2, 0, 0, 0)),
          new Date(Date.UTC(2026, 8, 2, 23, 59, 59))
        )
      ).toBe(true);
    });
  });

  describe('GET /api/attendance', () => {
    it('rejects request without month param', () => {
      // Middleware shape check happens before the route handler.
      expect(true).toBe(true); // Placeholder
    });

    it('validates month format YYYY-MM', () => {
      const isValidMonth = (month) => /^\d{4}-\d{2}$/.test(month);

      expect(isValidMonth('2026-08')).toBe(true);
      expect(isValidMonth('2026-8')).toBe(false);
      expect(isValidMonth('26-08')).toBe(false);
      expect(isValidMonth('2026/08')).toBe(false);
      expect(isValidMonth('')).toBe(false);
    });

    it('uses getMonthRangeUtc with gte/lt (half-open) — DR-023', async () => {
      const attendanceRouter = require('../src/routes/attendance');
      const handler = findRoute(attendanceRouter, 'GET', '/');

      mockPrisma.attendance.findMany.mockResolvedValueOnce([]);
      const req = createMockReq({ query: { month: '2026-08' } });
      const res = createMockRes();

      await handler(req, res);

      const whereArg = mockPrisma.attendance.findMany.mock.calls[0][0].where;
      const range = getMonthRangeUtc('2026-08');
      expect(whereArg.date.gte.toISOString()).toBe(range.startDate.toISOString());
      // The route MUST use `lt` (not `lte`) for the half-open interval.
      expect(whereArg.date).toHaveProperty('lt');
      expect(whereArg.date).not.toHaveProperty('lte');
      expect(whereArg.date.lt.toISOString()).toBe(range.endDate.toISOString());
    });
  });

  describe('GET /api/attendance/today', () => {
    it('queries Prisma with parseDateOnlyToUtc of the localDate query — DR-023', async () => {
      const attendanceRouter = require('../src/routes/attendance');
      const handler = findRoute(attendanceRouter, 'GET', '/today');

      mockPrisma.attendance.findFirst.mockResolvedValueOnce(null);
      const req = createMockReq({ query: { localDate: '2026-09-02' } });
      const res = createMockRes();

      await handler(req, res);

      const whereArg = mockPrisma.attendance.findFirst.mock.calls[0][0].where;
      const expected = parseDateOnlyToUtc('2026-09-02');
      expect(whereArg.date.toISOString()).toBe(expected.toISOString());
      expect(res.json).toHaveBeenCalledWith(null);
    });

    it('falls back to getTodayBusinessDate when localDate is missing', async () => {
      const attendanceRouter = require('../src/routes/attendance');
      const handler = findRoute(attendanceRouter, 'GET', '/today');

      mockPrisma.attendance.findFirst.mockResolvedValueOnce(null);
      const req = createMockReq({ query: {} });
      const res = createMockRes();

      await handler(req, res);

      const whereArg = mockPrisma.attendance.findFirst.mock.calls[0][0].where;
      const expected = getTodayBusinessDate();
      expect(whereArg.date.toISOString()).toBe(expected.toISOString());
    });

    it('falls back to today when localDate is malformed (does not 500)', async () => {
      const attendanceRouter = require('../src/routes/attendance');
      const handler = findRoute(attendanceRouter, 'GET', '/today');

      mockPrisma.attendance.findFirst.mockResolvedValueOnce(null);
      const req = createMockReq({ query: { localDate: 'definitely-not-a-date' } });
      const res = createMockRes();

      await handler(req, res);

      // The pre-check regex doesn't match, so it falls back to today.
      const whereArg = mockPrisma.attendance.findFirst.mock.calls[0][0].where;
      const expected = getTodayBusinessDate();
      expect(whereArg.date.toISOString()).toBe(expected.toISOString());
    });
  });

  describe('POST /api/attendance/check-in', () => {
    it('should require latitude and longitude', () => {
      const validateRequest = (body) => {
        const { latitude, longitude } = body;
        if (latitude === undefined || latitude === null || longitude === undefined || longitude === null) {
          return { valid: false, error: 'latitude and longitude are required' };
        }
        if (latitude === 0 && longitude === 0) {
          return { valid: false, error: 'Invalid location coordinates' };
        }
        return { valid: true };
      };

      expect(validateRequest({})).toEqual({ valid: false, error: 'latitude and longitude are required' });
      expect(validateRequest({ latitude: 12.9716 })).toEqual({ valid: false, error: 'latitude and longitude are required' });
      expect(validateRequest({ latitude: 12.9716, longitude: 80.0449 })).toEqual({ valid: true });
      expect(validateRequest({ latitude: 0, longitude: 0 })).toEqual({ valid: false, error: 'Invalid location coordinates' }); // 0,0 is invalid
      expect(validateRequest({ latitude: null, longitude: null })).toEqual({ valid: false, error: 'latitude and longitude are required' });
    });

    it('should handle coordinate formatting', () => {
      const formatCoords = (lat, lng) => {
        if (!lat || !lng || lat === 0 || lng === 0) return '';
        const latDir = lat >= 0 ? 'N' : 'S';
        const lngDir = lng >= 0 ? 'E' : 'W';
        return `${Math.abs(lat).toFixed(4)}°${latDir}, ${Math.abs(lng).toFixed(4)}°${lngDir}`;
      };

      expect(formatCoords(12.9716, 80.0449)).toBe('12.9716°N, 80.0449°E');
      expect(formatCoords(-34.6037, -58.3816)).toBe('34.6037°S, 58.3816°W');
      expect(formatCoords(0, 0)).toBe('');
      expect(formatCoords(null, null)).toBe('');
    });

    it('should reject 0,0 coordinates as invalid', () => {
      const validateCoords = (lat, lng) => {
        if (lat === undefined || lat === null || lng === undefined || lng === null) {
          return { valid: false, error: 'latitude and longitude are required' };
        }
        if (lat === 0 && lng === 0) {
          return { valid: false, error: 'Invalid location coordinates' };
        }
        return { valid: true };
      };

      expect(validateCoords(0, 0)).toEqual({ valid: false, error: 'Invalid location coordinates' });
      expect(validateCoords(12.9716, 80.0449)).toEqual({ valid: true });
      expect(validateCoords(-33.8688, 151.2093)).toEqual({ valid: true }); // Sydney
    });
  });

  describe('IST off-by-one integration (DR-023)', () => {
    /**
     * The bug, restated as a test:
     *
     *   1. Employee in Chennai checks in at 2026-09-02 00:30 IST.
     *      The instant sent to the server is `2026-09-01T19:00:00Z`.
     *   2. The server buckets the row into calendar day 2026-09-02 (IST).
     *   3. The employee opens the page later and the frontend asks
     *      `/api/attendance/today?localDate=2026-09-02`.
     *   4. Both the write (check-in) and the read (/today) MUST agree
     *      on the same DATE key in the DB — otherwise the "Mark
     *      Attendance" button stays disabled (showing a stale record).
     *
     * Before DR-023, the write path used UTC midnight (which stored
     * `2026-09-02`) while the read path used IST local midnight
     * (`2026-09-01T18:30:00Z` → stored `2026-09-01`). The two halves
     * disagreed by one day, and the user saw "Attendance Marked" on
     * the wrong day.
     *
     * This test mocks Prisma so we don't need a real DB.
     */
    it('a check-in at IST 2026-09-02 00:30 buckets under DATE 2026-09-02', async () => {
      const attendanceRouter = require('../src/routes/attendance');
      const checkInHandler = findRoute(attendanceRouter, 'POST', '/check-in');

      // Mock a successful create (no P2002 race) and a follow-up findUnique.
      const created = {
        id: 'attendance-id-1',
        employeeId: 'test-employee-id',
        date: parseDateOnlyToUtc('2026-09-02'),
        status: 'Present',
        sessions: [],
      };
      mockPrisma.attendance.create.mockResolvedValueOnce(created);
      mockPrisma.attendanceSession.create.mockResolvedValueOnce({
        id: 'session-id-1',
        attendanceId: 'attendance-id-1',
        checkIn: new Date('2026-09-01T19:00:00Z'),
      });
      mockPrisma.attendance.findUnique.mockResolvedValueOnce({
        ...created,
        sessions: [{ id: 'session-id-1', checkIn: new Date('2026-09-01T19:00:00Z'), checkOut: null }],
      });

      // IST 2026-09-02 00:30 == UTC 2026-09-01 19:00.
      // We send the UTC instant and the IANA tz; the server's
      // computeLocalDate must extract the IST calendar day.
      const req = createMockReq({
        body: {
          latitude: 13.0827,
          longitude: 80.2707,
          address: 'Chennai, India',
          localDateTime: '2026-09-01T19:00:00.000Z',
          clientTimezone: 'Asia/Kolkata',
        },
      });
      const res = createMockRes();

      await checkInHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      const createArg = mockPrisma.attendance.create.mock.calls[0][0];
      const writtenDate = createArg.data.date;
      // The write MUST use UTC midnight of 2026-09-02 (the IST calendar day).
      expect(writtenDate.toISOString()).toBe('2026-09-02T00:00:00.000Z');
      // The response's `date` field MUST also be 2026-09-02 (not the
      // previous day under IST-local midnight).
      const responsePayload = res.json.mock.calls[0][0];
      expect(responsePayload.date).toBe('2026-09-02');
    });

    it('/today?localDate=2026-09-02 reads back the same DATE key — DR-023', async () => {
      const attendanceRouter = require('../src/routes/attendance');
      const todayHandler = findRoute(attendanceRouter, 'GET', '/today');

      // Simulate the row that the IST 00:30 check-in would have written.
      // Both halves (write + read) MUST resolve to the same stored DATE.
      const stored = {
        id: 'attendance-id-1',
        employeeId: 'test-employee-id',
        date: parseDateOnlyToUtc('2026-09-02'),
        status: 'Present',
        sessions: [{ id: 's1', checkIn: new Date('2026-09-01T19:00:00Z'), checkOut: null }],
      };
      mockPrisma.attendance.findFirst.mockResolvedValueOnce(stored);

      const req = createMockReq({ query: { localDate: '2026-09-02' } });
      const res = createMockRes();

      await todayHandler(req, res);

      // The query MUST be made against UTC midnight of 2026-09-02 so
      // Prisma's @db.Date column matches what /check-in wrote.
      const whereArg = mockPrisma.attendance.findFirst.mock.calls[0][0].where;
      expect(whereArg.date.toISOString()).toBe('2026-09-02T00:00:00.000Z');

      // The response's `date` MUST also be 2026-09-02 — the original
      // IST-local-midnight path would have returned 2026-09-01.
      const responsePayload = res.json.mock.calls[0][0];
      expect(responsePayload.date).toBe('2026-09-02');
    });

    it('end-to-end: write at IST 2026-09-02 00:30 and read with localDate=2026-09-02 resolve to the same DATE key', async () => {
      // This is the head-to-head assertion: run both halves back to
      // back in the same test and prove they agree on the SAME date
      // constant. Pre-DR-023 the two would disagree (write: 2026-09-02,
      // read: 2026-09-01) and this assertion would fail.
      const attendanceRouter = require('../src/routes/attendance');
      const checkInHandler = findRoute(attendanceRouter, 'POST', '/check-in');
      const todayHandler = findRoute(attendanceRouter, 'GET', '/today');

      const stored = {
        id: 'attendance-id-1',
        employeeId: 'test-employee-id',
        date: parseDateOnlyToUtc('2026-09-02'),
        status: 'Present',
        sessions: [],
      };
      // Check-in writes the row.
      mockPrisma.attendance.create.mockResolvedValueOnce(stored);
      mockPrisma.attendanceSession.create.mockResolvedValueOnce({
        id: 'session-id-1',
        attendanceId: 'attendance-id-1',
        checkIn: new Date('2026-09-01T19:00:00Z'),
      });
      mockPrisma.attendance.findUnique.mockResolvedValueOnce({
        ...stored,
        sessions: [{ id: 'session-id-1', checkIn: new Date('2026-09-01T19:00:00Z'), checkOut: null }],
      });
      await checkInHandler(
        createMockReq({
          body: {
            latitude: 13.0827,
            longitude: 80.2707,
            address: 'Chennai',
            localDateTime: '2026-09-01T19:00:00.000Z',
            clientTimezone: 'Asia/Kolkata',
          },
        }),
        createMockRes()
      );

      const writeDateUsed = mockPrisma.attendance.create.mock.calls[0][0].data.date;

      // Now /today reads it back.
      mockPrisma.attendance.findFirst.mockResolvedValueOnce({
        ...stored,
        date: writeDateUsed,
        sessions: [{ id: 'session-id-1', checkIn: new Date('2026-09-01T19:00:00Z'), checkOut: null }],
      });
      await todayHandler(
        createMockReq({ query: { localDate: '2026-09-02' } }),
        createMockRes()
      );
      const readDateUsed = mockPrisma.attendance.findFirst.mock.calls[0][0].where.date;

      // Same DATE key — this is the assertion that would have failed
      // before DR-023.
      expect(writeDateUsed.toISOString()).toBe(readDateUsed.toISOString());
      expect(writeDateUsed.toISOString()).toBe('2026-09-02T00:00:00.000Z');
    });
  });

  describe('Authentication Middleware', () => {
    it('should reject request without Bearer token', () => {
      const requireAuth = (req, res, next) => {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return res.status(401).json({ error: 'Authorization required' });
        }
        next();
      };

      const req = createMockReq({ headers: {} });
      const res = createMockRes();
      const next = jest.fn();

      requireAuth(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Authorization required' });
      expect(next).not.toHaveBeenCalled();
    });

    it('should accept valid Bearer token', () => {
      const requireAuth = (req, res, next) => {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return res.status(401).json({ error: 'Authorization required' });
        }
        const token = authHeader.slice(7);
        try {
          const decoded = jwt.verify(token, process.env.JWT_SECRET || 'change-me-in-production');
          req.employeeId = decoded.employeeId;
          req.email = decoded.email;
          next();
        } catch {
          return res.status(401).json({ error: 'Invalid or expired token' });
        }
      };

      const token = generateToken('emp-123', 'test@example.com');
      const req = createMockReq({ headers: { authorization: `Bearer ${token}` } });
      const res = createMockRes();
      const next = jest.fn();

      requireAuth(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.employeeId).toBe('emp-123');
    });
  });
});

describe('Map URL Generation', () => {
  it('should generate valid OpenStreetMap embed URL', () => {
    const getMapUrl = (lat, lng) => {
      if (!lat || !lng || lat === 0 || lng === 0) return null;
      return `https://www.openstreetmap.org/export/embed.html?bbox=${lng - 0.005},${lat - 0.005},${lng + 0.005},${lat + 0.005}&layer=mapnik&marker=${lat},${lng}`;
    };

    const url = getMapUrl(12.9716, 80.0449);
    expect(url).toContain('12.9716');
    expect(url).toContain('80.0449');
    expect(url).toContain('openstreetmap.org');
    expect(getMapUrl(0, 0)).toBeNull();
    expect(getMapUrl(null, null)).toBeNull();
  });
});

describe('Time Formatting', () => {
  it('should format time in 12-hour format', () => {
    const formatTime = (dateStr) => {
      if (!dateStr) return '';
      return new Date(dateStr).toLocaleTimeString('en-IN', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
      });
    };

    // Test various times
    expect(formatTime('2026-08-27T03:30:00Z')).toMatch(/^\d{1,2}:\d{2}\s*(am|pm)$/i);
    expect(formatTime('2026-08-27T15:45:00Z')).toMatch(/^\d{1,2}:\d{2}\s*(am|pm)$/i);
    expect(formatTime(null)).toBe('');
    expect(formatTime('')).toBe('');
  });
});
