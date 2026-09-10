/**
 * DR-019 (audit, 2026-09-08) — Variation Order same-day pagination.
 *
 * The audit caught that the VO list used the shared date-only cursor
 * codec (`encodeCursor` / `decodeCursor`), which truncates `createdAt`
 * to UTC midnight. The seek predicate `createdAt < cursor.date` then
 * matched nothing on the same day past midnight, and `createdAt =
 * cursor.date, id < cursor.id` matched only same-instant rows. Result:
 * a project with 21 same-day VOs only returned the first page; every
 * later row had `createdAt > cursor.date (midnight)` AND `createdAt !=
 * cursor.date (midnight)`, invisible to the seek.
 *
 * Fix: route uses `encodeInstantCursor` / `decodeInstantCursor` so the
 * cursor carries the exact sub-day timestamp + id forward.
 *
 * Acceptance:
 *   - 21 same-day VOs are walked across multiple pages without skips.
 *   - The cursor encodes the sub-day instant (not just the calendar day).
 *   - A legacy date-only cursor is rejected as INVALID_CURSOR.
 *   - 21 same-instant VOs (ties) walk via the id tie-breaker.
 */
'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

const variationsRouter = require('../src/routes/variations');

const EMPLOYEE_ID = 'emp-dr019-same-day';
const PROJECT_ID = '7c8d3f1a-1234-4abc-9def-02468ace0100';

let variations = {};

function seedVariation({
  id,
  projectId = PROJECT_ID,
  raisedById = EMPLOYEE_ID,
  status = 'DRAFT',
  title = 'Same-day VO',
  description = '',
  deltaAmount = '150000',
  clientApprovalRequired = true,
  version = 0,
  createdAt = new Date('2026-09-08T00:00:00.000Z'),
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
    createdAt,
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
        return {
          ...row,
          project: { id: row.projectId, name: 'Test Project', code: 'TP-01' },
          raisedBy: { id: row.raisedById, name: 'Raiser', email: 'r@example.com' },
          approvedBy: row.approvedById ? {
            id: row.approvedById, name: 'Approver', email: 'a@example.com',
          } : null,
        };
      },
      // findMany with real WHERE evaluation — honours the date+id seek
      // shape that the new instant codec produces. Order is
      // (createdAt DESC, id DESC) so a paginated walk visits newest
      // first.
      findMany: async ({ where = {}, orderBy, take = 50 } = {}) => {
        let rows = Object.values(variations);
        if (where.status !== undefined) {
          rows = rows.filter((r) => r.status === where.status);
        }
        if (where.projectId !== undefined) {
          rows = rows.filter((r) => r.projectId === where.projectId);
        }
        if (where.createdAt && typeof where.createdAt === 'object') {
          if (where.createdAt.gte) {
            const gte = where.createdAt.gte instanceof Date ? where.createdAt.gte.getTime() : where.createdAt.gte;
            rows = rows.filter((r) => r.createdAt.getTime() >= gte);
          }
          if (where.createdAt.lt) {
            const lt = where.createdAt.lt instanceof Date ? where.createdAt.lt.getTime() : where.createdAt.lt;
            rows = rows.filter((r) => r.createdAt.getTime() < lt);
          }
        }
        if (where.OR && Array.isArray(where.OR)) {
          const orRows = where.OR.flatMap((branch) => {
            return rows.filter((r) => {
              return Object.entries(branch).every(([key, cond]) => {
                if (cond == null) return r[key] == null;
                if (typeof cond === 'object') {
                  if (cond.lt !== undefined) {
                    const v = r[key] instanceof Date ? r[key].getTime() : r[key];
                    const t = cond.lt instanceof Date ? cond.lt.getTime() : cond.lt;
                    if (!(v < t)) return false;
                  }
                  return true;
                }
                if (key === 'createdAt') {
                  return r.createdAt.getTime() === cond.getTime();
                }
                return r[key] === cond;
              });
            });
          });
          const seen = new Set();
          rows = orRows.filter((r) => {
            if (seen.has(r.id)) return false;
            seen.add(r.id);
            return true;
          });
        }
        if (orderBy) {
          const sorts = Array.isArray(orderBy) ? orderBy : [orderBy];
          rows.sort((a, b) => {
            for (const s of sorts) {
              const k = Object.keys(s)[0];
              const dir = s[k] === 'desc' ? -1 : 1;
              const av = a[k] instanceof Date ? a[k].getTime() : a[k];
              const bv = b[k] instanceof Date ? b[k].getTime() : b[k];
              if (av < bv) return -1 * dir;
              if (av > bv) return 1 * dir;
            }
            return 0;
          });
        }
        return rows.slice(0, take);
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
        return row;
      },
      updateMany: async ({ where = {}, data }) => {
        const targets = Object.values(variations).filter((r) => {
          if (where.id && r.id !== where.id) return false;
          if (where.version !== undefined && r.version !== where.version) return false;
          if (where.status && r.status !== where.status) return false;
          return true;
        });
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
  };

  app.set('prisma', prisma);

  // Auth shim — minimal role gate matching what other tests use.
  app.use((req, _res, next) => {
    const auth = req.headers.authorization || '';
    const m = /^Bearer (.+)$/.exec(auth);
    if (!m) return next();
    try {
      const decoded = jwt.verify(m[1], process.env.JWT_SECRET);
      req.employeeId = decoded.employeeId || decoded.sub || EMPLOYEE_ID;
      req.isAdmin = !!decoded.isAdmin;
      next();
    } catch {
      next();
    }
  });
  app.use('/api/variations', variationsRouter);
  return { app, prisma };
}

function authHeader(employeeId = EMPLOYEE_ID, isAdmin = false) {
  const token = jwt.sign(
    { sub: employeeId, employeeId, isAdmin },
    process.env.JWT_SECRET,
    { expiresIn: '1h' },
  );
  return `Bearer ${token}`;
}

beforeEach(() => {
  variations = {};
});

describe('DR-019 — VO register same-day pagination', () => {
  it('walks every one of 21 same-day VOs across multiple pages (no same-day skip)', async () => {
    // Seed 21 VOs created across the same calendar day at different
    // sub-day timestamps. The OLD codec (date-only) would have lost
    // every row past the first page because all 21 share the same
    // UTC midnight date and the `lt midnight` predicate matched none
    // of them.
    const createdTimestamps = [];
    for (let i = 0; i < 21; i += 1) {
      const ts = new Date(Date.UTC(2026, 8, 8, 9, 0, 0, i * 1000)); // 09:00:00.000 + i*1s
      createdTimestamps.push(ts);
      seedVariation({
        id: `vo-same-day-${String(i).padStart(2, '0')}`,
        title: `VO #${i}`,
        createdAt: ts,
      });
    }

    const { app } = buildApp();
    const seen = new Set();
    let cursor = null;
    let pages = 0;
    while (pages < 10) {
      pages += 1;
      const qs = new URLSearchParams({ limit: '5', status: 'DRAFT' });
      if (cursor) qs.set('cursor', cursor);
      const res = await request(app)
        .get(`/api/variations?${qs.toString()}`)
        .set('Authorization', authHeader());
      expect(res.status).toBe(200);
      for (const v of res.body.variations || []) {
        expect(seen.has(v.id)).toBe(false); // No duplicates across pages.
        seen.add(v.id);
      }
      if (!res.body.nextCursor) break;
      cursor = res.body.nextCursor;
    }
    expect(seen.size).toBe(21);
  });

  it('walks 21 same-instant VOs via the id tie-breaker (no same-instant skip)', async () => {
    // Tie-break stress: all rows have the same exact createdAt instant.
    // Without an `id` tie-breaker in the seek, only the rows with
    // matching id would be skipped — but the instant codec's seek
    // DOES tie-break by id, so every row is reachable.
    const ts = new Date(Date.UTC(2026, 8, 8, 12, 0, 0));
    for (let i = 0; i < 21; i += 1) {
      seedVariation({
        id: `vo-same-instant-${String(i).padStart(2, '0')}`,
        title: `Instant VO #${i}`,
        createdAt: ts,
      });
    }
    const { app } = buildApp();
    const seen = new Set();
    let cursor = null;
    let pages = 0;
    while (pages < 10) {
      pages += 1;
      const qs = new URLSearchParams({ limit: '5', status: 'DRAFT' });
      if (cursor) qs.set('cursor', cursor);
      const res = await request(app)
        .get(`/api/variations?${qs.toString()}`)
        .set('Authorization', authHeader());
      expect(res.status).toBe(200);
      for (const v of res.body.variations || []) {
        expect(seen.has(v.id)).toBe(false);
        seen.add(v.id);
      }
      if (!res.body.nextCursor) break;
      cursor = res.body.nextCursor;
    }
    expect(seen.size).toBe(21);
  });

  it('rejects a legacy date-only cursor as INVALID_CURSOR', async () => {
    seedVariation({ id: 'vo-legacy-cursor' });
    // A hand-crafted cursor using the SHARED codec shape (date+id, no v).
    // The new decode must reject it loudly so the seek doesn't
    // silently mis-translate the truncated date as an instant.
    const legacyCursor = Buffer.from(
      JSON.stringify({ date: '2026-09-08', id: 'vo-legacy-cursor' }),
      'utf8',
    ).toString('base64url');
    const { app } = buildApp();
    const res = await request(app)
      .get(`/api/variations?cursor=${encodeURIComponent(legacyCursor)}`)
      .set('Authorization', authHeader());
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_CURSOR');
  });

  it('nextCursor encodes the exact createdAt instant (source-text pin)', async () => {
    // Seed two rows with sub-day millisecond precision. limit=1 returns
    // the NEWER row first (orderBy createdAt DESC), and nextCursor
    // encodes that newer row's exact instant — not just the calendar
    // day. This pins that the route uses encodeInstantCursor, not the
    // legacy encodeCursor (which would have truncated to UTC midnight).
    const olderTs = new Date(Date.UTC(2026, 8, 8, 14, 30, 45, 123));
    const newerTs = new Date(Date.UTC(2026, 8, 8, 14, 30, 45, 999));
    seedVariation({ id: 'vo-instant-pin-older', createdAt: olderTs });
    seedVariation({ id: 'vo-instant-pin-newer', createdAt: newerTs });
    const { app } = buildApp();
    const res = await request(app)
      .get('/api/variations?limit=1')
      .set('Authorization', authHeader());
    expect(res.status).toBe(200);
    expect(res.body.nextCursor).toBeTruthy();
    // The cursor must decode as the instant codec, not the legacy date
    // codec. Inspecting the JSON payload: `v` must be 1 and `ms` must
    // equal the newer timestamp's millisecond value.
    const payload = JSON.parse(Buffer.from(res.body.nextCursor, 'base64url').toString('utf8'));
    expect(payload.v).toBe(1);
    expect(payload.ms).toBe(newerTs.getTime());
    expect(payload.id).toBe('vo-instant-pin-newer');
    // Sub-day precision is preserved (millisecond).
    expect(payload.ms % 1000).toBe(999);
  });
});
