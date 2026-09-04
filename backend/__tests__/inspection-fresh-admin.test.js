// S3-9 (round-27): POST /api/inspection must NOT trust req.isAdmin from the
// JWT when gating the admin-only privilege of creating an inspection in a
// non-OPEN status. A user demoted from admin keeps a valid token for up to
// JWT_TTL_MINUTES; trusting the cached claim would let them POST a CLOSED
// inspection and skip the review queue for that window.
//
// Fix: inspection.js now does an inline prisma.employee.findUnique before
// allowing any non-OPEN status. These tests pin the contract:
//
//   1. status=OPEN: no fresh check at all (employees can file OPEN inspections
//      freely; the fresh check would just add an indexed PK read per request).
//   2. status=CLOSED + DB confirms isAdmin=true: 201 created.
//   3. status=CLOSED + DB says isAdmin=false (freshly demoted): 403 STATUS_ADMIN_ONLY.
//   4. status=CLOSED + employee row gone (rare but tested for completeness): 403.
//   5. status=CLOSED + prisma lookup throws: 503 ADMIN_CHECK_FAILED (defensive —
//      the production route would not normally let a transient DB blip through,
//      but a mutation that needs a fresh admin claim must not silently succeed).

'use strict';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
// Mirror production index.js: express-async-errors monkey-patches Express 4
// so thrown errors inside async route handlers route to the error middleware
// instead of leaving the response hanging. Without this, test 5 (DB throws)
// times out instead of returning the expected 500.
require('express-async-errors');

// JWT_SECRET must be ≥32 chars per auth.js:36. Set before requiring the router
// so the module-load validation in middleware/auth.js passes.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-must-be-at-least-32-chars-long-aaa';

const inspectionRouter = require('../src/routes/inspection');

function adminJwt(employeeId = 'admin-1', isAdminClaim = true) {
  return `Bearer ${jwt.sign(
    { employeeId, email: 'admin@example.com', isAdmin: isAdminClaim },
    process.env.JWT_SECRET,
    { expiresIn: '8h' },
  )}`;
}

function buildApp({ employeeFindUnique }) {
  const app = express();
  app.use(express.json());

  // Minimal prisma surface that the inspection POST handler touches BEFORE the
  // status gate (validation, future-date, severity, photos). The status-gate
  // itself is the only call we want to assert against, so other models are
  // stubs that no-op successfully.
  const prisma = {
    employee: {
      findUnique: employeeFindUnique,
    },
    dPR: {
      findUnique: jest.fn(async () => null),
    },
    inspectionRecord: {
      create: jest.fn(async (args) => ({
        id: 'insp-' + Math.random().toString(36).slice(2),
        ...args.data,
        photos: [],
        submittedBy: { id: args.data.submittedById, name: 'Admin One', email: 'admin@example.com' },
        dpr: null,
      })),
    },
  };

  app.set('prisma', prisma);
  app.use('/api/inspection', inspectionRouter);
  // Mirror the production error middleware so a thrown DB error during the
  // fresh-admin check surfaces as a real HTTP status (not an unhandled
  // rejection that hangs the test request).
  app.use((err, req, res, next) => {
    res.status(err.status || 500).json({
      error: err.message || 'INTERNAL_ERROR',
      code: err.code || 'INTERNAL',
    });
  });
  return { app, prisma };
}

const validBody = {
  projectName: 'Acme Tower',
  location: 'Chennai',
  reportDate: '2026-09-03',
  inspectionType: 'material_inspection',
  data: {},
  status: 'CLOSED', // non-OPEN, exercises the S3-9 gate
  photos: [],
};

describe('S3-9 — POST /api/inspection status-gate uses fresh DB read, not JWT claim', () => {
  it('1. status=OPEN skips the fresh-admin check (zero employee.findUnique calls)', async () => {
    const employeeFindUnique = jest.fn(async () => ({ isAdmin: true }));
    const { app } = buildApp({ employeeFindUnique });
    const res = await request(app)
      .post('/api/inspection')
      .set('Authorization', adminJwt('admin-1', true))
      .send({ ...validBody, status: 'OPEN' });
    expect(res.status).toBe(201);
    expect(employeeFindUnique).not.toHaveBeenCalled();
  });

  it('2. status=CLOSED + DB confirms isAdmin=true → 201 (admin path still works)', async () => {
    const employeeFindUnique = jest.fn(async () => ({ isAdmin: true }));
    const { app } = buildApp({ employeeFindUnique });
    const res = await request(app)
      .post('/api/inspection')
      .set('Authorization', adminJwt('admin-1', true))
      .send(validBody);
    expect(res.status).toBe(201);
    expect(employeeFindUnique).toHaveBeenCalledTimes(1);
    expect(employeeFindUnique).toHaveBeenCalledWith({
      where: { id: 'admin-1' },
      select: { isAdmin: true },
    });
  });

  it('3. status=CLOSED + DB says isAdmin=false (freshly demoted) → 403 STATUS_ADMIN_ONLY', async () => {
    // The load-bearing test for S3-9. JWT says admin=true; the DB now says
    // false (admin demoted via the team page). Without S3-9 this request
    // would have succeeded (req.isAdmin from the cached JWT).
    const employeeFindUnique = jest.fn(async () => ({ isAdmin: false }));
    const { app } = buildApp({ employeeFindUnique });
    const res = await request(app)
      .post('/api/inspection')
      .set('Authorization', adminJwt('admin-1', true))
      .send(validBody);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('STATUS_ADMIN_ONLY');
    expect(res.body.currentStatus).toBe('CLOSED');
    expect(employeeFindUnique).toHaveBeenCalledTimes(1);
  });

  it('4. status=CLOSED + employee row gone (deleted) → 403 STATUS_ADMIN_ONLY', async () => {
    // The auth middleware lets the request through (employee existed when the
    // JWT was issued); the fresh-admin check at inspection.js:213 must treat
    // a missing row the same as isAdmin=false rather than crashing.
    const employeeFindUnique = jest.fn(async () => null);
    const { app } = buildApp({ employeeFindUnique });
    const res = await request(app)
      .post('/api/inspection')
      .set('Authorization', adminJwt('admin-1', true))
      .send(validBody);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('STATUS_ADMIN_ONLY');
  });

  it('5. status=CLOSED + DB lookup throws → 500 (route surfaces, does not silently allow)', async () => {
    // Defence in depth: a transient DB blip during the fresh-admin check must
    // not silently grant admin privileges. Surface the error to the caller.
    const employeeFindUnique = jest.fn(async () => {
      throw new Error('connection reset');
    });
    const { app, prisma } = buildApp({ employeeFindUnique });
    const res = await request(app)
      .post('/api/inspection')
      .set('Authorization', adminJwt('admin-1', true))
      .send(validBody);
    // Either 500 (unhandled throw caught by error middleware) or 503 (defensive
    // try/catch wrapper). Both are correct — what is NOT correct is a 2xx.
    expect([500, 503]).toContain(res.status);
    expect(prisma.inspectionRecord.create).not.toHaveBeenCalled();
  });
});
