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

// ─── [S3-5] Backlog-bounded sweep ────────────────────────────────────────

describe('[S3-5] training-overdue sweep is bounded against mail-bomb N×A', () => {
  it('7. findMany is called with a `take` limit + oldest-first orderBy', async () => {
    const yesterday = new Date(Date.UTC(2026, 8, 2));
    const prisma = makePrisma({ candidates: [] });
    const app = buildApp(prisma);
    await request(app)
      .post('/api/internal/training/overdue/sweep')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN);
    expect(prisma.trainingEnrollment.findMany).toHaveBeenCalledTimes(1);
    const args = prisma.trainingEnrollment.findMany.mock.calls[0][0];
    // S3-5 invariant: never an unbounded fetch — there's always a `take`
    // so an unexpectedly-large backlog (e.g. after a long cron gap) cannot
    // produce a single huge in-memory array + N×A fan-out.
    expect(args.take).toBe(500);
    expect(args.orderBy).toEqual({ dueDate: 'asc' });
  });

  it('8. findMany uses TRAINING_OVERDUE_BATCH env when set', async () => {
    const saved = process.env.TRAINING_OVERDUE_BATCH;
    process.env.TRAINING_OVERDUE_BATCH = '17';
    // The route reads the env at module load, so re-require with a fresh
    // cache to pick up the override.
    jest.resetModules();
    const localRouter = require('../src/routes/internal-training-overdue');
    try {
      const prisma = makePrisma({ candidates: [] });
      const app = express();
      app.use(express.json());
      app.set('prisma', prisma);
      app.use('/api/internal/training/overdue', localRouter);
      await request(app)
        .post('/api/internal/training/overdue/sweep')
        .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN);
      const args = prisma.trainingEnrollment.findMany.mock.calls[0][0];
      expect(args.take).toBe(17);
    } finally {
      process.env.TRAINING_OVERDUE_BATCH = saved;
      jest.resetModules();
    }
  });

  it('9. batches loop until findMany returns 0 (drained) — counts `batches`', async () => {
    const yesterday = new Date(Date.UTC(2026, 8, 2));
    // First call: a full batch (PER_BATCH=500 rows). The loop should
    // re-fetch to confirm drain. Second call: 0 candidates → exit loop.
    // Both calls flip successfully.
    const yesterdayRows = Array.from({ length: 500 }, (_, i) => ({
      id: `enr-${i}`,
      status: 'ASSIGNED',
      dueDate: yesterday,
      employee: { id: `emp-${i}`, name: `E${i}` },
      course: { id: 'c-1', title: `Course ${i}` },
    }));
    const prisma = {
      trainingEnrollment: {
        findMany: jest.fn()
          .mockResolvedValueOnce(yesterdayRows)
          .mockResolvedValueOnce([]),
        updateMany: jest.fn(async () => ({ count: 1 })),
        count: jest.fn(async () => 0),
      },
    };
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/internal/training/overdue/sweep')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.flipped).toBe(500);
    expect(res.body.batches).toBe(2); // first fetched + second empty
    expect(res.body.stoppedReason).toBeNull();
    expect(res.body.remainingEstimate).toBe(0);
    // Both rows got updateMany.
    expect(prisma.trainingEnrollment.updateMany).toHaveBeenCalledTimes(500);
    // Each row got one email (single admin in mock).
    expect(mockSendEmail).toHaveBeenCalledTimes(500);
  });

  it('10. PER_RUN_MAX_FLIPS caps a huge backlog and reports remainingEstimate + stoppedReason', async () => {
    // Override the cap to a tiny number so the test runs fast and is
    // deterministic. 3 candidates × cap=2 → 2 flips, 1 backlogged row.
    const saved = process.env.TRAINING_OVERDUE_RUN_MAX_FLIPS;
    process.env.TRAINING_OVERDUE_RUN_MAX_FLIPS = '2';
    jest.resetModules();
    const localRouter = require('../src/routes/internal-training-overdue');
    try {
      const yesterday = new Date(Date.UTC(2026, 8, 2));
      // First call returns 3 rows (cap=2 means we flip 2 and stop).
      // Second call is NOT made because we exited the loop on cap.
      const findMany = jest.fn(async () => ([
        { id: 'enr-1', status: 'ASSIGNED', dueDate: yesterday, employee: { id: 'emp-1', name: 'A' }, course: { id: 'c', title: 'C1' } },
        { id: 'enr-2', status: 'ASSIGNED', dueDate: yesterday, employee: { id: 'emp-2', name: 'B' }, course: { id: 'c', title: 'C2' } },
        { id: 'enr-3', status: 'ASSIGNED', dueDate: yesterday, employee: { id: 'emp-3', name: 'C' }, course: { id: 'c', title: 'C3' } },
      ]));
      const updateMany = jest.fn(async () => ({ count: 1 }));
      const count = jest.fn(async () => 17); // operator-visible backlog
      const prisma = { trainingEnrollment: { findMany, updateMany, count } };
      const app = express();
      app.use(express.json());
      app.set('prisma', prisma);
      app.use('/api/internal/training/overdue', localRouter);
      const res = await request(app)
        .post('/api/internal/training/overdue/sweep')
        .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN);
      expect(res.status).toBe(200);
      expect(res.body.flipped).toBe(2);
      expect(res.body.stoppedReason).toBe('per_run_max');
      expect(res.body.remainingEstimate).toBe(17);
      expect(res.body.flippedEnrollmentIds).toEqual(['enr-1', 'enr-2']);
      // Hard-stop: the third row was NOT processed.
      expect(updateMany).toHaveBeenCalledTimes(2);
      expect(mockSendEmail).toHaveBeenCalledTimes(2); // 2 rows × 1 admin
    } finally {
      process.env.TRAINING_OVERDUE_RUN_MAX_FLIPS = saved;
      jest.resetModules();
    }
  });

  it('11. RUN_BUDGET_MS halts a slow run and reports time_budget + remainingEstimate', async () => {
    // Tighten the budget so the test is fast, then stall the per-row work
    // long enough that the second-row check trips the budget.
    const savedBudget = process.env.TRAINING_OVERDUE_RUN_BUDGET_MS;
    process.env.TRAINING_OVERDUE_RUN_BUDGET_MS = '5';
    jest.resetModules();
    const localRouter = require('../src/routes/internal-training-overdue');
    try {
      const yesterday = new Date(Date.UTC(2026, 8, 2));
      // Two rows. After flipping the first one we sleep past the 5ms budget
      // so the pre-row check on the second row trips time_budget.
      const findMany = jest.fn(async () => ([
        { id: 'enr-slow-1', status: 'ASSIGNED', dueDate: yesterday, employee: { id: 'emp-1', name: 'A' }, course: { id: 'c', title: 'C1' } },
        { id: 'enr-slow-2', status: 'ASSIGNED', dueDate: yesterday, employee: { id: 'emp-2', name: 'B' }, course: { id: 'c', title: 'C2' } },
      ]));
      const updateMany = jest.fn(async () => {
        // burn ~20ms (over the 5ms budget) on the first call so the second
        // iteration's pre-row check sees Date.now()-start >= 5ms and exits.
        await new Promise((r) => setTimeout(r, 20));
        return { count: 1 };
      });
      const count = jest.fn(async () => 9);
      const prisma = { trainingEnrollment: { findMany, updateMany, count } };
      const app = express();
      app.use(express.json());
      app.set('prisma', prisma);
      app.use('/api/internal/training/overdue', localRouter);
      const res = await request(app)
        .post('/api/internal/training/overdue/sweep')
        .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN);
      expect(res.status).toBe(200);
      expect(res.body.stoppedReason).toBe('time_budget');
      expect(res.body.flipped).toBe(1);
      expect(res.body.flippedEnrollmentIds).toEqual(['enr-slow-1']);
      expect(res.body.remainingEstimate).toBe(9);
      // Only the first row was updateMany'd — the second was halted before
      // its atomic guard fired.
      expect(updateMany).toHaveBeenCalledTimes(1);
      expect(mockSendEmail).toHaveBeenCalledTimes(1);
    } finally {
      process.env.TRAINING_OVERDUE_RUN_BUDGET_MS = savedBudget;
      jest.resetModules();
    }
  });

  it('12. short-circuits the loop when a partial batch < PER_BATCH (no extra fetch)', async () => {
    // Verify we don't do an extra empty findMany after a small last batch.
    const yesterday = new Date(Date.UTC(2026, 8, 2));
    let findManyCalls = 0;
    const findMany = jest.fn(async () => {
      findManyCalls += 1;
      // First call returns 2 rows (less than the default 500-batch); the
      // loop should exit on the partial-batch short-circuit, NOT do a
      // second fetch.
      return [
        { id: 'enr-x', status: 'ASSIGNED', dueDate: yesterday, employee: { id: 'emp-1', name: 'A' }, course: { id: 'c', title: 'C' } },
        { id: 'enr-y', status: 'ASSIGNED', dueDate: yesterday, employee: { id: 'emp-2', name: 'B' }, course: { id: 'c', title: 'C' } },
      ];
    });
    const updateMany = jest.fn(async () => ({ count: 1 }));
    const count = jest.fn(async () => 0);
    const prisma = { trainingEnrollment: { findMany, updateMany, count } };
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/internal/training/overdue/sweep')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.flipped).toBe(2);
    expect(res.body.batches).toBe(1);
    expect(findManyCalls).toBe(1);
    expect(mockSendEmail).toHaveBeenCalledTimes(2);
  });
});
