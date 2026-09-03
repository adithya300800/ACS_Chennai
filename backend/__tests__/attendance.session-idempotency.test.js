/**
 * DR-025 (round-20): one open AttendanceSession per Attendance row.
 *
 * The previous schema had no DB-level constraint on
 * (attendanceId, checkOut IS NULL). A double-tap or a buggy client
 * could create two open sessions; /api/attendance/status then picked
 * the FIRST one via `find(s => !s.checkOut)` and orphaned the rest.
 * Admin timesheet reports under-counted hours because the second
 * session's checkIn was never visible.
 *
 * The fix:
 *   1. Migration adds a partial unique index:
 *      CREATE UNIQUE INDEX attendance_sessions_one_open_idx
 *        ON attendance_sessions (attendance_id) WHERE check_out IS NULL;
 *      Postgres rejects any second open session atomically.
 *
 *   2. The /check-in route wraps session creation in a $transaction
 *      with SELECT … FOR UPDATE on the Attendance row. Concurrent
 *      check-ins for the same (employee, day) serialize; different
 *      employees don't block each other. The precheck returns
 *      409 ALREADY_CHECKED_IN with the existing session info.
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
let nextAttId = 1;
let nextSessId = 1;

function buildApp() {
  const app = express();
  app.use(express.json());

  // Mock $transaction: invoke the callback with a tx-like object so the
  // route's FOR UPDATE + findFirst + create pattern runs sequentially.
  // For the constraint-violation test (the second-attempt race), we
  // surface a P2002 from the create as the tx error.
  const prisma = {
    $transaction: async (fn) => {
      const tx = {
        $queryRaw: async () => [{ id: 'locked-row' }], // pretend SELECT FOR UPDATE always locks
        attendanceSession: {
          findFirst: async ({ where }) =>
            sessions.find(
              (s) => s.attendanceId === where.attendanceId && s.checkOut === null
            ) || null,
          create: async ({ data }) => {
            // Enforce the partial unique index in the test harness too,
            // so we exercise the application-level precheck race window
            // as well as the constraint.
            const dup = sessions.find(
              (s) => s.attendanceId === data.attendanceId && s.checkOut === null
            );
            if (dup) {
              const e = new Error('Unique violation');
              e.code = 'P2002';
              throw e;
            }
            const s = { id: `sess-${nextSessId++}`, ...data };
            sessions.push(s);
            return s;
          },
        },
      };
      return await fn(tx);
    },
    attendance: {
      create: async ({ data }) => {
        const dup = attendances.find(
          (a) => a.employeeId === data.employeeId && a.date.getTime() === data.date.getTime()
        );
        if (dup) {
          const e = new Error('Unique violation');
          e.code = 'P2002';
          throw e;
        }
        const a = { id: `att-${nextAttId++}`, ...data };
        attendances.push(a);
        return a;
      },
      findFirst: async ({ where }) =>
        attendances.find(
          (a) => a.employeeId === where.employeeId && a.date.getTime() === where.date.getTime()
        ) || null,
      findUnique: async ({ where: { id } }) =>
        attendances.find((a) => a.id === id) || null,
    },
    attendanceSession: {
      // (also exists on the top-level for non-tx callers)
      findFirst: async ({ where }) =>
        sessions.find(
          (s) => s.attendanceId === where.attendanceId && s.checkOut === null
        ) || null,
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

function makeCheckInBody(overrides = {}) {
  return {
    latitude: 12.97, longitude: 77.59,
    ...overrides,
  };
}

beforeEach(() => {
  attendances = [];
  sessions = [];
  nextAttId = 1;
  nextSessId = 1;
});

describe('DR-025 — one open session per attendance row', () => {
  const app = buildApp();

  it('first check-in succeeds and creates an open session', async () => {
    const res = await request(app)
      .post('/api/attendance/check-in')
      .set('Authorization', authHeader())
      .send(makeCheckInBody());

    expect(res.status).toBe(201);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].checkOut).toBeNull();
  });

  it('second check-in for the same day returns 409 ALREADY_CHECKED_IN', async () => {
    // First one succeeds.
    const first = await request(app)
      .post('/api/attendance/check-in')
      .set('Authorization', authHeader())
      .send(makeCheckInBody());
    expect(first.status).toBe(201);

    // Second one for the same day hits the precheck + (test mock of)
    // the partial unique index.
    const second = await request(app)
      .post('/api/attendance/check-in')
      .set('Authorization', authHeader())
      .send(makeCheckInBody({ latitude: 12.98, longitude: 77.60 }));

    expect(second.status).toBe(409);
    expect(second.body.code).toBe('ALREADY_CHECKED_IN');
    expect(second.body.activeSession).not.toBeNull();
    expect(second.body.activeSession.id).toBe(sessions[0].id);
    // The 409 must NOT create a second session.
    expect(sessions).toHaveLength(1);
  });

  it('after check-out, a fresh check-in on the same day succeeds', async () => {
    // First check-in.
    const first = await request(app)
      .post('/api/attendance/check-in')
      .set('Authorization', authHeader())
      .send(makeCheckInBody());
    expect(first.status).toBe(201);

    // Manually check out the session (simulating /check-out completion).
    sessions[0].checkOut = new Date();

    // Now a second check-in should succeed because no open session.
    const second = await request(app)
      .post('/api/attendance/check-in')
      .set('Authorization', authHeader())
      .send(makeCheckInBody({ latitude: 12.99, longitude: 77.61 }));

    expect(second.status).toBe(201);
    expect(sessions).toHaveLength(2);
    expect(sessions[1].checkOut).toBeNull();
  });

  it('different employees can each have one open session on the same day', async () => {
    // Build a second app with a different employee; the partial index is
    // per-attendance-id (which is per-employee-day), so they don't collide.
    const OTHER_EMPLOYEE = 'other-employee';
    const otherApp = buildApp();
    const otherToken = jwt.sign(
      { employeeId: OTHER_EMPLOYEE, email: 'other@example.com' },
      process.env.JWT_SECRET,
      { expiresIn: '8h' },
    );

    // Employee 1 checks in.
    const r1 = await request(app)
      .post('/api/attendance/check-in')
      .set('Authorization', authHeader())
      .send(makeCheckInBody());
    expect(r1.status).toBe(201);

    // Employee 2 checks in (same UTC day).
    const r2 = await request(otherApp)
      .post('/api/attendance/check-in')
      .set('Authorization', `Bearer ${otherToken}`)
      .send(makeCheckInBody());
    expect(r2.status).toBe(201);

    // Two sessions, two attendance rows — no collision.
    expect(sessions).toHaveLength(2);
    expect(attendances).toHaveLength(2);
  });
});
