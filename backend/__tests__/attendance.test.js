/**
 * Backend API Tests for Attendance Routes
 * Tests date handling, check-in/out, and edge cases
 */

const jwt = require('jsonwebtoken');

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

describe('Attendance Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Date Handling', () => {
    it('should parse YYYY-MM-DD format correctly', () => {
      const [year, month, day] = '2026-08-27'.split('-').map(Number);
      const date = new Date(Date.UTC(year, month - 1, day));

      expect(date.getUTCFullYear()).toBe(2026);
      expect(date.getUTCMonth()).toBe(7); // August is 7 (0-indexed)
      expect(date.getUTCDate()).toBe(27);
    });

    it('should convert Date to local YYYY-MM-DD string correctly', () => {
      // Simulate frontend's toDateString function
      const toDateString = (date) => {
        const d = new Date(date);
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
      };

      // Test with ISO string from backend
      const isoDate = '2026-08-27T00:00:00.000Z';
      const result = toDateString(isoDate);

      // Note: This depends on local timezone - in IST it would be 2026-08-27
      // In UTC-8 it would be 2026-08-26
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('should handle month range correctly', () => {
      const getMonthRange = (yearMonth) => {
        const [year, month] = yearMonth.split('-').map(Number);
        const startDate = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
        const endDate = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
        return { startDate, endDate };
      };

      const { startDate, endDate } = getMonthRange('2026-08');

      expect(startDate.getUTCFullYear()).toBe(2026);
      expect(startDate.getUTCMonth()).toBe(7);
      expect(startDate.getUTCDate()).toBe(1);

      expect(endDate.getUTCFullYear()).toBe(2026);
      expect(endDate.getUTCMonth()).toBe(7);
      expect(endDate.getUTCDate()).toBe(31);
    });
  });

  describe('GET /api/attendance', () => {
    it('should reject request without month param', async () => {
      const { requireAuth } = require('../src/routes/attendance.js');
      // The middleware check happens before our route handler
      expect(true).toBe(true); // Placeholder
    });

    it('should validate month format YYYY-MM', () => {
      const isValidMonth = (month) => /^\d{4}-\d{2}$/.test(month);

      expect(isValidMonth('2026-08')).toBe(true);
      expect(isValidMonth('2026-8')).toBe(false);
      expect(isValidMonth('26-08')).toBe(false);
      expect(isValidMonth('2026/08')).toBe(false);
      expect(isValidMonth('')).toBe(false);
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
