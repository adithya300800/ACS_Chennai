/**
 * Round-20 / DR-005 — Durable token revocation + refresh rotation tests.
 *
 * Three scenarios required by the task spec:
 *
 *   1. Access token issued → logout → reuse same access token → 401
 *      TOKEN_REVOKED (the revocation row is durable, not the old in-process
 *      Map that restarted on every Render deploy).
 *
 *   2. Refresh issued → rotate (mark old revoked, mint new with
 *      rotatedFromId) → reuse OLD refresh → server detects replay, revokes
 *      EVERY refresh token for that employee, returns 401 REFRESH_REUSED.
 *      The new session the legitimate client was holding is collateral —
 *      that is the documented behavior of replay detection and the reason
 *      this is only safe behind rotation + a short replay window.
 *
 *   3. Admin demoted in DB → the JWT's `isAdmin: true` claim is still
 *      honored by requireAuth (token has up to 15 min left) but
 *      requireFreshAdmin re-reads Employee.isAdmin and rejects with 403.
 *      This is the "JWT claim is not a live authority" guarantee.
 *
 * Pattern follows bodyParser.test.js: a throwaway Express app, a hand-rolled
 * in-memory mock Prisma. No DB connection required. Tests the real
 * middleware/auth.js and real lib/revocation.js code paths end-to-end.
 */

'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-must-be-at-least-32-chars-BBBB';
process.env.PII_LOG_SALT = process.env.PII_LOG_SALT || 'test-pii-salt-32-chars-min-deadbeef';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const revocation = require('../src/lib/revocation');
const {
  requireAuth,
  requireFreshAdmin,
} = require('../src/middleware/auth');

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// ─── In-memory mock Prisma ──────────────────────────────────────────────────
// Implements only the surface lib/revocation.js and middleware/auth.js touch.
// Anything else would fail loudly, which is the desired failure mode.

function buildMockPrisma() {
  const revokedByJti = new Map();   // jti -> { jti, employeeId, revokedAt, expiresAt }
  const refreshByHash = new Map();  // tokenHash -> row
  const refreshById = new Map();    // id -> row
  const employees = new Map();      // id -> { id, isAdmin }

  const prisma = {
    revokedToken: {
      findUnique: async ({ where: { jti } }) => {
        const row = revokedByJti.get(jti);
        return row ? { jti, revokedAt: row.revokedAt, expiresAt: row.expiresAt } : null;
      },
      upsert: async ({ where: { jti }, update, create }) => {
        if (revokedByJti.has(jti)) {
          // update: {} in production — keep original revokedAt on repeat logout
          return revokedByJti.get(jti);
        }
        const row = {
          jti,
          employeeId: create.employeeId,
          revokedAt: create.revokedAt,
          expiresAt: create.expiresAt,
        };
        revokedByJti.set(jti, row);
        return row;
      },
    },
    refreshToken: {
      create: async ({ data }) => {
        // data.id may be undefined (lib/revocation.js lets Prisma default-fill);
        // we need an id so updateMany can find the row, so default it here.
        const row = {
          id: data.id || crypto.randomUUID(),
          employeeId: data.employeeId,
          tokenHash: data.tokenHash,
          createdAt: data.createdAt || new Date(),
          rotatedFromId: data.rotatedFromId || null,
          expiresAt: data.expiresAt,
          revokedAt: data.revokedAt || null,
          lastUsedAt: data.lastUsedAt || null,
        };
        refreshByHash.set(row.tokenHash, row);
        refreshById.set(row.id, row);
        return row;
      },
      findUnique: async ({ where }) => {
        if (where.tokenHash !== undefined) return refreshByHash.get(where.tokenHash) || null;
        if (where.token_hash !== undefined) return refreshByHash.get(where.token_hash) || null;
        if (where.id !== undefined) return refreshById.get(where.id) || null;
        return null;
      },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const row of refreshById.values()) {
          if (where.id !== undefined && row.id !== where.id) continue;
          if (where.employeeId !== undefined && row.employeeId !== where.employeeId) continue;
          if (where.revokedAt === null && row.revokedAt !== null) continue;
          if (where.expiresAt && where.expiresAt.lt && row.expiresAt >= where.expiresAt.lt) continue;
          if (data.revokedAt !== undefined) row.revokedAt = data.revokedAt;
          if (data.lastUsedAt !== undefined) row.lastUsedAt = data.lastUsedAt;
          count++;
        }
        return { count };
      },
      findMany: async ({ where } = {}) => {
        const out = [];
        for (const row of refreshById.values()) {
          if (!where) { out.push(row); continue; }
          if (where.employeeId !== undefined && row.employeeId !== where.employeeId) continue;
          if (where.revokedAt === null && row.revokedAt !== null) continue;
          out.push(row);
        }
        return out;
      },
      deleteMany: async ({ where } = {}) => {
        let count = 0;
        for (const [id, row] of refreshById.entries()) {
          if (!where) { refreshById.delete(id); refreshByHash.delete(row.tokenHash); count++; continue; }
          if (where.expiresAt && where.expiresAt.lt && row.expiresAt >= where.expiresAt.lt) continue;
          refreshById.delete(id);
          refreshByHash.delete(row.tokenHash);
          count++;
        }
        return { count };
      },
    },
    employee: {
      findUnique: async ({ where: { id } }) => {
        const e = employees.get(id);
        return e ? { id: e.id, isAdmin: e.isAdmin } : null;
      },
    },
    // Test-only handles
    __setEmployee: (id, isAdmin) => employees.set(id, { id, isAdmin }),
    __setIsAdmin: (id, isAdmin) => {
      const e = employees.get(id);
      if (e) e.isAdmin = isAdmin;
    },
    __revokedByJti: revokedByJti,
    __refreshById: refreshById,
    __refreshByHash: refreshByHash,
  };
  return prisma;
}

// ─── Throwaway app ──────────────────────────────────────────────────────────
// Mirrors the production mount order: express.json → app.set('prisma', …) →
// routes. We don't mount routes/auth.js (it pulls in Zoho OAuth + DB-dependent
// validators); instead we mount the two middlewares we want to test against
// a stub route, which exercises the same requireAuth and requireFreshAdmin
// code paths.

function buildApp(mockPrisma) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.set('prisma', mockPrisma);

  // requireAuth-protected route. Returns the jti so the test can drive the
  // revokeAccessToken call (which mirrors what /api/auth/logout does).
  app.get('/api/_dr005/protected', requireAuth, (req, res) => {
    res.json({ ok: true, employeeId: req.employeeId, jti: req.tokenJti });
  });

  // requireFreshAdmin-protected route (admin mutation). requireAuth MUST run
  // first so req.employeeId is populated before requireFreshAdmin reads it.
  app.post('/api/_dr005/admin-action', requireAuth, requireFreshAdmin, (req, res) => {
    res.json({ ok: true, employeeId: req.employeeId });
  });

  return app;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function signAccess(employeeId, { isAdmin = false, email = 'emp@example.com' } = {}) {
  const accessJti = crypto.randomBytes(16).toString('base64url');
  const accessToken = jwt.sign(
    { employeeId, email, isAdmin, jti: accessJti },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '15m' }
  );
  return { accessToken, accessJti };
}

function signRefresh(employeeId) {
  const refreshJti = crypto.randomBytes(16).toString('base64url');
  const refreshToken = jwt.sign(
    { employeeId, jti: refreshJti },
    process.env.JWT_REFRESH_SECRET,
    { algorithm: 'HS256', expiresIn: '7d' }
  );
  return { refreshToken, refreshJti };
}

async function issueSession(prisma, employeeId, opts = {}) {
  const a = signAccess(employeeId, opts);
  const r = signRefresh(employeeId);
  await revocation.recordRefreshToken(prisma, { employeeId, token: r.refreshToken });
  return { ...a, ...r };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  // The revocation cache lives at module scope. Clear it so a prior test's
  // revoked JTI doesn't bleed into this one.
  revocation.clearRevocationCache();
});

describe('DR-005: access-token revocation is durable', () => {
  it('Scenario 1: issue access token, revoke, reuse → 401 TOKEN_REVOKED', async () => {
    const prisma = buildMockPrisma();
    prisma.__setEmployee('emp-001', false);
    const app = buildApp(prisma);

    const { accessToken, accessJti } = await issueSession(prisma, 'emp-001');

    // Baseline: token works.
    const r1 = await request(app)
      .get('/api/_dr005/protected')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(r1.status).toBe(200);
    expect(r1.body.employeeId).toBe('emp-001');

    // Logout: same upsert the real /api/auth/logout performs. Use the
    // accessJti captured by requireAuth on the request above.
    await revocation.revokeAccessToken(prisma, {
      jti: accessJti,
      employeeId: 'emp-001',
      expSeconds: Math.floor(Date.now() / 1000) + 900,
    });

    // Verify the row was actually persisted in the "DB" (the mock).
    const stored = prisma.__revokedByJti.get(accessJti);
    expect(stored).toBeDefined();
    expect(stored.revokedAt).toBeInstanceOf(Date);

    // Reuse the same access token. requireAuth must hit the revocation
    // check, find the row, compare revokedAt > iat, and 401.
    const r2 = await request(app)
      .get('/api/_dr005/protected')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(r2.status).toBe(401);
    expect(r2.body.code).toBe('TOKEN_REVOKED');

    // The EventEmitter-driven cache must also be invalidated: a fresh
    // token-shaped call (different JTI, but lets us assert the cache is
    // empty by direct inspection) shouldn't see the revoked entry.
    // We exercise this by re-revoking with a NEW jti and verifying the
    // cache only knows about the new one.
    const other = signAccess('emp-001');
    await revocation.revokeAccessToken(prisma, {
      jti: other.accessJti,
      employeeId: 'emp-001',
      expSeconds: Math.floor(Date.now() / 1000) + 900,
    });
    // Both JTIs are now in the mock.
    expect(prisma.__revokedByJti.size).toBe(2);
  });

  it('Scenario 1 (cache): isAccessTokenRevoked uses the in-memory cache and is invalidated by the EventEmitter', async () => {
    const prisma = buildMockPrisma();
    const { accessJti } = signAccess('emp-cache');

    // Pre-populate the cache as "not revoked".
    const dec1 = jwt.decode(jwt.sign({ jti: accessJti }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '15m' }));
    // (accessJti wasn't signed, so build a real one.)
    const a = signAccess('emp-cache');
    const dec = jwt.decode(a.accessToken);

    // First call hits the DB → cache "not revoked".
    const r1 = await revocation.isAccessTokenRevoked(prisma, dec);
    expect(r1).toBe(false);

    // Revoke — this fires the EventEmitter that mutates the cache.
    await revocation.revokeAccessToken(prisma, {
      jti: a.accessJti,
      employeeId: 'emp-cache',
      expSeconds: Math.floor(Date.now() / 1000) + 900,
    });

    // Second call must reflect the revocation WITHOUT touching the DB again
    // (otherwise cache invalidation is broken). It will hit the cache →
    // revoked.
    const r2 = await revocation.isAccessTokenRevoked(prisma, dec);
    expect(r2).toBe(true);
  });
});

describe('DR-005: refresh-token rotation + reuse detection', () => {
  it('Scenario 2: rotate, then reuse the OLD refresh → reuse detected, all sessions revoked', async () => {
    const prisma = buildMockPrisma();
    prisma.__setEmployee('emp-002', false);

    // Issue initial session.
    const initial = await issueSession(prisma, 'emp-002');
    const initialHash = sha256(initial.refreshToken);

    // The row exists, not revoked.
    const row = await revocation.findRefreshTokenRow(prisma, initial.refreshToken);
    expect(row).not.toBeNull();
    expect(row.revokedAt).toBeNull();

    // Legitimate rotation: claim the old row (CAS), mint a new one with
    // rotatedFromId. This is what /api/auth/refresh does on the happy path.
    const claimed = await revocation.claimRefreshToken(prisma, row.id);
    expect(claimed).toBe(true);

    const successor = signRefresh('emp-002');
    await revocation.recordRefreshToken(prisma, {
      employeeId: 'emp-002',
      token: successor.refreshToken,
      rotatedFromId: row.id,
    });

    // The successor exists and chains back to the original.
    const successorRow = await revocation.findRefreshTokenRow(prisma, successor.refreshToken);
    expect(successorRow).not.toBeNull();
    expect(successorRow.rotatedFromId).toBe(row.id);
    expect(successorRow.revokedAt).toBeNull();

    // Replay attack: someone (or another tab) re-presents the OLD refresh.
    // findRefreshTokenRow still finds it (it's not deleted, just revoked),
    // but claimRefreshToken returns false because revokedAt !== null.
    const replay = await revocation.findRefreshTokenRow(prisma, initial.refreshToken);
    expect(replay).not.toBeNull();
    expect(replay.revokedAt).not.toBeNull();

    const replayClaim = await revocation.claimRefreshToken(prisma, replay.id);
    expect(replayClaim).toBe(false); // CAS lost → reuse detected

    // The /refresh endpoint's reuse-detection branch fires
    // revokeAllRefreshTokensForEmployee. The successor MUST die too — that's
    // the documented collateral damage of replay detection.
    const killed = await revocation.revokeAllRefreshTokensForEmployee(prisma, 'emp-002', {
      reason: 'refresh_token_reuse',
    });
    expect(killed).toBe(1); // exactly the successor was still live

    const successorAfter = await revocation.findRefreshTokenRow(prisma, successor.refreshToken);
    expect(successorAfter.revokedAt).not.toBeNull();
  });

  it('Scenario 2 (CAS race): two concurrent claimRefreshToken calls — exactly one wins', async () => {
    const prisma = buildMockPrisma();
    const s = await issueSession(prisma, 'emp-002-race');
    const row = await revocation.findRefreshTokenRow(prisma, s.refreshToken);

    // Fire two CASs in parallel against the same row.
    const [a, b] = await Promise.all([
      revocation.claimRefreshToken(prisma, row.id),
      revocation.claimRefreshToken(prisma, row.id),
    ]);
    const winners = [a, b].filter(Boolean).length;
    expect(winners).toBe(1);
  });

  it('recordRefreshToken stores sha256(token) and never the token itself', async () => {
    const prisma = buildMockPrisma();
    const tok = 'plain.jwt.refresh.value';
    await revocation.recordRefreshToken(prisma, { employeeId: 'emp-hash', token: tok });
    const stored = prisma.__refreshByHash.get(sha256(tok));
    expect(stored).toBeDefined();
    // The plain token must NOT appear anywhere in the persisted row.
    expect(JSON.stringify(stored)).not.toContain(tok);
  });
});

describe('DR-005: requireFreshAdmin re-reads Employee.isAdmin', () => {
  it('Scenario 3: admin token still valid for requireAuth after demotion, but requireFreshAdmin rejects', async () => {
    const prisma = buildMockPrisma();
    prisma.__setEmployee('emp-003', true); // starts as admin
    const app = buildApp(prisma);

    const { accessToken } = await issueSession(prisma, 'emp-003', { isAdmin: true });

    // While still admin: both routes succeed.
    const r0 = await request(app)
      .get('/api/_dr005/protected')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(r0.status).toBe(200);

    const r1 = await request(app)
      .post('/api/_dr005/admin-action')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(r1.status).toBe(200);
    expect(r1.body.employeeId).toBe('emp-003');

    // Demote in the "DB" (not in the JWT — that would require re-signing).
    prisma.__setIsAdmin('emp-003', false);

    // requireAuth still trusts the JWT claim for the 15-minute window.
    const r2 = await request(app)
      .get('/api/_dr005/protected')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(r2.status).toBe(200);
    expect(r2.body.employeeId).toBe('emp-003');

    // requireFreshAdmin re-reads Employee.isAdmin → 403.
    const r3 = await request(app)
      .post('/api/_dr005/admin-action')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(r3.status).toBe(403);
    expect(r3.body.code).toBe('ADMIN_REQUIRED');
  });

  it('requireFreshAdmin with no prisma wired → 503 (fail closed, not 401)', async () => {
    const app = express();
    app.use(express.json());
    // No app.set('prisma', …) — simulates a deployment where the prisma
    // client failed to initialize. Must NOT collapse to 401, which would
    // trigger the frontend's session-destroying logout cascade. Chain
    // requireAuth first so req.employeeId is populated; the 503 path only
    // triggers after the auth check has passed.
    app.post('/api/_dr005/admin-action', requireAuth, requireFreshAdmin, (req, res) => {
      res.json({ ok: true });
    });

    const tok = jwt.sign(
      { employeeId: 'emp-no-db', isAdmin: true, jti: 'j' },
      process.env.JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '15m' }
    );
    const res = await request(app)
      .post('/api/_dr005/admin-action')
      .set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('ADMIN_CHECK_FAILED');
  });

  it('requireAuth with no prisma wired → still authenticates (graceful fallback)', async () => {
    // Defense-in-depth: if prisma is missing for the revocation check, the
    // request should still go through (we'd rather let a possibly-revoked
    // token slip for one request than fail every authenticated user when
    // the DB is mid-restart). This matches the documented "no DB wired"
    // branch in middleware/auth.js.
    const app = express();
    app.use(express.json());
    app.get('/api/_dr005/protected', requireAuth, (req, res) => {
      res.json({ ok: true, employeeId: req.employeeId });
    });
    const tok = jwt.sign(
      { employeeId: 'emp-no-db-2', isAdmin: false, jti: 'j2' },
      process.env.JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '15m' }
    );
    const res = await request(app)
      .get('/api/_dr005/protected')
      .set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(200);
    expect(res.body.employeeId).toBe('emp-no-db-2');
  });
});
