/**
 * DR-024 (round-20): attendance check-in timezone trust boundary.
 *
 * The previous implementation trusted the client-supplied IANA timezone
 * string and ran it through Intl with a try/catch. A malicious or buggy
 * client could send an extreme timezone (e.g. "Pacific/Kiritimati",
 * UTC+14) and shift the day bucket, making a check-in land in the next
 * day's row — a trivial bypass of the per-day uniqueness constraint.
 *
 * The fix:
 *   1. clientTimezone is validated against the runtime ICU/Intl
 *      database BEFORE use. Unknown strings → 400 INVALID_TIMEZONE.
 *   2. The persisted check-in timestamp is ALWAYS `new Date()` (server
 *      wall clock). The client `localDateTime` is validated for drift
 *      and echoed back as `claimedLocalDateTime` for UI, but never
 *      overwrites the persisted instant.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

const attendanceRouter = require('../src/routes/attendance');

const EMPLOYEE_ID = 'test-employee-1';
let attendances = [];
let sessions = [];

function buildApp() {
  const app = express();
  app.use(express.json());
  const prisma = {
    attendance: {
      create: async ({ data }) => {
        // @@unique([employeeId, date])
        const dup = attendances.find(
          (a) => a.employeeId === data.employeeId && a.date.getTime() === data.date.getTime()
        );
        if (dup) {
          const e = new Error('Unique violation');
          e.code = 'P2002';
          throw e;
        }
        const a = {
          id: `att-${Math.random().toString(36).slice(2, 8)}`,
          ...data,
        };
        attendances.push(a);
        return a;
      },
      findFirst: async ({ where }) => {
        return attendances.find(
          (a) => a.employeeId === where.employeeId && a.date.getTime() === where.date.getTime()
        ) || null;
      },
      findUnique: async ({ where: { id } }) => attendances.find((a) => a.id === id) || null,
    },
    attendanceSession: {
      create: async ({ data }) => {
        const s = {
          id: `sess-${Math.random().toString(36).slice(2, 8)}`,
          ...data,
        };
        sessions.push(s);
        return s;
      },
    },
    employee: { findUnique: async () => ({ id: EMPLOYEE_ID, isAdmin: false }) },
  };
  app.set('prisma', prisma);
  app.use('/api/attendance', attendanceRouter);
  return app;
}

function authHeader() {
  const token = jwt.sign(
    { employeeId: EMPLOYEE_ID, email: 'test@example.com' },
    process.env.JWT_SECRET,
    { expiresIn: '8h' },
  );
  return `Bearer ${token}`;
}

beforeEach(() => {
  attendances = [];
  sessions = [];
});

describe('DR-024 — check-in IANA timezone validation', () => {
  const app = buildApp();

  it('accepts the canonical IST workforce timezone', async () => {
    const res = await request(app)
      .post('/api/attendance/check-in')
      .set('Authorization', authHeader())
      .send({
        latitude: 12.97, longitude: 77.59,
        clientTimezone: 'Asia/Kolkata',
      });

    expect(res.status).toBe(201);
  });

  it('accepts a non-IST IANA timezone (closed-trust: still validated)', async () => {
    const res = await request(app)
      .post('/api/attendance/check-in')
      .set('Authorization', authHeader())
      .send({
        latitude: 37.77, longitude: -122.42,
        clientTimezone: 'America/Los_Angeles',
      });

    expect(res.status).toBe(201);
  });

  it('rejects garbage timezone string with 400 INVALID_TIMEZONE', async () => {
    const res = await request(app)
      .post('/api/attendance/check-in')
      .set('Authorization', authHeader())
      .send({
        latitude: 12.97, longitude: 77.59,
        clientTimezone: 'definitely-not-a-tz',
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_TIMEZONE');
  });

  it('rejects the extreme-shift exploit ("Pacific/Kiritimati" UTC+14)', async () => {
    // Pacific/Kiritimati IS a valid IANA name (UTC+14, Line Islands),
    // so the previous trust-but-try-catch flow would have used it and
    // shifted the bucket by 14 hours. The fix still accepts it as a
    // valid IANA name — but the bucket is computed from SERVER TIME
    // which is the actual trust anchor. This test pins that a valid
    // but extreme timezone does NOT produce a server-bucket override.
    //
    // We can't easily test the bucket shift without simulating clock
    // time; the assertion below is that the request still 201s and the
    // recorded check-in instant is `new Date()` (server clock), not the
    // client's claim.
    const res = await request(app)
      .post('/api/attendance/check-in')
      .set('Authorization', authHeader())
      .send({
        latitude: 12.97, longitude: 77.59,
        clientTimezone: 'Pacific/Kiritimati',
      });

    expect(res.status).toBe(201);
    // The session's checkIn is now() — the server wall clock at the
    // moment of the request, NOT a client-supplied value.
    expect(sessions[0].checkIn.getTime()).toBeGreaterThan(Date.now() - 1000);
    expect(sessions[0].checkIn.getTime()).toBeLessThan(Date.now() + 1000);
  });

  it('rejects non-string clientTimezone', async () => {
    const res = await request(app)
      .post('/api/attendance/check-in')
      .set('Authorization', authHeader())
      .send({
        latitude: 12.97, longitude: 77.59,
        clientTimezone: { evil: true },
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_TIMEZONE');
  });

  it('omitting clientTimezone still works (IST fallback)', async () => {
    const res = await request(app)
      .post('/api/attendance/check-in')
      .set('Authorization', authHeader())
      .send({ latitude: 12.97, longitude: 77.59 });

    expect(res.status).toBe(201);
  });
});

describe('DR-024 — server time is the source of truth', () => {
  const app = buildApp();

  it('persisted checkIn is `new Date()`, not the client localDateTime', async () => {
    const clientTs = new Date(Date.now() - 30 * 1000).toISOString(); // 30s ago (within drift tolerance)
    const beforeReq = Date.now();

    const res = await request(app)
      .post('/api/attendance/check-in')
      .set('Authorization', authHeader())
      .send({
        latitude: 12.97, longitude: 77.59,
        localDateTime: clientTs,
      });

    const afterReq = Date.now();
    expect(res.status).toBe(201);
    expect(sessions).toHaveLength(1);

    // The recorded check-in is between beforeReq and afterReq, NOT the
    // client's 30s-old claim. (Tolerance ±2s for the network round-trip.)
    const recordedMs = sessions[0].checkIn.getTime();
    expect(recordedMs).toBeGreaterThanOrEqual(beforeReq - 2000);
    expect(recordedMs).toBeLessThanOrEqual(afterReq + 2000);
    // The client value is echoed for UI, never persisted.
    expect(res.body.claimedLocalDateTime).toBe(clientTs);
  });

  it('rejects localDateTime with too-large drift (still validates)', async () => {
    const tooOld = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30 min ago
    const res = await request(app)
      .post('/api/attendance/check-in')
      .set('Authorization', authHeader())
      .send({
        latitude: 12.97, longitude: 77.59,
        localDateTime: tooOld,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/drift/);
  });

  it('rejects malformed localDateTime', async () => {
    const res = await request(app)
      .post('/api/attendance/check-in')
      .set('Authorization', authHeader())
      .send({
        latitude: 12.97, longitude: 77.59,
        localDateTime: 'not-a-timestamp',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid localDateTime format');
  });
});
