// SOL DR-017 regression coverage.
//
// Defect: clicking "Edit draft" on a variation crashed the modal
// (render) and then the PATCH save failed because the assembled
// payload included the immutable `projectId` field (PATCH returns
// 400 UNKNOWN_FIELDS for any key outside ALLOWED_UPDATE_FIELDS in
// backend/src/routes/variations.js).
//
// Acceptance (audit, lines 274-286 of the 2026-09-08 review):
//   - PATCH /api/variations/:id with a payload that does NOT include
//     `projectId` must succeed (200) and apply the edits.
//   - PATCH /api/variations/:id with a payload that DOES include
//     `projectId` must be rejected (400 UNKNOWN_FIELDS) — the
//     immutable-identity contract is preserved.
//   - The existing fields (title / description / deltaAmount /
//     clientApprovalRequired) continue to work via PATCH.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

const variationsRouter = require('../src/routes/variations');

const EMPLOYEE_ID = 'emp-dr017-raiser';
const OTHER_EMPLOYEE = 'emp-dr017-other';
const VARIATION_ID = '9e8d3f1a-1234-4abc-9def-02468ace0001';
const PROJECT_ID = '7c8d3f1a-1234-4abc-9def-02468ace0002';
const OTHER_PROJECT_ID = '7c8d3f1a-1234-4abc-9def-02468ace0003';

let variations = {};

function seedVariation({
  id = VARIATION_ID,
  projectId = PROJECT_ID,
  raisedById = EMPLOYEE_ID,
  status = 'DRAFT',
  title = 'Original title',
  description = 'Original description',
  deltaAmount = 150000,
  clientApprovalRequired = true,
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
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
  };
  return variations[id];
}

function buildApp({ isAdmin = false, employeeId = EMPLOYEE_ID } = {}) {
  const app = express();
  app.use(express.json());

  const prisma = {
    variationOrder: {
      findUnique: async ({ where }) => {
        const row = variations[where.id];
        if (!row) return null;
        // Include the joins the route asks for so the JSON
        // serializer doesn't NPE.
        return {
          ...row,
          project: { id: row.projectId, name: 'Test Project', code: 'TP-01' },
          raisedBy: { id: row.raisedById, name: 'Raiser', email: 'r@example.com' },
          approvedBy: null,
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
          if (k === 'deltaAmount') {
            // Backend serializes Decimal as a string; coerce numeric
            // inputs back to the same shape so assertions stay clean.
            row[k] = String(v);
          } else {
            row[k] = v;
          }
        }
        return {
          ...row,
          project: { id: row.projectId, name: 'Test Project', code: 'TP-01' },
          raisedBy: { id: row.raisedById, name: 'Raiser', email: 'r@example.com' },
          approvedBy: null,
        };
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

describe('SOL DR-017 — variation PATCH omits projectId', () => {
  test('PATCH with editable fields only (no projectId) succeeds and applies the edit', async () => {
    seedVariation();
    const app = buildApp();

    const res = await request(app)
      .patch(`/api/variations/${VARIATION_ID}`)
      .set('Authorization', `Bearer ${authHeader()}`)
      .send({
        title: 'Edited title',
        description: 'Edited description',
        deltaAmount: 175000.5,
        clientApprovalRequired: false,
      });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Edited title');
    expect(res.body.description).toBe('Edited description');
    expect(res.body.clientApprovalRequired).toBe(false);
    // The Decimal serializes as a string on the wire.
    expect(String(res.body.deltaAmount)).toBe('175000.5');

    // The store was actually updated.
    expect(variations[VARIATION_ID].title).toBe('Edited title');
    expect(variations[VARIATION_ID].deltaAmount).toBe('175000.5');
    // projectId must NOT have moved (PATCH does not own it).
    expect(variations[VARIATION_ID].projectId).toBe(PROJECT_ID);
  });

  test('PATCH that smuggles projectId is rejected (immutable-identity contract)', async () => {
    // This is the audit's blocker 2 — the frontend fix removes
    // projectId from the PATCH payload, but if a client ever tried
    // to send it, the backend must refuse (400 UNKNOWN_FIELDS) so
    // the contract is enforced server-side too.
    seedVariation();
    const app = buildApp();

    const res = await request(app)
      .patch(`/api/variations/${VARIATION_ID}`)
      .set('Authorization', `Bearer ${authHeader()}`)
      .send({
        title: 'Attempted rebind',
        projectId: OTHER_PROJECT_ID,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('UNKNOWN_FIELDS');
    expect(res.body.fields).toContain('projectId');

    // The store was not updated — the attempt was rejected wholesale.
    expect(variations[VARIATION_ID].title).toBe('Original title');
    expect(variations[VARIATION_ID].projectId).toBe(PROJECT_ID);
  });

  test('PATCH with projectId-only payload is rejected (defense in depth)', async () => {
    // Even a payload that ONLY contains projectId (no other edits)
    // must be rejected — the immutable-identity gate is on field
    // membership, not on whether other fields are present.
    seedVariation();
    const app = buildApp();

    const res = await request(app)
      .patch(`/api/variations/${VARIATION_ID}`)
      .set('Authorization', `Bearer ${authHeader()}`)
      .send({ projectId: OTHER_PROJECT_ID });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('UNKNOWN_FIELDS');
    expect(variations[VARIATION_ID].projectId).toBe(PROJECT_ID);
  });

  test('PATCH by an admin also strips projectId from the editable contract', async () => {
    // Admins can edit drafts too — the audit's "rerouted project" risk
    // applies equally to admin clients. Pin the contract for both.
    seedVariation();
    const app = buildApp({ isAdmin: true, employeeId: OTHER_EMPLOYEE });

    const res = await request(app)
      .patch(`/api/variations/${VARIATION_ID}`)
      .set('Authorization', `Bearer ${authHeader(OTHER_EMPLOYEE)}`)
      .send({ title: 'Admin edit' });

    expect(res.status).toBe(200);
    expect(variations[VARIATION_ID].title).toBe('Admin edit');
    expect(variations[VARIATION_ID].projectId).toBe(PROJECT_ID);
  });

  test('PATCH rejects when status is terminal (SUBMITTED) — pre-existing invariant', async () => {
    // Pin a related invariant: a SUBMITTED variation is also
    // immutable through PATCH (the audit didn't change this; the
    // existing route returns 409 INVALID_TRANSITION for any non-DRAFT
    // row). Belt-and-braces so a future change to the allowlist
    // doesn't accidentally loosen the terminal-state lock.
    seedVariation({ status: 'SUBMITTED' });
    const app = buildApp();

    const res = await request(app)
      .patch(`/api/variations/${VARIATION_ID}`)
      .set('Authorization', `Bearer ${authHeader()}`)
      .send({ title: 'Should be rejected' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVALID_TRANSITION');
    expect(variations[VARIATION_ID].status).toBe('SUBMITTED');
    expect(variations[VARIATION_ID].title).toBe('Original title');
  });
});
