// ─────────────────────────────────────────────────────────────────────────────
// DR-015 (audit, 2026-09-08) — BOQ execution ledger
// ─────────────────────────────────────────────────────────────────────────────
//
// Coverage matrix (one assertion per row):
//
//   Auth gates:
//     1. POST   /api/boq/:boqItemId/executions without token    → 401
//     2. DELETE /api/boq/executions/:id          without token  → 401
//
//   Authorization (admin-only writes):
//     3. POST by a non-admin                                       → 403
//     4. DELETE by a non-admin                                     → 403
//
//   CRUD — POST:
//     5. POST happy path (admin, defaults)                         → 201,
//        executedQuantity echoed, accepted defaults to true,
//        stage defaults to INSTALLED, executedAt is set
//     6. POST with explicit stage=PAID + executedAt + accepted     → 201,
//        all three preserved
//     7. POST with executedQuantity=-1                             → 400
//     8. POST with stage=BOGUS                                     → 400
//     9. POST against a non-existent boqItemId                     → 404
//
//   List:
//     10. GET /:boqItemId/executions (auth)                        → 200,
//         rows ordered newest-first
//
//   Delete:
//     11. DELETE /executions/:id (admin)                           → 200,
//         subsequent GET no longer includes the row
//     12. DELETE non-existent id                                   → 404
//
//   Variance integration:
//     13. A 100-unit contract + one accepted INSTALLED row of 30 →
//         GET /api/boq/variance shows executedQty=30,
//         varianceQty=70. A separate accepted=false row is NOT
//         counted.
//     14. After DELETE the execution row, the variance row drops
//         back to executedQty=0.
//
// Notes on the test pattern
// -------------------------
// - Mirrors boq.test.js: prisma mock is a Map-backed module so the
//   unique / groupBy / findUnique calls resolve deterministically.
// - The migration is append-only — this test does not exercise the
//   SQL DDL (that's a `prisma migrate dev` job); it exercises the
//   backend route surface that the migration enables.
// - The /variance integration case uses the groupBy mock to return
//   the same numbers the live Prisma client would, so the route's
//   rewire to BoqExecution.groupBy is the contract being pinned.
//
// Run with:  cd backend && npm test -- --testPathPattern='boq-execution-dr015'

'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';

jest.mock('../src/lib/blobStorage', () => ({
  generateReadSASUrl: jest.fn(async () => ({ sasUrl: 'https://r2.example/sas', expiresAt: new Date().toISOString() })),
  generateUploadSASUrl: jest.fn(async () => ({ sasUrl: 'https://r2.example/put', blobPath: 'x', expiresAt: new Date().toISOString() })),
  generateULID: jest.fn(() => '01ARZ3NDEKTSV4RRFFQ69G5FAV'),
  verifyBlobExists: jest.fn(async () => ({ exists: true })),
  deleteBlob: jest.fn(async () => {}),
  CONTENT_TYPE_EXT: { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' },
}));

jest.mock('../src/lib/notify', () => ({
  fanOutEmail: jest.fn(async () => ({ sent: 0 })),
  fanOutToAdmins: jest.fn(async () => ({ sent: 0, skipped: 0, failed: 0 })),
}));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
require('express-async-errors');

const boqRouter = require('../src/routes/boq');

// ─── In-memory stores ──────────────────────────────────────────────────────
const boqStore = new Map();
const executionStore = new Map();
const employeeStore = new Map();

const EMPLOYEE_ID = 'emp-dr015-1';
const ADMIN_ID = 'emp-dr015-admin';

employeeStore.set(EMPLOYEE_ID, { id: EMPLOYEE_ID, email: 'emp@example.com', isAdmin: false });
employeeStore.set(ADMIN_ID, { id: ADMIN_ID, email: 'admin@example.com', isAdmin: true });

function seedBoq({
  id = `boq-${Math.random().toString(36).slice(2, 8)}`,
  projectName = 'Project Alpha',
  itemCode = '2.3.1',
  description = 'M30 RCC slab 100mm thick',
  unit = 'cum',
  quantity = 100,
  rate = 5000,
  amount = quantity * rate,
  isActive = true,
  createdById = EMPLOYEE_ID,
} = {}) {
  const row = {
    id, projectName, itemCode, description, unit, quantity, rate,
    amount, category: null, isActive, createdById,
    createdAt: new Date(), updatedAt: new Date(),
  };
  boqStore.set(id, row);
  return row;
}

function buildApp() {
  const app = express();
  app.use(express.json());

  const prisma = {
    boqItem: {
      findUnique: jest.fn(async ({ where }) => {
        if (!where || !where.id) return null;
        return boqStore.get(where.id) || null;
      }),
      findMany: jest.fn(async ({ where = {}, orderBy, take = 100 } = {}) => {
        let rows = [...boqStore.values()];
        if (where.projectName !== undefined) {
          rows = rows.filter((r) => r.projectName === where.projectName);
        }
        if (where.isActive !== undefined) {
          rows = rows.filter((r) => r.isActive === where.isActive);
        }
        if (orderBy) {
          const sorts = Array.isArray(orderBy) ? orderBy : [orderBy];
          rows.sort((a, b) => {
            for (const s of sorts) {
              const k = Object.keys(s)[0];
              const dir = s[k] === 'desc' ? -1 : 1;
              if (a[k] < b[k]) return -1 * dir;
              if (a[k] > b[k]) return 1 * dir;
            }
            return 0;
          });
        }
        return rows.slice(0, take);
      }),
      create: jest.fn(async ({ data }) => {
        return seedBoq({ ...data });
      }),
      update: jest.fn(async ({ where, data }) => {
        const row = boqStore.get(where.id);
        if (!row) {
          const err = new Error('Record not found');
          err.code = 'P2025';
          throw err;
        }
        Object.assign(row, data);
        if (data.updatedAt) row.updatedAt = data.updatedAt;
        return row;
      }),
    },
    boqExecution: {
      create: jest.fn(async ({ data, include }) => {
        const id = `exec-${Math.random().toString(36).slice(2, 8)}`;
        const row = {
          id,
          boqItemId: data.boqItemId,
          executedQuantity: data.executedQuantity,
          executedAt: data.executedAt || new Date(),
          stage: data.stage || 'INSTALLED',
          accepted: data.accepted !== undefined ? data.accepted : true,
          notes: data.notes || null,
          recordedById: data.recordedById,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        executionStore.set(id, row);
        const out = { ...row };
        if (include && include.recordedBy) {
          out.recordedBy = { id: row.recordedById, name: 'Recorder', email: 'r@example.com' };
        }
        return out;
      }),
      findMany: jest.fn(async ({ where = {}, orderBy, take = 200 } = {}) => {
        let rows = [...executionStore.values()];
        if (where.boqItemId !== undefined) {
          rows = rows.filter((r) => r.boqItemId === where.boqItemId);
        }
        if (orderBy) {
          const sorts = Array.isArray(orderBy) ? orderBy : [orderBy];
          rows.sort((a, b) => {
            for (const s of sorts) {
              const k = Object.keys(s)[0];
              const dir = s[k] === 'desc' ? -1 : 1;
              if (a[k] < b[k]) return -1 * dir;
              if (a[k] > b[k]) return 1 * dir;
            }
            return 0;
          });
        }
        return rows.slice(0, take).map((r) => ({ ...r, recordedBy: { id: r.recordedById, name: 'Recorder', email: 'r@example.com' } }));
      }),
      findUnique: jest.fn(async ({ where }) => {
        if (!where || !where.id) return null;
        return executionStore.get(where.id) || null;
      }),
      delete: jest.fn(async ({ where }) => {
        const row = executionStore.get(where.id);
        if (!row) {
          const err = new Error('Record not found');
          err.code = 'P2025';
          throw err;
        }
        executionStore.delete(where.id);
        return row;
      }),
      groupBy: jest.fn(async ({ where = {}, _sum } = {}) => {
        let rows = [...executionStore.values()];
        if (where.boqItemId !== undefined && where.boqItemId && typeof where.boqItemId === 'object' && 'in' in where.boqItemId) {
          rows = rows.filter((r) => where.boqItemId.in.includes(r.boqItemId));
        }
        if (where.accepted !== undefined) {
          rows = rows.filter((r) => r.accepted === where.accepted);
        }
        // groupBy by boqItemId
        const groups = new Map();
        for (const r of rows) {
          const g = groups.get(r.boqItemId) || { boqItemId: r.boqItemId, _sum: { executedQuantity: 0 } };
          g._sum.executedQuantity += Number(r.executedQuantity) || 0;
          groups.set(r.boqItemId, g);
        }
        return [...groups.values()];
      }),
    },
    employee: {
      findUnique: jest.fn(async ({ where }) => employeeStore.get(where.id) || null),
    },
  };

  app.set('prisma', prisma);
  app.use('/api/boq', boqRouter);
  app.use((err, req, res, next) => {
    res.status(err.status || 500).json({
      error: err.message || 'INTERNAL_ERROR',
      code: err.code || 'INTERNAL',
    });
  });
  return { app, prisma };
}

function authHeader(employeeId = EMPLOYEE_ID) {
  return `Bearer ${jwt.sign(
    { employeeId, email: 'emp@example.com' },
    process.env.JWT_SECRET,
    { expiresIn: '8h' },
  )}`;
}

beforeEach(() => {
  boqStore.clear();
  executionStore.clear();
});

// ─── Auth gates ─────────────────────────────────────────────────────────────

describe('DR-015 — auth gates', () => {
  it('rejects POST /api/boq/:id/executions without a token', async () => {
    const { app } = buildApp();
    const boq = seedBoq();
    const res = await request(app)
      .post(`/api/boq/${boq.id}/executions`)
      .send({ executedQuantity: 30 });
    expect(res.status).toBe(401);
  });

  it('rejects DELETE /api/boq/executions/:id without a token', async () => {
    const { app } = buildApp();
    const res = await request(app).delete('/api/boq/executions/some-id');
    expect(res.status).toBe(401);
  });
});

// ─── Authorization ──────────────────────────────────────────────────────────

describe('DR-015 — admin-only writes', () => {
  it('rejects POST by a non-admin', async () => {
    const { app } = buildApp();
    const boq = seedBoq();
    const res = await request(app)
      .post(`/api/boq/${boq.id}/executions`)
      .set('Authorization', authHeader(EMPLOYEE_ID))
      .send({ executedQuantity: 30 });
    expect(res.status).toBe(403);
  });

  it('rejects DELETE by a non-admin', async () => {
    const { app } = buildApp();
    const boq = seedBoq();
    const created = await request(app)
      .post(`/api/boq/${boq.id}/executions`)
      .set('Authorization', authHeader(ADMIN_ID))
      .send({ executedQuantity: 10 });
    const execId = created.body.id;

    const res = await request(app)
      .delete(`/api/boq/executions/${execId}`)
      .set('Authorization', authHeader(EMPLOYEE_ID));
    expect(res.status).toBe(403);
  });
});

// ─── POST happy path + validation ──────────────────────────────────────────

describe('DR-015 — POST /api/boq/:id/executions', () => {
  it('creates a row with defaults (accepted=true, stage=INSTALLED)', async () => {
    const { app } = buildApp();
    const boq = seedBoq();
    const res = await request(app)
      .post(`/api/boq/${boq.id}/executions`)
      .set('Authorization', authHeader(ADMIN_ID))
      .send({ executedQuantity: 30 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      boqItemId: boq.id,
      executedQuantity: 30,
      stage: 'INSTALLED',
      accepted: true,
      recordedById: ADMIN_ID,
    });
    expect(res.body.executedAt).toBeTruthy();
    expect(res.body.recordedBy).toMatchObject({ id: ADMIN_ID });
  });

  it('preserves explicit stage + executedAt + accepted=false', async () => {
    const { app } = buildApp();
    const boq = seedBoq();
    const when = '2026-08-01T10:00:00.000Z';
    const res = await request(app)
      .post(`/api/boq/${boq.id}/executions`)
      .set('Authorization', authHeader(ADMIN_ID))
      .send({ executedQuantity: 12.5, stage: 'PAID', executedAt: when, accepted: false, notes: 'RAB-05' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      stage: 'PAID',
      accepted: false,
      notes: 'RAB-05',
    });
    expect(new Date(res.body.executedAt).toISOString()).toBe(when);
  });

  it('rejects a negative executedQuantity', async () => {
    const { app } = buildApp();
    const boq = seedBoq();
    const res = await request(app)
      .post(`/api/boq/${boq.id}/executions`)
      .set('Authorization', authHeader(ADMIN_ID))
      .send({ executedQuantity: -1 });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown stage value', async () => {
    const { app } = buildApp();
    const boq = seedBoq();
    const res = await request(app)
      .post(`/api/boq/${boq.id}/executions`)
      .set('Authorization', authHeader(ADMIN_ID))
      .send({ executedQuantity: 5, stage: 'BOGUS' });
    expect(res.status).toBe(400);
  });

  it('returns 404 for a non-existent boqItemId', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/boq/does-not-exist/executions')
      .set('Authorization', authHeader(ADMIN_ID))
      .send({ executedQuantity: 5 });
    expect(res.status).toBe(404);
  });
});

// ─── GET executions ─────────────────────────────────────────────────────────

describe('DR-015 — GET /api/boq/:id/executions', () => {
  it('lists executions for the item, newest first', async () => {
    const { app } = buildApp();
    const boq = seedBoq();
    // Two accepted INSTALLED events at different times
    const older = await request(app)
      .post(`/api/boq/${boq.id}/executions`)
      .set('Authorization', authHeader(ADMIN_ID))
      .send({ executedQuantity: 10, executedAt: '2026-07-01T00:00:00.000Z' });
    const newer = await request(app)
      .post(`/api/boq/${boq.id}/executions`)
      .set('Authorization', authHeader(ADMIN_ID))
      .send({ executedQuantity: 20, executedAt: '2026-09-01T00:00:00.000Z' });

    const res = await request(app)
      .get(`/api/boq/${boq.id}/executions`)
      .set('Authorization', authHeader(EMPLOYEE_ID));
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0].id).toBe(newer.body.id);
    expect(res.body.items[1].id).toBe(older.body.id);
  });

  it('returns 404 for a non-existent boqItemId', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .get('/api/boq/does-not-exist/executions')
      .set('Authorization', authHeader(EMPLOYEE_ID));
    expect(res.status).toBe(404);
  });
});

// ─── DELETE execution ───────────────────────────────────────────────────────

describe('DR-015 — DELETE /api/boq/executions/:id', () => {
  it('hard-deletes the row and removes it from subsequent lists', async () => {
    const { app } = buildApp();
    const boq = seedBoq();
    const created = await request(app)
      .post(`/api/boq/${boq.id}/executions`)
      .set('Authorization', authHeader(ADMIN_ID))
      .send({ executedQuantity: 7 });
    const execId = created.body.id;

    const del = await request(app)
      .delete(`/api/boq/executions/${execId}`)
      .set('Authorization', authHeader(ADMIN_ID));
    expect(del.status).toBe(200);
    expect(del.body).toMatchObject({ id: execId, deleted: true });

    const list = await request(app)
      .get(`/api/boq/${boq.id}/executions`)
      .set('Authorization', authHeader(ADMIN_ID));
    expect(list.body.items).toHaveLength(0);
  });

  it('returns 404 for a non-existent execution id', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .delete('/api/boq/executions/does-not-exist')
      .set('Authorization', authHeader(ADMIN_ID));
    expect(res.status).toBe(404);
  });
});

// ─── Variance integration ───────────────────────────────────────────────────

describe('DR-015 — variance sums accepted executions', () => {
  it('a 100-unit contract + 30 accepted units shows 30 executed / 70 remaining; accepted=false rows ignored', async () => {
    const { app } = buildApp();
    const item = seedBoq({ projectName: 'Project Alpha', itemCode: '2.3.1', quantity: 100, rate: 5000 });

    // Two events on item1: 30 accepted (contributes) + 15 NOT accepted (ignored).
    await request(app)
      .post(`/api/boq/${item.id}/executions`)
      .set('Authorization', authHeader(ADMIN_ID))
      .send({ executedQuantity: 30, accepted: true });
    await request(app)
      .post(`/api/boq/${item.id}/executions`)
      .set('Authorization', authHeader(ADMIN_ID))
      .send({ executedQuantity: 15, accepted: false });

    const res = await request(app)
      .get('/api/boq/variance')
      .query({ projectName: 'Project Alpha' })
      .set('Authorization', authHeader(EMPLOYEE_ID));
    expect(res.status).toBe(200);
    const row = res.body.items.find((i) => i.id === item.id);
    expect(row).toMatchObject({
      contractQty: 100,
      executedQty: 30,
      varianceQty: 70,
    });
  });

  it('after deleting the accepted execution, variance drops back to 0 / 100', async () => {
    const { app } = buildApp();
    const item = seedBoq({ projectName: 'Project Alpha', quantity: 100, rate: 5000 });
    const created = await request(app)
      .post(`/api/boq/${item.id}/executions`)
      .set('Authorization', authHeader(ADMIN_ID))
      .send({ executedQuantity: 30, accepted: true });

    await request(app)
      .delete(`/api/boq/executions/${created.body.id}`)
      .set('Authorization', authHeader(ADMIN_ID));

    const res = await request(app)
      .get('/api/boq/variance')
      .query({ projectName: 'Project Alpha' })
      .set('Authorization', authHeader(EMPLOYEE_ID));
    const row = res.body.items.find((i) => i.id === item.id);
    expect(row).toMatchObject({
      executedQty: 0,
      varianceQty: 100,
    });
  });
});
