/**
 * DR-024 (round-20): attendance check-in timezone trust boundary.
 *
 * The original DR-024 design hardened the trust boundary around the
 * client-supplied `clientTimezone` field: validated it against the
 * ICU/Intl database, rejected unknown strings as 400 INVALID_TIMEZONE,
 * and used the IANA-aware path only for opted-in users. That was
 * correct but heavy.
 *
 * User simplification (round-20, post-deploy conversation): the company
 * is based in India and every employee works in IST. Even when the user
 * (PST) views the portal, they're happy to see IST-day records — there
 * is no per-user day boundary to negotiate. Both paths collapsed into
 * ONE: computeLocalDate always buckets by Asia/Kolkata; clientTimezone
 * is accepted on the wire (frontend still sends it) but ignored.
 *
 * The DR-024 trust-boundary bug ("client picks the authoritative day")
 * is now STRUCTURALLY IMPOSSIBLE — there is no client-controlled
 * timezone to validate. This test file pins the new contract.
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

describe('DR-024 simplified — clientTimezone is IGNORED, no validation gate', () => {
  const app = buildApp();

  it('omitting clientTimezone still works (legacy path)', async () => {
    const res = await request(app)
      .post('/api/attendance/check-in')
      .set('Authorization', authHeader())
      .send({ latitude: 12.97, longitude: 77.59 });

    expect(res.status).toBe(201);
  });

  it('clientTimezone with garbage string is IGNORED, not rejected (no 400)', async () => {
    // Round-20 originally returned 400 INVALID_TIMEZONE here. The
    // user-requested simplification drops the validation gate: the
    // field is accepted on the wire but never affects the bucket.
    const res = await request(app)
      .post('/api/attendance/check-in')
      .set('Authorization', authHeader())
      .send({
        latitude: 12.97, longitude: 77.59,
        clientTimezone: 'definitely-not-a-tz',
      });

    expect(res.status).toBe(201);
  });

  it('clientTimezone with non-IST valid IANA name is IGNORED — bucket stays IST', async () => {
    // A user claiming PST should NOT shift the bucket into a different
    // calendar day. The bucket is always IST, regardless of what the
    // client claims.
    const res = await request(app)
      .post('/api/attendance/check-in')
      .set('Authorization', authHeader())
      .send({
        latitude: 12.97, longitude: 77.59,
        clientTimezone: 'America/Los_Angeles',
      });

    expect(res.status).toBe(201);
    // The attendance.date is a UTC-midnight Date of the IST calendar day.
    // We can't easily pin a specific calendar day without freezing time,
    // but we CAN assert it's always UTC midnight (canonical encoding).
    expect(attendances[0].date.getUTCHours()).toBe(0);
    expect(attendances[0].date.getUTCMinutes()).toBe(0);
    expect(attendances[0].date.getUTCSeconds()).toBe(0);
    expect(attendances[0].date.getUTCMilliseconds()).toBe(0);
  });

  it('clientTimezone with extreme-shift exploit is IGNORED (no day shift)', async () => {
    // "Pacific/Kiritimati" is a valid IANA name (UTC+14, Line Islands).
    // Previously this would have shifted the bucket by 14 hours.
    // Now it's just ignored — the bucket is always IST.
    const res = await request(app)
      .post('/api/attendance/check-in')
      .set('Authorization', authHeader())
      .send({
        latitude: 12.97, longitude: 77.59,
        clientTimezone: 'Pacific/Kiritimati',
      });

    expect(res.status).toBe(201);
    // Canonical encoding is preserved.
    expect(attendances[0].date.getUTCHours()).toBe(0);
  });

  it('non-string clientTimezone is IGNORED, not rejected', async () => {
    const res = await request(app)
      .post('/api/attendance/check-in')
      .set('Authorization', authHeader())
      .send({
        latitude: 12.97, longitude: 77.59,
        clientTimezone: { evil: true },
      });

    expect(res.status).toBe(201);
  });

  it('null clientTimezone is IGNORED, not rejected', async () => {
    const res = await request(app)
      .post('/api/attendance/check-in')
      .set('Authorization', authHeader())
      .send({
        latitude: 12.97, longitude: 77.59,
        clientTimezone: null,
      });

    expect(res.status).toBe(201);
  });
});

describe('DR-024 — server time is the source of truth (unchanged)', () => {
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

  it('rejects localDateTime with too-large drift', async () => {
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