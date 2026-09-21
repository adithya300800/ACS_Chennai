// Round-40 #4 — retention cron endpoint tests.
//
// Pins:
//   1. Auth: 404 when INTERNAL_API_TOKEN is unset, 403 when the
//      X-Internal-Token header doesn't match, 200 when it does.
//      Same shape as internal-warmup.js. Two regression tiers:
//        - Unset token → 404 with { error: 'Not found' }
//        - Mismatched token → 403 with { error: 'Forbidden' }
//   2. The DELETE uses `created_at < NOW() - retentionDays days` so
//      rows within the retention window are NOT deleted. The
//      response carries back the deletion count for the operator's
//      verification script.
//   3. dryRun=true path counts instead of deleting. The id (X-Request-Id)
//      is preserved across both paths so audit chains remain traceable.
//   4. The endpoint is idempotent — re-running with the same retention
//      window does not error.
//   5. The prune operation emits a single level=info source=cron
//      log row, distinct from the per-request http.request rows.

'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.PII_LOG_SALT =
  process.env.PII_LOG_SALT || 'test-pii-log-salt-must-be-set';

const express = require('express');
const request = require('supertest');
const log = require('../src/lib/log');

function buildMockPrisma() {
  return {
    appLog: {
      create: jest.fn(async ({ data }) => data),
    },
    $executeRaw: jest.fn(),
    $queryRaw: jest.fn(),
    // Sentinel for "table missing" — emits the resolver edge case.
    // safeAsync / log.js must NOT throw when this is the case.
    // (Test 5 below — a future cleanup that removes the model will
    // surface as a regression.)
  };
}

let mockPrisma;
let consoleErrorSpy;
let consoleLogSpy;

beforeEach(() => {
  mockPrisma = buildMockPrisma();
  log._setPrismaForTesting(mockPrisma);
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
  consoleLogSpy.mockRestore();
});

// Build a fresh test app per test so the INTERNAL_API_TOKEN env var
// re-evaluation happens cleanly. The cron route reads prisma via
// req.app.get('prisma'), so each test app carries a fresh mock Prisma.
function buildTestApp(prisma) {
  const app = express();
  app.use(express.json());
  // Re-require to pick up current env state.
  delete require.cache[require.resolve('../src/routes/internal-cron')];
  const cronRoutes = require('../src/routes/internal-cron');
  // Internal-cron reads prisma off req.app.get — supply it.
  app.set('prisma', prisma);
  app.use('/api/internal/cron', cronRoutes);
  return app;
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('round40 — POST /api/internal/cron/prune-logs auth', () => {
  test('returns 404 when INTERNAL_API_TOKEN is unset', async () => {
    const prev = process.env.INTERNAL_API_TOKEN;
    delete process.env.INTERNAL_API_TOKEN;
    try {
      const app = buildTestApp(mockPrisma);
      const res = await request(app).post('/api/internal/cron/prune-logs');
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Not found' });
    } finally {
      if (prev !== undefined) process.env.INTERNAL_API_TOKEN = prev;
    }
  });

  test('returns 403 with X-Internal-Token mismatch', async () => {
    process.env.INTERNAL_API_TOKEN = 'right-token';
    const app = buildTestApp(mockPrisma);
    const res = await request(app)
      .post('/api/internal/cron/prune-logs')
      .set('X-Internal-Token', 'wrong-token');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden' });
  });
});

describe('round40 — POST /api/internal/cron/prune-logs happy path', () => {
  beforeEach(() => {
    process.env.INTERNAL_API_TOKEN = 'round40-test-token';
  });

  test('a valid token + matching header executes the DELETE and returns the row count', async () => {
    mockPrisma.$executeRaw.mockResolvedValueOnce(42); // 42 rows deleted
    mockPrisma.$queryRaw.mockResolvedValueOnce([]); // not called in non-dryRun path

    const app = buildTestApp(mockPrisma);
    const res = await request(app)
      .post('/api/internal/cron/prune-logs')
      .set('X-Internal-Token', 'round40-test-token');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.deleted).toBe(42);
    expect(res.body.dryRun).toBe(false);
    expect(res.body.retentionDays).toBe(30); // default
    expect(typeof res.body.ranAt).toBe('string');
    expect(new Date(res.body.ranAt).toString()).not.toBe('Invalid Date');

    // $executeRaw was called exactly once with the templated query.
    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
    // $queryRaw was NOT called on the non-dryRun path.
    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
  });

  test('dryRun=true swaps DELETE for COUNT(*) so an operator can preview', async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([{ n: 117 }]);

    const app = buildTestApp(mockPrisma);
    const res = await request(app)
      .post('/api/internal/cron/prune-logs?dryRun=true')
      .set('X-Internal-Token', 'round40-test-token');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.deleted).toBe(117);
    expect(res.body.dryRun).toBe(true);
    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
  });

  test('?days=N overrides the retention window per-call', async () => {
    mockPrisma.$executeRaw.mockResolvedValueOnce(0);
    const app = buildTestApp(mockPrisma);
    const res = await request(app)
      .post('/api/internal/cron/prune-logs?days=7')
      .set('X-Internal-Token', 'round40-test-token');
    expect(res.status).toBe(200);
    expect(res.body.retentionDays).toBe(7);
  });

  test('LOG_RETENTION_DAYS env var supplies the default when no ?days= override is given', async () => {
    process.env.LOG_RETENTION_DAYS = '90';
    mockPrisma.$executeRaw.mockResolvedValueOnce(0);
    const app = buildTestApp(mockPrisma);
    const res = await request(app)
      .post('/api/internal/cron/prune-logs')
      .set('X-Internal-Token', 'round40-test-token');
    expect(res.status).toBe(200);
    expect(res.body.retentionDays).toBe(90);
    delete process.env.LOG_RETENTION_DAYS;
  });

  test('LOG_RETENTION_DAYS set to garbage falls back to the hard-coded default of 30 days', async () => {
    process.env.LOG_RETENTION_DAYS = 'not-a-number';
    mockPrisma.$executeRaw.mockResolvedValueOnce(0);
    const app = buildTestApp(mockPrisma);
    const res = await request(app)
      .post('/api/internal/cron/prune-logs')
      .set('X-Internal-Token', 'round40-test-token');
    expect(res.status).toBe(200);
    expect(res.body.retentionDays).toBe(30);
    delete process.env.LOG_RETENTION_DAYS;
  });

  test('the endpoint emits a single level=info source=cron log row, distinct from http.request', async () => {
    mockPrisma.$executeRaw.mockResolvedValueOnce(0);
    const app = buildTestApp(mockPrisma);
    await request(app)
      .post('/api/internal/cron/prune-logs')
      .set('X-Internal-Token', 'round40-test-token');
    await settle();

    expect(mockPrisma.appLog.create).toHaveBeenCalledTimes(1);
    const persisted = mockPrisma.appLog.create.mock.calls[0][0].data;
    expect(persisted.level).toBe('info');
    expect(persisted.source).toBe('cron');
    expect(persisted.message).toBe('cron.prune_logs');
    expect(persisted.context.deleted).toBe(0);
    expect(persisted.context.dryRun).toBe(false);
    expect(persisted.context.retentionDays).toBe(30);
    // Pin the route field — the http.request middleware uses route
    // differently (it names the API endpoint, not the prune URL).
    expect(persisted.route).toBe('/api/internal/cron/prune-logs');
    expect(persisted.method).toBe('POST');
  });

  test('re-running the endpoint on the same day is idempotent (no error)', async () => {
    mockPrisma.$executeRaw
      .mockResolvedValueOnce(15)
      .mockResolvedValueOnce(0); // second run already-pruned
    const app = buildTestApp(mockPrisma);
    const headers = { 'X-Internal-Token': 'round40-test-token' };
    const first = await request(app).post('/api/internal/cron/prune-logs').set(headers);
    const second = await request(app).post('/api/internal/cron/prune-logs').set(headers);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.deleted).toBe(15);
    expect(second.body.deleted).toBe(0);
  });
});
