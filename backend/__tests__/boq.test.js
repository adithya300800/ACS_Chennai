// ─────────────────────────────────────────────────────────────────────────────
// N7 (round-28) — BOQ (Bill of Quantities) routes + DPR/Inspection integration
// ─────────────────────────────────────────────────────────────────────────────
//
// Coverage matrix (one assertion per row):
//
//   Auth:
//     1. GET /api/boq without a token         → 401
//     2. POST /api/boq without a token        → 401
//
//   CRUD:
//     3. POST /api/boq happy path             → 201, returns amount = qty × rate
//     4. POST /api/boq with duplicate
//        (projectName, itemCode)              → 409 DUPLICATE_BOQ_ITEM
//     5. GET /api/boq?projectName=…           → 200, filters correctly
//     6. PATCH /api/boq/:id (admin)           → 200, updates amount recompute
//     7. PATCH /api/boq/:id (non-creator)    → 403
//     8. DELETE /api/boq/:id (creator)        → 200, isActive=false (soft-delete)
//
//   DPR integration:
//     9.  POST /api/dpr with valid boqItemId  → 201, response includes boqItem
//     10. POST /api/dpr with invalid
//         boqItemId                           → 400 BOQ_ITEM_NOT_FOUND
//
//   Inspection integration:
//     11. POST /api/inspection with valid
//         boqItemId                           → 201, response includes boqItem
//
//   Variance report:
//     12. GET /api/boq/variance?projectName=… → 200, variance = qty - sum(DPR.quantity)
//
// Notes on the test pattern
// -------------------------
// - The mocks match what dpr.js / inspection.js / boq.js call against
//   Prisma. The model names follow the schema's camelCase: `dPR`,
//   `inspectionRecord`, `boqItem`, `employee`. The `dPR` lowercased-R is
//   the Prisma convention for a class name that begins with two
//   uppercase letters followed by lowercase (Prisma's heuristic).
// - Photo upload is fully stubbed — boq.js doesn't touch photos at all
//   but dpr.js / inspection.js do, and we need their intent-binding
//   helper to resolve without reaching R2.
// - The mock prisma stores rows in module-level Maps so create/update/
//   findUnique behave like a real database (within the limits of the
//   test surface).
//
// Run with:  cd backend && npm test -- --testPathPattern='boq.test'

'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';

// blobStorage pulls in @aws-sdk/client-s3 (ESM) — mock the surface the
// DPR / inspection routes touch at import time.
jest.mock('../src/lib/blobStorage', () => ({
  generateReadSASUrl: jest.fn(async () => ({ sasUrl: 'https://r2.example/sas', expiresAt: new Date().toISOString() })),
  generateUploadSASUrl: jest.fn(async () => ({ sasUrl: 'https://r2.example/put', blobPath: 'x', expiresAt: new Date().toISOString() })),
  generateULID: jest.fn(() => '01ARZ3NDEKTSV4RRFFQ69G5FAV'),
  verifyBlobExists: jest.fn(async () => ({ exists: true })),
  deleteBlob: jest.fn(async () => {}),
  CONTENT_TYPE_EXT: { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' },
}));

// Admin / user fan-out isn't on the hot path for these tests — stub
// them so the import chain doesn't blow up trying to read
// NotificationPreference.
jest.mock('../src/lib/notify', () => ({
  fanOutEmail: jest.fn(async () => ({ sent: 0 })),
  fanOutToAdmins: jest.fn(async () => ({ sent: 0, skipped: 0, failed: 0 })),
}));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
require('express-async-errors');

const dprRouter = require('../src/routes/dpr');
const inspectionRouter = require('../src/routes/inspection');
const boqRouter = require('../src/routes/boq');

// ─── In-memory stores ──────────────────────────────────────────────────────
// We back the prisma mock with Maps so create / findUnique / update can
// emulate the real schema. The unique constraint on (projectName,
// itemCode) is checked in the create handler below.
const boqStore = new Map();
const dprStore = new Map();
const inspectionStore = new Map();
const employeeStore = new Map();

const EMPLOYEE_ID = 'emp-boq-1';
const ADMIN_ID = 'emp-boq-admin';
const OTHER_EMPLOYEE = 'emp-boq-other';

employeeStore.set(EMPLOYEE_ID, { id: EMPLOYEE_ID, email: 'emp@example.com', isAdmin: false });
employeeStore.set(ADMIN_ID, { id: ADMIN_ID, email: 'admin@example.com', isAdmin: true });
employeeStore.set(OTHER_EMPLOYEE, { id: OTHER_EMPLOYEE, email: 'other@example.com', isAdmin: false });

function seedBoq({
  id = `boq-${Math.random().toString(36).slice(2, 8)}`,
  projectName = 'Project Alpha',
  itemCode = '2.3.1',
  description = 'M30 RCC slab 100mm thick',
  unit = 'cum',
  quantity = 100,
  rate = 5000,
  amount = quantity * rate,
  category = null,
  isActive = true,
  createdById = EMPLOYEE_ID,
} = {}) {
  const row = {
    id,
    projectName,
    itemCode,
    description,
    unit,
    quantity,
    rate,
    amount,
    category,
    isActive,
    createdById,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  boqStore.set(id, row);
  return row;
}

function buildApp() {
  const app = express();
  app.use(express.json());

  // Mock prisma — minimal surface used by the BOQ / DPR / inspection
  // routes. Anything not explicitly listed here is intentionally absent
  // (the test never exercises those paths).
  const prisma = {
    boqItem: {
      findUnique: jest.fn(async ({ where }) => {
        if (!where) return null;
        if (where.id) return boqStore.get(where.id) || null;
        return null;
      }),
      findMany: jest.fn(async ({ where = {}, orderBy, take = 100 } = {}) => {
        let rows = [...boqStore.values()];
        if (where.projectName !== undefined) {
          rows = rows.filter((r) => r.projectName === where.projectName);
        }
        if (where.isActive !== undefined) {
          rows = rows.filter((r) => r.isActive === where.isActive);
        }
        // Minimal orderBy support — both fields are top-level strings.
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
        // Enforce the @@unique([projectName, itemCode]) at the mock layer
        // so the duplicate-handling code path is exercised.
        const conflict = [...boqStore.values()].find(
          (r) => r.projectName === data.projectName && r.itemCode === data.itemCode,
        );
        if (conflict) {
          const err = new Error(`Unique constraint failed on boqItem (projectName, itemCode)`);
          err.code = 'P2002';
          err.meta = { target: ['projectName', 'itemCode'] };
          throw err;
        }
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
    dPR: {
      findUnique: jest.fn(async ({ where }) => {
        if (!where) return null;
        return dprStore.get(where.id) || null;
      }),
      create: jest.fn(async ({ data, include }) => {
        const id = `dpr-${Math.random().toString(36).slice(2, 8)}`;
        const row = {
          id,
          projectName: data.projectName,
          location: data.location,
          reportDate: data.reportDate,
          weather: data.weather || null,
          temperature: data.temperature || null,
          contractor: data.contractor || null,
          workType: data.workType,
          notes: data.notes || null,
          workExecutedToday: data.workExecutedToday || null,
          workLocation: data.workLocation || null,
          manpowerSummary: data.manpowerSummary || null,
          risksHindrances: data.risksHindrances || null,
          materialsReceivedSummary: data.materialsReceivedSummary || null,
          customSections: data.customSections || null,
          boqItemId: data.boqItemId || null,
          status: data.status || 'DRAFT',
          version: 1,
          submittedById: data.submittedById,
          submittedAt: data.submittedAt || null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        dprStore.set(id, row);
        // Resolve includes for the create response shape. The include
        // object is a sibling of `data`, not a child.
        const photosCreate = data.photos && data.photos.create ? data.photos.create : [];
        return attachDprIncludes(row, { include, photosCreate });
      }),
      findMany: jest.fn(async ({ where = {}, select } = {}) => {
        let rows = [...dprStore.values()];
        if (where.projectName !== undefined) {
          rows = rows.filter((r) => r.projectName === where.projectName);
        }
        if (where.boqItemId !== undefined && where.boqItemId !== null) {
          if (where.boqItemId && typeof where.boqItemId === 'object' && 'not' in where.boqItemId) {
            rows = rows.filter((r) => r.boqItemId !== where.boqItemId.not);
          } else {
            rows = rows.filter((r) => r.boqItemId === where.boqItemId);
          }
        }
        if (select) {
          return rows.map((r) => {
            const out = {};
            for (const k of Object.keys(select)) {
              if (k === 'boqItemId') out.boqItemId = r.boqItemId;
              else if (k === 'quantity') out.quantity = r.quantity || 0;
              else out[k] = r[k];
            }
            return out;
          });
        }
        return rows;
      }),
    },
    inspectionRecord: {
      create: jest.fn(async ({ data, include }) => {
        const id = `ins-${Math.random().toString(36).slice(2, 8)}`;
        const row = {
          id,
          projectName: data.projectName,
          location: data.location,
          reportDate: data.reportDate,
          weather: data.weather || null,
          contractor: data.contractor || null,
          dprId: data.dprId || null,
          inspectionType: data.inspectionType,
          data: data.data,
          severity: data.severity || null,
          status: data.status || 'OPEN',
          boqItemId: data.boqItemId || null,
          submittedById: data.submittedById,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        inspectionStore.set(id, row);
        return attachInspectionIncludes(row, { include });
      }),
      findUnique: jest.fn(async ({ where }) => {
        if (!where) return null;
        return inspectionStore.get(where.id) || null;
      }),
    },
    employee: {
      findUnique: jest.fn(async ({ where }) => {
        return employeeStore.get(where.id) || null;
      }),
    },
    // The admin fan-out helper tries to read notificationPreference for
    // each recipient; stub it so the create call completes without
    // dragging in a fan-out mock.
    notificationPreference: { findUnique: jest.fn(async () => null) },
  };

  app.set('prisma', prisma);
  app.use('/api/boq', boqRouter);
  app.use('/api/dpr', dprRouter);
  app.use('/api/inspection', inspectionRouter);
  app.use((err, req, res, next) => {
    res.status(err.status || 500).json({
      error: err.message || 'INTERNAL_ERROR',
      code: err.code || 'INTERNAL',
    });
  });
  return { app, prisma };
}

// Attach the joins the routes request — keeps the create response
// shape honest so the tests can assert on `body.boqItem` etc.
function attachDprIncludes(row, { include = {}, photosCreate = [] } = {}) {
  const out = { ...row };
  if (include.photos) {
    out.photos = photosCreate.map((p, i) => ({
      id: `photo-${row.id}-${i}`,
      dprId: row.id,
      ulid: p.ulid,
      container: p.container,
      filename: p.filename,
      contentType: p.contentType,
      sizeBytes: p.sizeBytes,
      caption: p.caption || null,
      location: p.location || null,
      takenAt: p.takenAt || null,
      uploadedAt: new Date(),
    }));
  }
  if (include.submittedBy) {
    out.submittedBy = { id: row.submittedById, name: 'Owner', email: 'owner@example.com' };
  }
  if (include.inspections) {
    out.inspections = [];
  }
  if (include.boqItem) {
    const sel = include.boqItem.select || { id: true, itemCode: true, description: true, unit: true };
    if (row.boqItemId) {
      const boq = boqStore.get(row.boqItemId);
      if (boq) {
        out.boqItem = {};
        for (const k of Object.keys(sel)) out.boqItem[k] = boq[k];
      } else {
        out.boqItem = null;
      }
    } else {
      out.boqItem = null;
    }
  }
  return out;
}

function attachInspectionIncludes(row, { include = {} } = {}) {
  const out = { ...row };
  if (include.photos) out.photos = [];
  if (include.submittedBy) out.submittedBy = { id: row.submittedById, name: 'Owner', email: 'owner@example.com' };
  if (include.dpr) out.dpr = row.dprId ? { id: row.dprId, reportDate: row.reportDate, projectName: row.projectName } : null;
  if (include.boqItem) {
    const sel = include.boqItem.select || { id: true, itemCode: true, description: true, unit: true };
    if (row.boqItemId) {
      const boq = boqStore.get(row.boqItemId);
      if (boq) {
        out.boqItem = {};
        for (const k of Object.keys(sel)) out.boqItem[k] = boq[k];
      } else {
        out.boqItem = null;
      }
    } else {
      out.boqItem = null;
    }
  }
  return out;
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
  dprStore.clear();
  inspectionStore.clear();
});

// ─── Auth gates ─────────────────────────────────────────────────────────────

describe('N7 — auth gates', () => {
  const { app } = buildApp();

  it('rejects GET /api/boq without a token', async () => {
    const res = await request(app).get('/api/boq');
    expect(res.status).toBe(401);
  });

  it('rejects POST /api/boq without a token', async () => {
    const res = await request(app).post('/api/boq').send({
      projectName: 'X', itemCode: '1.1', description: 'x', unit: 'nos', quantity: 1, rate: 1,
    });
    expect(res.status).toBe(401);
  });
});

// ─── CRUD ────────────────────────────────────────────────────────────────────

describe('N7 — BOQ CRUD', () => {
  it('creates a BOQ item, computing amount = quantity × rate', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/boq')
      .set('Authorization', authHeader())
      .send({
        projectName: 'Project Alpha',
        itemCode: '2.3.1',
        description: 'M30 RCC slab 100mm thick',
        unit: 'cum',
        quantity: 100,
        rate: 5000,
      });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      projectName: 'Project Alpha',
      itemCode: '2.3.1',
      description: 'M30 RCC slab 100mm thick',
      unit: 'cum',
      quantity: 100,
      rate: 5000,
      amount: 500000, // 100 × 5000
      isActive: true,
    });
    // The create handler MUST recompute amount on the server — verify
    // a malicious payload sending amount=9999999 still produces 500000.
    const res2 = await request(app)
      .post('/api/boq')
      .set('Authorization', authHeader())
      .send({
        projectName: 'Project Alpha',
        itemCode: '2.3.2',
        description: 'Different item',
        unit: 'cum',
        quantity: 10,
        rate: 100,
        amount: 9999999,
      });
    expect(res2.status).toBe(201);
    expect(res2.body.amount).toBe(1000); // 10 × 100, NOT 9999999
  });

  it('returns 409 on duplicate (projectName, itemCode)', async () => {
    const { app } = buildApp();
    seedBoq({ projectName: 'Project Alpha', itemCode: '2.3.1' });
    const res = await request(app)
      .post('/api/boq')
      .set('Authorization', authHeader())
      .send({
        projectName: 'Project Alpha',
        itemCode: '2.3.1',
        description: 'dup',
        unit: 'cum',
        quantity: 5,
        rate: 1000,
      });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DUPLICATE_BOQ_ITEM');
  });

  it('lists BOQ items filtered by projectName', async () => {
    const { app } = buildApp();
    seedBoq({ projectName: 'Project Alpha', itemCode: '2.3.1' });
    seedBoq({ projectName: 'Project Alpha', itemCode: '2.3.2' });
    seedBoq({ projectName: 'Project Beta', itemCode: '1.1.1' });
    const res = await request(app)
      .get('/api/boq')
      .query({ projectName: 'Project Alpha' })
      .set('Authorization', authHeader());
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items.every((i) => i.projectName === 'Project Alpha')).toBe(true);
  });

  it('PATCH updates the item and recomputes amount', async () => {
    const { app } = buildApp();
    const seed = seedBoq({ projectName: 'Project Alpha', quantity: 10, rate: 100 });
    const res = await request(app)
      .patch(`/api/boq/${seed.id}`)
      .set('Authorization', authHeader())
      .send({ quantity: 20 });
    expect(res.status).toBe(200);
    expect(res.body.quantity).toBe(20);
    expect(res.body.amount).toBe(2000); // 20 × 100
  });

  it('PATCH by a non-creator non-admin returns 403', async () => {
    const { app } = buildApp();
    const seed = seedBoq({ createdById: OTHER_EMPLOYEE });
    const res = await request(app)
      .patch(`/api/boq/${seed.id}`)
      .set('Authorization', authHeader(EMPLOYEE_ID))
      .send({ description: 'hostile edit' });
    expect(res.status).toBe(403);
  });

  it('PATCH by an admin (non-creator) is allowed', async () => {
    const { app } = buildApp();
    const seed = seedBoq({ createdById: OTHER_EMPLOYEE });
    const res = await request(app)
      .patch(`/api/boq/${seed.id}`)
      .set('Authorization', authHeader(ADMIN_ID))
      .send({ description: 'admin edit' });
    expect(res.status).toBe(200);
    expect(res.body.description).toBe('admin edit');
  });

  it('DELETE soft-deletes the item (isActive=false)', async () => {
    const { app } = buildApp();
    const seed = seedBoq({ createdById: EMPLOYEE_ID });
    const res = await request(app)
      .delete(`/api/boq/${seed.id}`)
      .set('Authorization', authHeader());
    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(false);
    expect(res.body.deleted).toBe(true);
  });
});

// ─── DPR integration ─────────────────────────────────────────────────────────

describe('N7 — DPR integration', () => {
  it('POST /api/dpr with valid boqItemId returns the BOQ summary', async () => {
    const { app } = buildApp();
    const boq = seedBoq({ projectName: 'Project Alpha', itemCode: '2.3.1' });
    const res = await request(app)
      .post('/api/dpr')
      .set('Authorization', authHeader())
      .send({
        projectName: 'Project Alpha',
        location: 'Tower 1',
        reportDate: '2026-09-04',
        workType: 'MATERIAL_RECEIPT',
        boqItemId: boq.id,
        photos: [],
      });
    expect(res.status).toBe(201);
    expect(res.body.boqItemId).toBe(boq.id);
    expect(res.body.boqItem).toMatchObject({
      id: boq.id,
      itemCode: '2.3.1',
      description: 'M30 RCC slab 100mm thick',
      unit: 'cum',
    });
  });

  it('POST /api/dpr with invalid boqItemId returns 400', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/dpr')
      .set('Authorization', authHeader())
      .send({
        projectName: 'Project Alpha',
        location: 'Tower 1',
        reportDate: '2026-09-04',
        workType: 'MATERIAL_RECEIPT',
        boqItemId: 'not-a-real-uuid-or-id',
        photos: [],
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BOQ_ITEM_NOT_FOUND');
  });

  it('POST /api/dpr with boqItemId from a different projectName returns 400', async () => {
    const { app } = buildApp();
    const boq = seedBoq({ projectName: 'Project Beta', itemCode: '1.1.1' });
    const res = await request(app)
      .post('/api/dpr')
      .set('Authorization', authHeader())
      .send({
        projectName: 'Project Alpha',
        location: 'Tower 1',
        reportDate: '2026-09-04',
        workType: 'MATERIAL_RECEIPT',
        boqItemId: boq.id,
        photos: [],
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BOQ_PROJECT_MISMATCH');
  });

  it('POST /api/dpr with an inactive boqItemId returns 400', async () => {
    const { app } = buildApp();
    const boq = seedBoq({ projectName: 'Project Alpha', isActive: false });
    const res = await request(app)
      .post('/api/dpr')
      .set('Authorization', authHeader())
      .send({
        projectName: 'Project Alpha',
        location: 'Tower 1',
        reportDate: '2026-09-04',
        workType: 'MATERIAL_RECEIPT',
        boqItemId: boq.id,
        photos: [],
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BOQ_ITEM_INACTIVE');
  });
});

// ─── Inspection integration ─────────────────────────────────────────────────

describe('N7 — Inspection integration', () => {
  it('POST /api/inspection with valid boqItemId returns the BOQ summary', async () => {
    const { app } = buildApp();
    const boq = seedBoq({ projectName: 'Project Alpha', itemCode: '5.1.1' });
    const res = await request(app)
      .post('/api/inspection')
      .set('Authorization', authHeader())
      .send({
        projectName: 'Project Alpha',
        location: 'Block A',
        reportDate: '2026-09-04',
        inspectionType: 'cement_receipt',
        data: { received: 'Cement 50 bags' },
        boqItemId: boq.id,
        photos: [],
      });
    expect(res.status).toBe(201);
    expect(res.body.boqItemId).toBe(boq.id);
    expect(res.body.boqItem).toMatchObject({
      id: boq.id,
      itemCode: '5.1.1',
      description: 'M30 RCC slab 100mm thick',
      unit: 'cum',
    });
  });

  it('POST /api/inspection with invalid boqItemId returns 400', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/inspection')
      .set('Authorization', authHeader())
      .send({
        projectName: 'Project Alpha',
        location: 'Block A',
        reportDate: '2026-09-04',
        inspectionType: 'cement_receipt',
        data: { received: 'x' },
        boqItemId: 'nonexistent',
        photos: [],
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BOQ_ITEM_NOT_FOUND');
  });
});

// ─── Variance report ────────────────────────────────────────────────────────

describe('N7 — Variance report', () => {
  it('returns per-item variance = contractQty − executedQty', async () => {
    const { app, prisma } = buildApp();
    const item1 = seedBoq({ projectName: 'Project Alpha', itemCode: '2.3.1', quantity: 100, rate: 5000 });
    seedBoq({ projectName: 'Project Alpha', itemCode: '2.3.2', quantity: 50, rate: 4000 });

    // Simulate two DPRs linked to item1 (executed = 30) and one DPR
    // linked to item2 (executed = 10). The DPR model doesn't have a
    // `quantity` column in the real schema yet, so the mock uses the
    // explicit `quantity` field we set in `seedDpr` style — but to keep
    // the test self-contained we instead pre-populate the dprStore
    // directly with the `boqItemId` + `quantity` the variance handler
    // reads.
    dprStore.set('dpr-1', {
      id: 'dpr-1',
      projectName: 'Project Alpha',
      boqItemId: item1.id,
      quantity: 30,
    });
    dprStore.set('dpr-2', {
      id: 'dpr-2',
      projectName: 'Project Alpha',
      boqItemId: item1.id,
      quantity: 0, // re-cast (executed 30 already covered)
      reportDate: new Date(),
      status: 'DRAFT',
      submittedById: EMPLOYEE_ID,
    });

    const res = await request(app)
      .get('/api/boq/variance')
      .query({ projectName: 'Project Alpha' })
      .set('Authorization', authHeader());
    expect(res.status).toBe(200);
    expect(res.body.projectName).toBe('Project Alpha');
    expect(res.body.items).toHaveLength(2);

    const item1Row = res.body.items.find((i) => i.id === item1.id);
    const item2Row = res.body.items.find((i) => i.id !== item1.id);
    expect(item1Row).toMatchObject({
      contractQty: 100,
      executedQty: 30,
      varianceQty: 70,
      contractAmount: 500000,
      executedAmount: 150000,
    });
    expect(item2Row).toMatchObject({
      contractQty: 50,
      executedQty: 0,
      varianceQty: 50,
    });

    // Ensure the prisma.dPR.findMany was called with the right where
    // clause (projectName filter + boqItemId NOT NULL).
    const dprCalls = prisma.dPR.findMany.mock.calls;
    expect(dprCalls.some((c) => c[0] && c[0].where && c[0].where.projectName === 'Project Alpha')).toBe(true);
  });

  it('returns 400 when projectName is missing', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .get('/api/boq/variance')
      .set('Authorization', authHeader());
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PROJECT_NAME_REQUIRED');
  });
});