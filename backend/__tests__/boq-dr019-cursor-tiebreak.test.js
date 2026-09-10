/**
 * DR-019 (audit, 2026-09-08) — BOQ register cursor tie-break.
 *
 * The audit found two defects on the BOQ list:
 *
 *   1. Cursor skipped tied legacy rows. The previous wire format was
 *      base64url(JSON({ projectName, itemCode })). The seek predicate
 *      used `projectName > cursor.projectName OR (projectName = X AND
 *      itemCode > cursor.itemCode)` — a `gt` predicate that matched
 *      zero rows with the same (projectName, itemCode) as the cursor
 *      row. The 2024 legacy bulk import had duplicate itemCodes for a
 *      short window, so any project with N rows that shared the cursor
 *      row's (projectName, itemCode) silently dropped everything past
 *      page 1. The fix: add `id` as a third tie-breaker field in both
 *      the orderBy and the seek predicate.
 *
 *   2. Load more button was never rendered in BoqAdmin.jsx. The walker
 *      (`loadMoreItems`) existed but the JSX never called it. The fix
 *      is in BoqAdmin.jsx; this test pins the backend contract that
 *      powers it (nextCursor + hasMore = take+1 < rows.length).
 *
 *   3. Loose limit parser: `parseInt(limit) || 50` silently coerced 0,
 *      negatives, and non-finite strings to 50. The fix validates
 *      `parsedLimit > 0` before honouring it.
 *
 * Acceptance:
 *   - Pagination walks every row once, including tied duplicates.
 *   - A legacy 2-field cursor (no `id`) is rejected with 400.
 *   - `?limit=-5` and `?limit=0` are clamped to 50 (NOT 0 / negative).
 *   - `?limit=200` is clamped to LIST_MAX (100).
 *   - The orderBy includes `id` as a tie-breaker.
 */
'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';

// blobStorage pulls in @aws-sdk/client-s3 (ESM) — mock the surface.
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

const boqStore = new Map();
const EMPLOYEE_ID = 'emp-boq-dr019';

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

  const prisma = {
    project: {
      findUnique: jest.fn(async () => null),
      findFirst: jest.fn(async () => null),
    },
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
        // Real Prisma OR-clause evaluation — we honour the tie-break seek
        // by reproducing the where-clause shape exactly.
        if (where.OR && Array.isArray(where.OR)) {
          const orRows = where.OR.flatMap((branch) => {
            return rows.filter((r) => {
              return Object.entries(branch).every(([key, cond]) => {
                if (cond == null) return r[key] == null;
                if (typeof cond === 'object') {
                  if (cond.gt !== undefined && !(r[key] > cond.gt)) return false;
                  if (cond.gte !== undefined && !(r[key] >= cond.gte)) return false;
                  if (cond.lt !== undefined && !(r[key] < cond.lt)) return false;
                  if (cond.lte !== undefined && !(r[key] <= cond.lte)) return false;
                  return true;
                }
                return r[key] === cond;
              });
            });
          });
          // Deduplicate (a row can match multiple branches).
          const seen = new Set();
          rows = orRows.filter((r) => {
            if (seen.has(r.id)) return false;
            seen.add(r.id);
            return true;
          });
        }
        // OrderBy support — top-level fields + id tie-breaker.
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
    },
  };

  app.set('prisma', prisma);
  app.use('/api/boq', boqRouter);
  return { app, prisma };
}

function authHeader(employeeId = EMPLOYEE_ID) {
  const token = jwt.sign(
    { sub: employeeId, employeeId, isAdmin: false },
    process.env.JWT_SECRET,
    { expiresIn: '1h' },
  );
  return `Bearer ${token}`;
}

beforeEach(() => {
  boqStore.clear();
});

describe('DR-019 — BOQ cursor tie-break', () => {
  it('walks every row once, including tied legacy duplicates of (projectName, itemCode)', async () => {
    // Seed 5 rows that ALL share (projectName='Legacy Site', itemCode='2.3.1').
    // This is the legacy bulk-import shape that broke the previous cursor:
    // the `gt` seek matched zero of these from page 2 onward because
    // they're identical on the sort keys.
    const ids = [];
    for (let i = 0; i < 5; i += 1) {
      const row = seedBoq({
        id: `boq-legacy-${i}`,
        projectName: 'Legacy Site',
        itemCode: '2.3.1',
        description: `Duplicate #${i}`,
      });
      ids.push(row.id);
    }
    // Plus 3 distinct rows on a different itemCode so we can verify the
    // cursor still advances across (projectName, itemCode) boundaries.
    seedBoq({ id: 'boq-distinct-1', projectName: 'Legacy Site', itemCode: '3.1.1' });
    seedBoq({ id: 'boq-distinct-2', projectName: 'Legacy Site', itemCode: '3.1.2' });
    seedBoq({ id: 'boq-distinct-3', projectName: 'Legacy Site', itemCode: '3.1.3' });

    const { app } = buildApp();
    const seen = new Set();
    let cursor = null;
    let pages = 0;
    while (pages < 10) {
      pages += 1;
      const qs = new URLSearchParams({ projectName: 'Legacy Site', limit: '2' });
      if (cursor) qs.set('cursor', cursor);
      const res = await request(app)
        .get(`/api/boq?${qs.toString()}`)
        .set('Authorization', authHeader());
      expect(res.status).toBe(200);
      for (const it of res.body.items) {
        expect(seen.has(it.id)).toBe(false); // No duplicates across pages.
        seen.add(it.id);
      }
      if (!res.body.nextCursor) break;
      cursor = res.body.nextCursor;
    }
    // Every row must be visited exactly once. The previous cursor would
    // have stopped after the first page (or skipped the trailing duplicates).
    expect(seen.size).toBe(8);
    for (const id of ids) {
      expect(seen.has(id)).toBe(true);
    }
  });

  it('rejects legacy 2-field cursors (no `id`) with 400 INVALID_CURSOR', async () => {
    // Simulate a hand-crafted cursor from the previous codec shape.
    const legacy = Buffer.from(
      JSON.stringify({ projectName: 'Legacy Site', itemCode: '2.3.1' }),
      'utf8',
    ).toString('base64url');
    const { app } = buildApp();
    const res = await request(app)
      .get(`/api/boq?projectName=Legacy+Site&cursor=${encodeURIComponent(legacy)}`)
      .set('Authorization', authHeader());
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CURSOR');
  });

  it('clamps ?limit=-5 to 50 (does not return 0 rows or negative)', async () => {
    for (let i = 0; i < 60; i += 1) {
      seedBoq({ id: `boq-clamp-neg-${i}`, projectName: 'P', itemCode: `c-${i}` });
    }
    const { app } = buildApp();
    const res = await request(app)
      .get('/api/boq?projectName=P&limit=-5')
      .set('Authorization', authHeader());
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(50);
  });

  it('clamps ?limit=0 to 50', async () => {
    for (let i = 0; i < 60; i += 1) {
      seedBoq({ id: `boq-clamp-zero-${i}`, projectName: 'P', itemCode: `c-${i}` });
    }
    const { app } = buildApp();
    const res = await request(app)
      .get('/api/boq?projectName=P&limit=0')
      .set('Authorization', authHeader());
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(50);
  });

  it('clamps ?limit=200 to LIST_MAX (100)', async () => {
    for (let i = 0; i < 150; i += 1) {
      seedBoq({ id: `boq-clamp-max-${i}`, projectName: 'P', itemCode: `c-${i}` });
    }
    const { app } = buildApp();
    const res = await request(app)
      .get('/api/boq?projectName=P&limit=200')
      .set('Authorization', authHeader());
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(100);
    expect(res.body.nextCursor).toBeTruthy();
  });

  it('?limit=garbage falls back to 50', async () => {
    for (let i = 0; i < 60; i += 1) {
      seedBoq({ id: `boq-clamp-garbage-${i}`, projectName: 'P', itemCode: `c-${i}` });
    }
    const { app } = buildApp();
    const res = await request(app)
      .get('/api/boq?projectName=P&limit=garbage')
      .set('Authorization', authHeader());
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(50);
  });

  it('orderBy carries `id` as a tie-breaker (source-text pin)', async () => {
    const { app, prisma } = buildApp();
    seedBoq({ id: 'boq-pin-1', projectName: 'P', itemCode: 'x' });
    seedBoq({ id: 'boq-pin-2', projectName: 'P', itemCode: 'x' });
    await request(app)
      .get('/api/boq?projectName=P')
      .set('Authorization', authHeader());
    const lastCall = prisma.boqItem.findMany.mock.calls.at(-1)[0];
    const orderBy = lastCall.orderBy;
    expect(Array.isArray(orderBy)).toBe(true);
    // The 3rd sort key must be `id` so the cursor's tie-break works.
    expect(orderBy).toEqual([
      { projectName: 'asc' },
      { itemCode: 'asc' },
      { id: 'asc' },
    ]);
  });
});
