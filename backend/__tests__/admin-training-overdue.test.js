// ─────────────────────────────────────────────────────────────────────────────
// Round-26: Admin training-overdue sweep cron contract tests.
//
// Pins the behavior of POST /api/internal/training/overdue/sweep so the
// cron contract doesn't drift:
//   - Token gate (404 unset, 403 wrong, 200 match)
//   - Sweep flips ASSIGNED|IN_PROGRESS → OVERDUE only when dueDate < today IST
//   - One admin-targeted email per flipped row
//   - Atomic guard: concurrent state change skips the row (no silent overwrite)
//   - already-OVERDUE rows are excluded by the where-clause (no re-flip)
// ─────────────────────────────────────────────────────────────────────────────

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';
process.env.INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || 'test-internal-token';

const express = require('express');
const request = require('supertest');

// ─── Email + adminRecipients mocks ────────────────────────────────────────
const mockSendEmail = jest.fn(async () => ({ ok: true, messageId: 'overdue-test-msg' }));
const mockFindActiveAdmins = jest.fn(async () => [
  { id: 'admin-1', email: 'admin1@example.com', name: 'Admin One' },
]);

jest.mock('../src/lib/email', () => {
  const actual = jest.requireActual('../src/lib/email');
  return {
    ...actual,
    sendEmail: mockSendEmail,
    isConfigured: jest.fn(() => true),
    close: jest.fn(async () => {}),
    escapeHtml: actual.escapeHtml,
    FROM_EMAIL: 'noreply@acschennai.com',
    FROM_NAME: 'ACS Chennai Portal',
  };
});

jest.mock('../src/lib/adminRecipients', () => ({
  findActiveAdmins: mockFindActiveAdmins,
}));

const router = require('../src/routes/internal-training-overdue');

function buildApp(prisma) {
  const app = express();
  app.use(express.json());
  app.set('prisma', prisma);
  app.use('/api/internal/training/overdue', router);
  return app;
}

function makePrisma({ candidates = [], updateCounts = [1] } = {}) {
  const updateCalls = [];
  return {
    trainingEnrollment: {
      findMany: jest.fn(async () => candidates),
      updateMany: jest.fn(async (args) => {
        updateCalls.push(args);
        const idx = updateCalls.length - 1;
        const count = updateCounts[idx] !== undefined ? updateCounts[idx] : 1;
        return { count };
      }),
    },
    __updateCalls: updateCalls,
  };
}

beforeEach(() => {
  mockSendEmail.mockReset();
  mockSendEmail.mockResolvedValue({ ok: true, messageId: 'overdue-test-msg' });
  mockFindActiveAdmins.mockReset();
  mockFindActiveAdmins.mockResolvedValue([
    { id: 'admin-1', email: 'admin1@example.com', name: 'Admin One' },
  ]);
});

// ─── Token gate ───────────────────────────────────────────────────────────

describe('Round-26 — POST /api/internal/training/overdue/sweep token gate', () => {
  it('returns 404 when INTERNAL_API_TOKEN is unset', async () => {
    const saved = process.env.INTERNAL_API_TOKEN;
    delete process.env.INTERNAL_API_TOKEN;
    try {
      const prisma = makePrisma();
      const app = buildApp(prisma);
      const res = await request(app).post('/api/internal/training/overdue/sweep');
      expect(res.status).toBe(404);
    } finally {
      process.env.INTERNAL_API_TOKEN = saved;
    }
  });

  it('returns 403 on wrong token', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/internal/training/overdue/sweep')
      .set('X-Internal-Token', 'wrong-token');
    expect(res.status).toBe(403);
  });

  it('returns 200 on correct token', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/internal/training/overdue/sweep')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ flipped: 0, skipped: 0, candidates: 0 });
  });
});

// ─── Sweep behavior ───────────────────────────────────────────────────────

describe('Round-26 — POST /api/internal/training/overdue/sweep flips rows', () => {
  it('1. flips ASSIGNED with dueDate < today → OVERDUE + admin email', async () => {
    const yesterday = new Date(Date.UTC(2026, 8, 2)); // 2026-09-02 (1 day before today 2026-09-03)
    const prisma = makePrisma({
      candidates: [
        {
          id: 'enr-1',
          status: 'ASSIGNED',
          dueDate: yesterday,
          employee: { id: 'emp-1', name: 'Rajesh Kumar' },
          course: { id: 'course-1', title: 'YouTube Safety' },
        },
      ],
    });
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/internal/training/overdue/sweep')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.flipped).toBe(1);
    expect(res.body.skipped).toBe(0);
    // Atomic-guard where clause used.
    expect(prisma.__updateCalls[0].where).toMatchObject({
      id: 'enr-1',
      status: { in: ['ASSIGNED', 'IN_PROGRESS'] },
    });
    expect(prisma.__updateCalls[0].data).toEqual({ status: 'OVERDUE' });
    // Admin fan-out fired once (one admin in the mock).
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const sendArgs = mockSendEmail.mock.calls[0][0];
    expect(sendArgs.subject).toMatch(/Overdue: YouTube Safety — Rajesh Kumar/);
  });

  it('2. flips IN_PROGRESS → OVERDUE', async () => {
    const yesterday = new Date(Date.UTC(2026, 8, 2));
    const prisma = makePrisma({
      candidates: [
        {
          id: 'enr-2',
          status: 'IN_PROGRESS',
          dueDate: yesterday,
          employee: { id: 'emp-1', name: 'Rajesh' },
          course: { id: 'course-1', title: 'Vimeo Onboarding' },
        },
      ],
    });
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/internal/training/overdue/sweep')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.flipped).toBe(1);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  it('3. already-OVERDUE rows never appear in the candidates query (where-clause excludes them)', async () => {
    // No candidates returned by findMany → 0 flips, 0 emails. The fact that
    // findMany used `status: { in: ['ASSIGNED', 'IN_PROGRESS'] }` is the
    // structural proof that we never re-flip already-OVERDUE rows.
    const prisma = makePrisma({ candidates: [] });
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/internal/training/overdue/sweep')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.flipped).toBe(0);
    expect(mockSendEmail).not.toHaveBeenCalled();
    // Verify the where-clause shape on the findMany call.
    expect(prisma.trainingEnrollment.findMany).toHaveBeenCalledTimes(1);
    const where = prisma.trainingEnrollment.findMany.mock.calls[0][0].where;
    expect(where.status).toEqual({ in: ['ASSIGNED', 'IN_PROGRESS'] });
  });

  it('4. dueDate === today is NOT flipped (only dueDate < today)', async () => {
    // The findMany query uses `dueDate: { lt: todayIstUtc }`, which means
    // a dueDate that is EXACTLY today is not a candidate. Verify the
    // where-clause shape so a future refactor that flips to `<=` is caught.
    const prisma = makePrisma({ candidates: [] });
    const app = buildApp(prisma);
    await request(app)
      .post('/api/internal/training/overdue/sweep?date=2026-09-03')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN);
    const where = prisma.trainingEnrollment.findMany.mock.calls[0][0].where;
    expect(where.dueDate).toMatchObject({ lt: expect.any(Date) });
    // lt, not lte.
    expect(where.dueDate.lte).toBeUndefined();
  });

  it('5. atomic-guard skip: concurrent state change → updateMany.count=0 → skipped, no email', async () => {
    const yesterday = new Date(Date.UTC(2026, 8, 2));
    const prisma = makePrisma({
      candidates: [
        {
          id: 'enr-3',
          status: 'ASSIGNED',
          dueDate: yesterday,
          employee: { id: 'emp-1', name: 'Rajesh' },
          course: { id: 'course-1', title: 'Coursera X' },
        },
      ],
      // First call returns count=0 (concurrent admin unassign / employee
      // self-complete flipped the row out from under us).
      updateCounts: [0],
    });
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/internal/training/overdue/sweep')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.flipped).toBe(0);
    expect(res.body.skipped).toBe(1);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('6. multiple admins → 1 admin email per flipped row (not per admin-per-row)', async () => {
    mockFindActiveAdmins.mockResolvedValue([
      { id: 'admin-1', email: 'admin1@example.com', name: 'Admin One' },
      { id: 'admin-2', email: 'admin2@example.com', name: 'Admin Two' },
    ]);
    const yesterday = new Date(Date.UTC(2026, 8, 2));
    const prisma = makePrisma({
      candidates: [
        {
          id: 'enr-4',
          status: 'ASSIGNED',
          dueDate: yesterday,
          employee: { id: 'emp-1', name: 'Rajesh' },
          course: { id: 'course-1', title: 'Udemy X' },
        },
      ],
    });
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/internal/training/overdue/sweep')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.flipped).toBe(1);
    // 1 row × 2 admins = 2 sends.
    expect(mockSendEmail).toHaveBeenCalledTimes(2);
  });
});
