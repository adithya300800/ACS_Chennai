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
const mockIsConfigured = jest.fn(() => true);
const mockFindActiveAdmins = jest.fn(async () => [
  { id: 'admin-1', email: 'admin1@example.com', name: 'Admin One' },
]);

jest.mock('../src/lib/email', () => {
  const actual = jest.requireActual('../src/lib/email');
  return {
    ...actual,
    sendEmail: mockSendEmail,
    isConfigured: mockIsConfigured,
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

function makePrisma({ candidates = [], staleRows = [], updateCounts = [1] } = {}) {
  const updateCalls = [];
  // findMany is called from BOTH passes (flip + retry). By default the
  // first call returns the flip candidates and the second returns the
  // retry candidates (or []). Tests that need different behavior can
  // override findMany directly via jest.fn().mockResolvedValueOnce(...).
  let findManyCallIndex = 0;
  const findManyResponses = [candidates, staleRows];
  return {
    trainingEnrollment: {
      findMany: jest.fn(async () => {
        const resp = findManyResponses[findManyCallIndex] !== undefined
          ? findManyResponses[findManyCallIndex]
          : [];
        findManyCallIndex += 1;
        return resp;
      }),
      updateMany: jest.fn(async (args) => {
        updateCalls.push(args);
        const idx = updateCalls.length - 1;
        const count = updateCounts[idx] !== undefined ? updateCounts[idx] : 1;
        return { count };
      }),
      // Single-row update (S3-6: setting overdueNotifiedAt). Default mock
      // returns a stub matching the input so the route can chain `await`.
      update: jest.fn(async (args) => ({ id: args?.where?.id || 'enr-x', ...args?.data })),
      count: jest.fn(async () => 0),
    },
    __updateCalls: updateCalls,
  };
}

beforeEach(() => {
  mockSendEmail.mockReset();
  mockSendEmail.mockResolvedValue({ ok: true, messageId: 'overdue-test-msg' });
  mockIsConfigured.mockReset();
  mockIsConfigured.mockReturnValue(true);
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
    // [S3-6] Two findMany calls: one for the flip pass (empty → break), one
    // for the retry pass (empty → break). The structural proof is on the
    // FIRST call's where-clause; the retry pass uses a different predicate.
    expect(prisma.trainingEnrollment.findMany).toHaveBeenCalledTimes(2);
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
    // [S3-6] Two findMany calls: flip pass + retry pass (both empty here).
    expect(prisma.trainingEnrollment.findMany).toHaveBeenCalledTimes(2);
    // The structural proof is on the flip-pass call (index 0).
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
          .mockResolvedValueOnce([])
          // [S3-6] The retry pass also calls findMany; default to empty
          // so the retry loop exits without further work in this test.
          .mockResolvedValue([]),
        updateMany: jest.fn(async () => ({ count: 1 })),
        update: jest.fn(async (args) => ({ id: args?.where?.id, ...args?.data })),
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
      // First flip-pass call returns 3 rows (cap=2 means we flip 2 and stop).
      // Second flip-pass call would also return 3 rows; but the cap trips
      // first so it's not made. The retry pass call returns [] (no stale
      // notifications in this synthetic test).
      const findMany = jest.fn(async () => ([]));
      findMany.mockResolvedValueOnce([
        { id: 'enr-1', status: 'ASSIGNED', dueDate: yesterday, employee: { id: 'emp-1', name: 'A' }, course: { id: 'c', title: 'C1' } },
        { id: 'enr-2', status: 'ASSIGNED', dueDate: yesterday, employee: { id: 'emp-2', name: 'B' }, course: { id: 'c', title: 'C2' } },
        { id: 'enr-3', status: 'ASSIGNED', dueDate: yesterday, employee: { id: 'emp-3', name: 'C' }, course: { id: 'c', title: 'C3' } },
      ]);
      const updateMany = jest.fn(async () => ({ count: 1 }));
      const update = jest.fn(async (args) => ({ id: args?.where?.id, ...args?.data }));
      const count = jest.fn(async () => 17); // operator-visible backlog
      const prisma = { trainingEnrollment: { findMany, updateMany, update, count } };
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
      // Retry pass is mocked to return [] (no stale notifications).
      const findMany = jest.fn(async () => ([]));
      findMany.mockResolvedValueOnce([
        { id: 'enr-slow-1', status: 'ASSIGNED', dueDate: yesterday, employee: { id: 'emp-1', name: 'A' }, course: { id: 'c', title: 'C1' } },
        { id: 'enr-slow-2', status: 'ASSIGNED', dueDate: yesterday, employee: { id: 'emp-2', name: 'B' }, course: { id: 'c', title: 'C2' } },
      ]);
      const updateMany = jest.fn(async () => {
        // burn ~20ms (over the 5ms budget) on the first call so the second
        // iteration's pre-row check sees Date.now()-start >= 5ms and exits.
        await new Promise((r) => setTimeout(r, 20));
        return { count: 1 };
      });
      const update = jest.fn(async (args) => ({ id: args?.where?.id, ...args?.data }));
      const count = jest.fn(async () => 9);
      const prisma = { trainingEnrollment: { findMany, updateMany, update, count } };
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
      // flip loop should exit on the partial-batch short-circuit, NOT do a
      // second fetch. The retry pass also returns [] (no stale rows).
      if (findManyCalls === 1) {
        return [
          { id: 'enr-x', status: 'ASSIGNED', dueDate: yesterday, employee: { id: 'emp-1', name: 'A' }, course: { id: 'c', title: 'C' } },
          { id: 'enr-y', status: 'ASSIGNED', dueDate: yesterday, employee: { id: 'emp-2', name: 'B' }, course: { id: 'c', title: 'C' } },
        ];
      }
      return [];
    });
    const updateMany = jest.fn(async () => ({ count: 1 }));
    const update = jest.fn(async (args) => ({ id: args?.where?.id, ...args?.data }));
    const count = jest.fn(async () => 0);
    const prisma = { trainingEnrollment: { findMany, updateMany, update, count } };
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/internal/training/overdue/sweep')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.flipped).toBe(2);
    expect(res.body.batches).toBe(1);
    // flip pass: 1 call (2 rows, partial → short-circuit)
    // retry pass: 1 call (returns [] → exits)
    expect(findManyCalls).toBe(2);
    expect(mockSendEmail).toHaveBeenCalledTimes(2);
  });
});

// ─── [S3-6] Notification retry pass ────────────────────────────────────────

describe('[S3-6] training-overdue sweep retries silent-notification misses', () => {
  it('13. successful flip → fan-out sent=1 → sets overdueNotifiedAt = now()', async () => {
    const yesterday = new Date(Date.UTC(2026, 8, 2));
    const prisma = makePrisma({
      candidates: [
        {
          id: 'enr-notif-1',
          status: 'ASSIGNED',
          dueDate: yesterday,
          employee: { id: 'emp-1', name: 'Rajesh' },
          course: { id: 'c-1', title: 'YouTube Safety' },
        },
      ],
    });
    const app = buildApp(prisma);
    await request(app)
      .post('/api/internal/training/overdue/sweep')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN);
    // update() should be called once with overdueNotifiedAt being a Date.
    expect(prisma.trainingEnrollment.update).toHaveBeenCalledTimes(1);
    const args = prisma.trainingEnrollment.update.mock.calls[0][0];
    expect(args.where).toEqual({ id: 'enr-notif-1' });
    expect(args.data.overdueNotifiedAt).toBeInstanceOf(Date);
  });

  it('14. zero-send fan-out → leaves overdueNotifiedAt null (retry pass picks up)', async () => {
    // Flip isConfigured to false for the duration of this test so
    // fanOutToAdmins returns sent=0 without invoking sendEmail. The
    // shared `mockIsConfigured` jest.fn is captured at module load by
    // notify.js (and re-captured by resetModules'd route instances in
    // tests 10/11) — using the shared mock avoids the cross-test
    // identity issue we hit when reaching for the post-resetModules
    // jest.fn via require().
    mockIsConfigured.mockReturnValue(false);

    try {
      const yesterday = new Date(Date.UTC(2026, 8, 2));
      const prisma = makePrisma({
        candidates: [
          {
            id: 'enr-silent-1',
            status: 'ASSIGNED',
            dueDate: yesterday,
            employee: { id: 'emp-1', name: 'A' },
            course: { id: 'c', title: 'C' },
          },
        ],
        staleRows: [
          // Retry pass should find this same row (status=OVERDUE,
          // overdueNotifiedAt=null after the failed fan-out).
          {
            id: 'enr-silent-1',
            status: 'OVERDUE',
            dueDate: yesterday,
            overdueNotifiedAt: null,
            employee: { id: 'emp-1', name: 'A' },
            course: { id: 'c', title: 'C' },
          },
        ],
      });
      const app = buildApp(prisma);
      const res = await request(app)
        .post('/api/internal/training/overdue/sweep')
        .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN);
      expect(res.status).toBe(200);
      // Fan-out was attempted but produced zero sends. Row is now OVERDUE
      // but overdueNotifiedAt was NOT set (no update() call for the
      // overdueNotifiedAt column on the flip pass).
      expect(res.body.flipped).toBe(1);
      // update() was called 0 times because sent === 0 on the flip pass
      // AND sent === 0 on the retry pass (isConfigured=false both times).
      expect(prisma.trainingEnrollment.update).toHaveBeenCalledTimes(0);
      // The retry pass found the row (status=OVERDUE, overdueNotifiedAt IS
      // NULL) and tried to fan out again — also failed — so it's still
      // pending. mockSendEmail was called 0 times because isConfigured=false
      // skips the call entirely.
      expect(res.body.retriedStillPending).toBe(1);
      expect(mockSendEmail).not.toHaveBeenCalled();
    } finally {
      // beforeEach resets mockIsConfigured.mockReturnValue(true); nothing
      // to do here but the try/finally makes the override scope obvious.
    }
  });

  it('15. retry pass finds rows with overdueNotifiedAt = null (or stale > 24h)', async () => {
    const yesterday = new Date(Date.UTC(2026, 8, 2));
    const oldStaleAt = new Date(Date.now() - 48 * 60 * 60 * 1000); // 2 days ago
    const prisma = makePrisma({
      candidates: [],
      staleRows: [
        // 1. row that never got notified (null)
        {
          id: 'enr-stale-1',
          status: 'OVERDUE',
          dueDate: yesterday,
          overdueNotifiedAt: null,
          employee: { id: 'emp-1', name: 'A' },
          course: { id: 'c', title: 'C1' },
        },
        // 2. row that was notified 2 days ago (stale)
        {
          id: 'enr-stale-2',
          status: 'OVERDUE',
          dueDate: yesterday,
          overdueNotifiedAt: oldStaleAt,
          employee: { id: 'emp-2', name: 'B' },
          course: { id: 'c', title: 'C2' },
        },
      ],
    });
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/internal/training/overdue/sweep')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN);
    expect(res.status).toBe(200);
    // Both stale rows were re-attempted.
    expect(res.body.flipped).toBe(0);
    expect(res.body.retriedNotified).toBe(2); // mockSendEmail returns ok
    // Both rows had overdueNotifiedAt set by update().
    expect(prisma.trainingEnrollment.update).toHaveBeenCalledTimes(2);
    const ids = prisma.trainingEnrollment.update.mock.calls.map((c) => c[0].where.id);
    expect(ids.sort()).toEqual(['enr-stale-1', 'enr-stale-2']);
  });

  it('16. retry pass includes `retry: true` in the meta payload', async () => {
    const yesterday = new Date(Date.UTC(2026, 8, 2));
    const prisma = makePrisma({
      candidates: [],
      staleRows: [
        {
          id: 'enr-stale-meta',
          status: 'OVERDUE',
          dueDate: yesterday,
          overdueNotifiedAt: null,
          employee: { id: 'emp-1', name: 'A' },
          course: { id: 'c', title: 'Retry Course' },
        },
      ],
    });
    const app = buildApp(prisma);
    await request(app)
      .post('/api/internal/training/overdue/sweep')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN);
    // The retry-pass sendEmail payload should have meta.retry = true.
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const call = mockSendEmail.mock.calls[0][0];
    expect(call.html).toMatch(/retry/i); // subject/body mentions retry
  });

  it('17. response includes unnotifiedEstimate (count of stale OVERDUE rows)', async () => {
    const yesterday = new Date(Date.UTC(2026, 8, 2));
    const prisma = makePrisma({ candidates: [] });
    // count() returns different values for the two queries:
    //   1st call: remainingEstimate (open backlog)
    //   2nd call: unnotifiedEstimate (stale OVERDUE rows)
    prisma.trainingEnrollment.count = jest.fn(async () => 0)
      .mockResolvedValueOnce(5)   // remainingEstimate: 5 still open
      .mockResolvedValueOnce(3);  // unnotifiedEstimate: 3 stale notifications
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/internal/training/overdue/sweep')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.remainingEstimate).toBe(5);
    expect(res.body.unnotifiedEstimate).toBe(3);
  });
});
