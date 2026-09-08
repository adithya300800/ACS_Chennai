// DR-019 (audit, 2026-09-08) — Version-pinned variation order mutations.
//
// Audit verdict (Code review by SOL/ACS-Portal-Workflow-Completeness-Review-
// 2026-09-08-5c61cd8.md, lines 300-310):
//
//   "Competing VO/COP decisions and stale edits read state first and
//    later update by ID alone — no version pin."
//
// Acceptance for this round:
//   1. PATCH with stale `expectedVersion` returns 409 VERSION_CONFLICT.
//   2. PATCH with matching `expectedVersion` returns 200, version
//      increments by 1.
//   3. /submit with stale `expectedVersion` returns 409.
//   4. /approve with stale `expectedVersion` returns 409 (and the row
//      stays SUBMITTED — no state leak from the rejected write).
//   5. /reject with stale `expectedVersion` returns 409.
//
// Mirrors variations.dr017.test.js for the editable-field contract but
// adds the optimistic-concurrency pin. The legacy tests (no
// expectedVersion) still pass via the unconditional fallback.
//
// The fixture is in-memory: a Map of variations with the standard
// N2 fields. The mock supports `updateMany` for the conditional-WHERE
// path and `findUnique` for the post-update read-back. `$transaction`
// isn't used (variations don't need an atomic supersede like billing
// corrections do — the existing single-row updateMany is enough).

'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

const variationsRouter = require('../src/routes/variations');

const EMPLOYEE_ID = 'emp-dr019-raiser';
const OTHER_EMPLOYEE = 'emp-dr019-other';
const VARIATION_ID = '9e8d3f1a-1234-4abc-9def-02468ace0001';
const PROJECT_ID = '7c8d3f1a-1234-4abc-9def-02468ace0002';

let variations = {};

function seedVariation({
  id = VARIATION_ID,
  projectId = PROJECT_ID,
  raisedById = EMPLOYEE_ID,
  status = 'DRAFT',
  title = 'Original title',
  description = 'Original description',
  deltaAmount = '150000',
  clientApprovalRequired = true,
  version = 0,
} = {}) {
  variations[id] = {
    id,
    projectId,
    raisedById,
    status,
    title,
    description,
    deltaAmount,
    clientApprovalRequired,
    submittedAt: null,
    approvedById: null,
    approvedAt: null,
    rejectedAt: null,
    rejectedReason: null,
    version,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
  };
  return variations[id];
}

function buildApp({ isAdmin = false, employeeId = EMPLOYEE_ID } = {}) {
  const app = express();
  app.use(express.json());

  // Helper: pick the rows that match a conditional WHERE.
  const rowMatchesWhere = (row, where = {}) => {
    if (where.id && row.id !== where.id) return false;
    if (where.version !== undefined && row.version !== where.version) return false;
    if (where.status && row.status !== where.status) return false;
    return true;
  };

  const prisma = {
    variationOrder: {
      findUnique: async ({ where }) => {
        const row = variations[where.id];
        if (!row) return null;
        return {
          ...row,
          project: { id: row.projectId, name: 'Test Project', code: 'TP-01' },
          raisedBy: { id: row.raisedById, name: 'Raiser', email: 'r@example.com' },
          approvedBy: row.approvedById ? {
            id: row.approvedById, name: 'Approver', email: 'a@example.com',
          } : null,
        };
      },
      update: async ({ where, data }) => {
        const row = variations[where.id];
        if (!row) {
          const e = new Error('Record not found');
          e.code = 'P2025';
          throw e;
        }
        for (const [k, v] of Object.entries(data)) {
          if (k === 'deltaAmount') row[k] = String(v);
          else row[k] = v;
        }
        return {
          ...row,
          project: { id: row.projectId, name: 'Test Project', code: 'TP-01' },
          raisedBy: { id: row.raisedById, name: 'Raiser', email: 'r@example.com' },
          approvedBy: row.approvedById ? {
            id: row.approvedById, name: 'Approver', email: 'a@example.com',
          } : null,
        };
      },
      // [DR-019] updateMany with conditional WHERE — pin on
      // (id, version, status). Mirrors the conditional-WHERE pattern
      // from billingCertifications.js. When count !== 1, the route
      // returns 409.
      updateMany: async ({ where = {}, data }) => {
        const targets = Object.values(variations).filter((r) => rowMatchesWhere(r, where));
        for (const row of targets) {
          for (const [k, v] of Object.entries(data)) {
            if (v && typeof v === 'object' && 'increment' in v) {
              row[k] = (row[k] || 0) + v.increment;
            } else if (k === 'deltaAmount') {
              row[k] = String(v);
            } else {
              row[k] = v;
            }
          }
        }
        return { count: targets.length };
      },
    },
    employee: {
      findUnique: async () => ({ id: employeeId, isAdmin }),
    },
    project: {
      findUnique: async () => ({ id: PROJECT_ID, isActive: true }),
    },
  };

  app.set('prisma', prisma);
  app.use('/api/variations', variationsRouter);
  return app;
}

function authHeader(employeeId = EMPLOYEE_ID) {
  return jwt.sign(
    { employeeId, email: `${employeeId}@example.com` },
    process.env.JWT_SECRET,
    { expiresIn: '8h' },
  );
}

beforeEach(() => {
  variations = {};
});

describe('DR-019 — version-pinned variation order mutations', () => {
  describe('PATCH /:id with expectedVersion', () => {
    test('rejects PATCH with stale expectedVersion (409 VERSION_CONFLICT)', async () => {
      seedVariation({ version: 5 });
      const app = buildApp();

      const res = await request(app)
        .patch(`/api/variations/${VARIATION_ID}`)
        .set('Authorization', `Bearer ${authHeader()}`)
        .send({ title: 'Stale edit', expectedVersion: 3 });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('VERSION_CONFLICT');
      expect(res.body.currentVersion).toBe(5);
      // The store was not updated.
      expect(variations[VARIATION_ID].title).toBe('Original title');
    });

    test('accepts PATCH with matching expectedVersion (200, version increments)', async () => {
      seedVariation({ version: 2 });
      const app = buildApp();

      const res = await request(app)
        .patch(`/api/variations/${VARIATION_ID}`)
        .set('Authorization', `Bearer ${authHeader()}`)
        .send({ title: 'Edited title', expectedVersion: 2 });

      expect(res.status).toBe(200);
      expect(res.body.title).toBe('Edited title');
      expect(variations[VARIATION_ID].version).toBe(3);
    });

    test('legacy PATCH (no expectedVersion) still works for in-flight clients', async () => {
      seedVariation({ version: 0 });
      const app = buildApp();

      const res = await request(app)
        .patch(`/api/variations/${VARIATION_ID}`)
        .set('Authorization', `Bearer ${authHeader()}`)
        .send({ title: 'Legacy client' });

      expect(res.status).toBe(200);
      expect(variations[VARIATION_ID].version).toBe(1);
    });
  });

  describe('POST /:id/submit with expectedVersion', () => {
    test('rejects /submit with stale expectedVersion (409)', async () => {
      seedVariation({ version: 4 });
      const app = buildApp();

      const res = await request(app)
        .post(`/api/variations/${VARIATION_ID}/submit`)
        .set('Authorization', `Bearer ${authHeader()}`)
        .send({ expectedVersion: 2 });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('VERSION_CONFLICT');
      expect(variations[VARIATION_ID].status).toBe('DRAFT');
    });

    test('accepts /submit with matching expectedVersion (200, version increments)', async () => {
      seedVariation({ version: 0 });
      const app = buildApp();

      const res = await request(app)
        .post(`/api/variations/${VARIATION_ID}/submit`)
        .set('Authorization', `Bearer ${authHeader()}`)
        .send({ expectedVersion: 0 });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('SUBMITTED');
      expect(variations[VARIATION_ID].version).toBe(1);
    });
  });

  describe('POST /:id/approve with expectedVersion', () => {
    test('rejects /approve with stale expectedVersion (409)', async () => {
      seedVariation({ version: 3, status: 'SUBMITTED' });
      const app = buildApp({ isAdmin: true });

      const res = await request(app)
        .post(`/api/variations/${VARIATION_ID}/approve`)
        .set('Authorization', `Bearer ${authHeader()}`)
        .send({ expectedVersion: 1 });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('VERSION_CONFLICT');
      // The row stays SUBMITTED — no state leak.
      expect(variations[VARIATION_ID].status).toBe('SUBMITTED');
    });

    test('accepts /approve with matching expectedVersion (200, status → APPROVED)', async () => {
      seedVariation({ version: 0, status: 'SUBMITTED' });
      const app = buildApp({ isAdmin: true });

      const res = await request(app)
        .post(`/api/variations/${VARIATION_ID}/approve`)
        .set('Authorization', `Bearer ${authHeader()}`)
        .send({ expectedVersion: 0 });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('APPROVED');
      expect(variations[VARIATION_ID].version).toBe(1);
    });
  });

  describe('POST /:id/reject with expectedVersion', () => {
    test('rejects /reject with stale expectedVersion (409)', async () => {
      seedVariation({ version: 2, status: 'SUBMITTED' });
      const app = buildApp({ isAdmin: true });

      const res = await request(app)
        .post(`/api/variations/${VARIATION_ID}/reject`)
        .set('Authorization', `Bearer ${authHeader()}`)
        .send({ reason: 'Need more detail', expectedVersion: 0 });

      expect(res.status).toBe(409);
      expect(variations[VARIATION_ID].status).toBe('SUBMITTED');
    });

    test('accepts /reject with matching expectedVersion (200, status → REJECTED)', async () => {
      seedVariation({ version: 0, status: 'SUBMITTED' });
      const app = buildApp({ isAdmin: true });

      const res = await request(app)
        .post(`/api/variations/${VARIATION_ID}/reject`)
        .set('Authorization', `Bearer ${authHeader()}`)
        .send({ reason: 'Need more detail', expectedVersion: 0 });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('REJECTED');
      expect(variations[VARIATION_ID].version).toBe(1);
    });
  });
});
