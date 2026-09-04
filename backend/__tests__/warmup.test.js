// ─────────────────────────────────────────────────────────────────────────────
// Round-26.5: Cold-start warm-up cron contract tests.
//
// Pins the behavior of POST /api/internal/warmup/ping so the operational
// half of the cold-start story (the render cron → ping → keep-alive) doesn't
// drift:
//   - Token gate (404 unset, 403 wrong, 200 match) — same as siblings
//   - Touches prisma via $queryRaw so the DB pool is warm too
//   - Returns ok + warmupMs + dbTouched so the cron job's success-detection
//     is uniform across siblings
//   - DB failures don't fail the ping (warm-up is the goal, DB is secondary)
//   - ?touch=no skips the DB round-trip (operator escape hatch for diagnosing
//     whether the cold-start race is in the HTTP layer vs the DB pool)
// ─────────────────────────────────────────────────────────────────────────────

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';
process.env.INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || 'test-internal-token';

const express = require('express');
const request = require('supertest');

const router = require('../src/routes/internal-warmup');

function buildApp(prisma) {
  const app = express();
  app.use(express.json());
  app.set('prisma', prisma);
  app.use('/api/internal/warmup', router);
  return app;
}

function makePrisma({ dbThrows = false } = {}) {
  const queryRawCalls = [];
  return {
    $queryRaw: jest.fn(async () => {
      queryRawCalls.push(Date.now());
      if (dbThrows) throw new Error('simulated DB outage');
      return [{ '?column?': 1 }];
    }),
    __queryRawCalls: queryRawCalls,
  };
}

// ─── Token gate ───────────────────────────────────────────────────────────

describe('Round-26.5 — POST /api/internal/warmup/ping token gate', () => {
  it('returns 404 when INTERNAL_API_TOKEN is unset', async () => {
    const saved = process.env.INTERNAL_API_TOKEN;
    delete process.env.INTERNAL_API_TOKEN;
    try {
      const app = buildApp(makePrisma());
      const res = await request(app).post('/api/internal/warmup/ping');
      expect(res.status).toBe(404);
    } finally {
      process.env.INTERNAL_API_TOKEN = saved;
    }
  });

  it('returns 403 on wrong token', async () => {
    const app = buildApp(makePrisma());
    const res = await request(app)
      .post('/api/internal/warmup/ping')
      .set('X-Internal-Token', 'wrong-token');
    expect(res.status).toBe(403);
  });

  it('returns 200 + ok on correct token', async () => {
    const app = buildApp(makePrisma());
    const res = await request(app)
      .post('/api/internal/warmup/ping')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.ts).toBe('string');
    expect(typeof res.body.warmupMs).toBe('number');
    expect(res.body.dbTouched).toBe(true);
  });
});

// ─── Warm-up behavior ─────────────────────────────────────────────────────

describe('Round-26.5 — POST /api/internal/warmup/ping warms the DB pool', () => {
  it('1. default ping runs $queryRaw (DB touch on by default)', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/internal/warmup/ping')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.dbTouched).toBe(true);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('2. ?touch=no skips the DB round-trip', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/internal/warmup/ping?touch=no')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.dbTouched).toBe(false);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('3. ?touch=false skips the DB round-trip (alternate spelling)', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/internal/warmup/ping?touch=false')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.dbTouched).toBe(false);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('4. DB outage does NOT fail the ping — warm-up is the goal', async () => {
    // The whole point of the endpoint is to keep the HTTP path warm. If
    // the DB is hiccuping, we still want the cron to log a 200 and move
    // on rather than 500. The DB outage is logged inside the handler so
    // ops can spot chronic failures via the cron logs.
    const prisma = makePrisma({ dbThrows: true });
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/internal/warmup/ping')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.dbTouched).toBe(false);
  });

  it('5. response includes warmupMs as a positive number', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/internal/warmup/ping')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.warmupMs).toBeGreaterThanOrEqual(0);
    expect(res.body.warmupMs).toBeLessThan(5000); // sanity ceiling
  });
});
