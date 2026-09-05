// SOL DR-013 — admin attendance digest must predicate Attendance.@db.Date
// with UTC midnight, not IST midnight.
//
// The audit found this exact hazard:
//
//   targetDateStr = "2026-09-04" (the IST calendar day we want)
//   dateIstUtc    = istMidnightUtcFromDateString("2026-09-04")
//                  = 2026-09-03T18:30:00Z   ← IST midnight
//   Attendance row written by attendance.js check-in for Sept 4 IST:
//     stored as @db.Date = 2026-09-04 (UTC midnight by construction)
//
// Pre-fix: where: { date: dateIstUtc } → PostgreSQL coerces
// 2026-09-03T18:30:00Z against a DATE column. The result depends on
// the server's session timezone; on the pgbouncer pooler we observed
// it land on 2026-09-03, so the digest silently listed the previous
// day's present/onLeave/absent split.
//
// Fix: route the Attendance predicate through parseDateOnlyToUtc(),
// which returns UTC midnight of the calendar day. Same value the
// check-in path stored. Keep dateIstUtc for AdminDigestRun.scheduledFor
// (a TIMESTAMP column whose claim-key identity must not change).

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.INTERNAL_API_TOKEN =
  process.env.INTERNAL_API_TOKEN || 'test-internal-token';

// Hoisted jest mocks for the modules the route imports eagerly.
const mockFindActiveAdmins = jest.fn();
jest.mock('../src/lib/email', () => ({
  __esModule: false,
  sendEmail: jest.fn(async () => ({ id: 'mock-message-id' })),
  isConfigured: () => true,
}));
jest.mock('../src/templates/email', () => ({
  renderAdminAttendanceDigest: jest.fn(() => ({
    subject: 'mock subject',
    html: '<p>mock html</p>',
    text: 'mock text',
  })),
  wrapHtml: (s) => s,
  ctaButton: () => '',
  escapeHtml: (s) => String(s),
}));
jest.mock('../src/lib/adminRecipients', () => ({
  findActiveAdmins: mockFindActiveAdmins,
}));

const express = require('express');
const request = require('supertest');

const router = require('../src/routes/internal-admin-attendance');

function buildApp(prisma, findActiveAdminsReturn = []) {
  mockFindActiveAdmins.mockResolvedValue(findActiveAdminsReturn);
  const app = express();
  app.use(express.json());
  app.set('prisma', prisma);
  app.use('/api/internal/attendance/digest', router);
  return app;
}

function makePrisma() {
  return {
    employee: { findMany: jest.fn(async () => []) },
    attendance: { findMany: jest.fn(async () => []) },
    leaveRequest: { findMany: jest.fn(async () => []) },
    adminDigestRun: {
      create: jest.fn(async (args) => ({
        id: 'mock-admin-digest-run',
        ...args.data,
      })),
      update: jest.fn(async (args) => ({
        id: 'mock-admin-digest-run',
        ...args.data,
      })),
      findFirst: jest.fn(async () => null),
      findUnique: jest.fn(async () => null),
    },
    emailLog: {
      create: jest.fn(async (args) => ({
        id: 'mock-email-log',
        ...args.data,
      })),
      findFirst: jest.fn(async () => null),
    },
    notification: {},
  };
}

const {
  istMidnightUtcFromDateString,
  parseDateOnlyToUtc,
  IST_OFFSET_MS,
} = require('../src/lib/dateOnly');

describe('SOL DR-013 — admin attendance digest date predicate', () => {
  let app;
  let prisma;

  beforeEach(() => {
    prisma = makePrisma();
    app = buildApp(prisma, [{ id: 'admin-1', email: 'admin@example.com' }]);
  });

  test('A1. IST midnight and UTC midnight of the same IST day are NOT equal', () => {
    // Sanity: the two helpers the route now uses must produce different
    // values for the same targetDateStr. If this fails, the fix has no
    // observable behavior.
    const target = '2026-09-04';
    const istMidnight = istMidnightUtcFromDateString(target);
    const utcMidnight = parseDateOnlyToUtc(target);
    expect(istMidnight.getTime()).toBe(
      Date.UTC(2026, 8, 4) - IST_OFFSET_MS
    );
    expect(utcMidnight.getTime()).toBe(Date.UTC(2026, 8, 4));
    expect(istMidnight.getTime()).not.toBe(utcMidnight.getTime());
    // The difference is exactly the IST offset (5h30m).
    expect(utcMidnight.getTime() - istMidnight.getTime()).toBe(IST_OFFSET_MS);
  });

  test('A2. POST /api/internal/attendance/digest/run with date=2026-09-04 queries Attendance with UTC midnight', async () => {
    const res = await request(app)
      .post('/api/internal/attendance/digest/run?date=2026-09-04')
      .set('X-Internal-Token', 'test-internal-token')
      .send();
    expect(res.status).toBe(200);
    // Attendance predicate must be UTC midnight, not IST midnight.
    const where = prisma.attendance.findMany.mock.calls[0][0].where;
    expect(where.date).toBeDefined();
    const predicateMs = new Date(where.date).getTime();
    expect(predicateMs).toBe(Date.UTC(2026, 8, 4));
    // Negative: must NOT be the IST midnight value (which would land
    // on Sept 3 18:30 UTC).
    expect(predicateMs).not.toBe(
      Date.UTC(2026, 8, 4) - IST_OFFSET_MS
    );
  });

  test('A3. AdminDigestRun.scheduledFor still uses IST midnight (claim-key identity preserved)', async () => {
    // DR-013 acceptance criterion: "existing-run deduplication also
    // survives the change." The dedup key is (adminId, scheduledFor);
    // changing its value silently re-fires the digest for every prior
    // claim. The fix preserves this column's value.
    const res = await request(app)
      .post('/api/internal/attendance/digest/run?date=2026-09-04')
      .set('X-Internal-Token', 'test-internal-token')
      .send();
    expect(res.status).toBe(200);
    expect(prisma.adminDigestRun.create).toHaveBeenCalled();
    const createArg = prisma.adminDigestRun.create.mock.calls[0][0];
    const scheduledForMs = new Date(createArg.data.scheduledFor).getTime();
    expect(scheduledForMs).toBe(Date.UTC(2026, 8, 4) - IST_OFFSET_MS);
  });

  test('A4. multiple consecutive IST days produce UTC-midnight Attendance predicates in lockstep', async () => {
    // The fix must apply uniformly: every digest request for an IST
    // calendar day must predicate Attendance with the UTC midnight of
    // that exact day, not the IST midnight.
    const days = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05'];
    for (const d of days) {
      prisma.attendance.findMany.mockClear();
      // eslint-disable-next-line no-await-in-loop
      await request(app)
        .post(`/api/internal/attendance/digest/run?date=${d}`)
        .set('X-Internal-Token', 'test-internal-token')
        .send();
      const expected = Date.UTC(
        Number(d.slice(0, 4)),
        Number(d.slice(5, 7)) - 1,
        Number(d.slice(8, 10))
      );
      const where = prisma.attendance.findMany.mock.calls[0][0].where;
      const actual = new Date(where.date).getTime();
      expect(actual).toBe(expected);
    }
  });
});
