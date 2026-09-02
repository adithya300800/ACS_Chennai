// Standalone smoke test for the round-20 DR-005 durable revocation changes.
// Mirrors the jest test (backend/__tests__/revocation.test.js) but uses
// raw node + supertest directly, because jest is hanging in this sandbox
// (same root cause documented in smoke_dr010.js).
//
// Run with: node __tests__/smoke_dr005.js
'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-must-be-at-least-32-chars-BBBB';
process.env.PII_LOG_SALT = process.env.PII_LOG_SALT || 'test-pii-salt-32-chars-min-deadbeef';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';

const assert = require('assert');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const express = require('express');
const http = require('http');

const revocation = require('../src/lib/revocation');
const { requireAuth, requireFreshAdmin } = require('../src/middleware/auth');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

let pass = 0, fail = 0;
function t(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log(`  ok  ${name}`); },
    (err) => { fail++; console.log(`  FAIL ${name}: ${err && err.message ? err.message : err}`); }
  );
}

// ─── In-memory mock Prisma (same as the jest test) ────────────────────────
function buildMockPrisma() {
  const revokedByJti = new Map();
  const refreshByHash = new Map();
  const refreshById = new Map();
  const employees = new Map();

  const prisma = {
    revokedToken: {
      findUnique: async ({ where: { jti } }) => {
        const row = revokedByJti.get(jti);
        return row ? { jti, revokedAt: row.revokedAt, expiresAt: row.expiresAt } : null;
      },
      upsert: async ({ where: { jti }, create }) => {
        if (revokedByJti.has(jti)) return revokedByJti.get(jti);
        const row = { jti, employeeId: create.employeeId, revokedAt: create.revokedAt, expiresAt: create.expiresAt };
        revokedByJti.set(jti, row);
        return row;
      },
    },
    refreshToken: {
      create: async ({ data }) => {
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
    __setEmployee: (id, isAdmin) => employees.set(id, { id, isAdmin }),
    __setIsAdmin: (id, isAdmin) => { const e = employees.get(id); if (e) e.isAdmin = isAdmin; },
    __revokedByJti: revokedByJti,
    __refreshById: refreshById,
  };
  return prisma;
}

// ─── Throwaway app + real supertest (supertest talks to http.Server) ──────
function buildApp(mockPrisma) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.set('prisma', mockPrisma);
  app.get('/api/_dr005/protected', requireAuth, (req, res) => {
    res.json({ ok: true, employeeId: req.employeeId, jti: req.tokenJti });
  });
  // requireAuth MUST run first so req.employeeId is populated; requireFreshAdmin
  // reads req.employeeId to look up the live Employee row.
  app.post('/api/_dr005/admin-action', requireAuth, requireFreshAdmin, (req, res) => {
    res.json({ ok: true, employeeId: req.employeeId });
  });
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const srv = http.createServer(app).listen(0, () => resolve(srv));
  });
}
function req(srv, method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const port = srv.address().port;
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      method, hostname: '127.0.0.1', port, path,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data ? Buffer.byteLength(data) : 0,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch {}
        resolve({ status: res.statusCode, body: json });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

// ─── Token helpers ────────────────────────────────────────────────────────
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

(async () => {
  console.log('DR-005 smoke (mirrors backend/__tests__/revocation.test.js)');

  // ── Scenario 1: revocation is durable ───────────────────────────────
  await t('Scenario 1.a: token works before logout', async () => {
    const prisma = buildMockPrisma();
    prisma.__setEmployee('emp-001', false);
    const srv = await listen(buildApp(prisma));
    const { accessToken, accessJti } = await issueSession(prisma, 'emp-001');
    const r = await req(srv, 'GET', '/api/_dr005/protected', { token: accessToken });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.employeeId, 'emp-001');
    await revocation.revokeAccessToken(prisma, {
      jti: accessJti, employeeId: 'emp-001',
      expSeconds: Math.floor(Date.now()/1000) + 900,
    });
    const r2 = await req(srv, 'GET', '/api/_dr005/protected', { token: accessToken });
    assert.strictEqual(r2.status, 401);
    assert.strictEqual(r2.body.code, 'TOKEN_REVOKED');
    srv.close();
  });

  await t('Scenario 1.b: cache invalidation via EventEmitter', async () => {
    const prisma = buildMockPrisma();
    revocation.clearRevocationCache();
    const a = signAccess('emp-cache');
    const dec = jwt.decode(a.accessToken);
    const r1 = await revocation.isAccessTokenRevoked(prisma, dec);
    assert.strictEqual(r1, false);
    await revocation.revokeAccessToken(prisma, {
      jti: a.accessJti, employeeId: 'emp-cache',
      expSeconds: Math.floor(Date.now()/1000) + 900,
    });
    const r2 = await revocation.isAccessTokenRevoked(prisma, dec);
    assert.strictEqual(r2, true);
  });

  // ── Scenario 2: refresh rotation + reuse detection ─────────────────
  await t('Scenario 2.a: rotate, replay old → all sessions revoked', async () => {
    const prisma = buildMockPrisma();
    prisma.__setEmployee('emp-002', false);
    const initial = await issueSession(prisma, 'emp-002');
    const row = await revocation.findRefreshTokenRow(prisma, initial.refreshToken);
    assert.ok(row, 'initial row exists');
    assert.strictEqual(row.revokedAt, null);

    const claimed = await revocation.claimRefreshToken(prisma, row.id);
    assert.strictEqual(claimed, true);

    const successor = signRefresh('emp-002');
    await revocation.recordRefreshToken(prisma, {
      employeeId: 'emp-002', token: successor.refreshToken, rotatedFromId: row.id,
    });
    const successorRow = await revocation.findRefreshTokenRow(prisma, successor.refreshToken);
    assert.ok(successorRow);
    assert.strictEqual(successorRow.rotatedFromId, row.id);

    const replay = await revocation.findRefreshTokenRow(prisma, initial.refreshToken);
    assert.ok(replay.revokedAt, 'replayed row is now revoked');
    const replayClaim = await revocation.claimRefreshToken(prisma, replay.id);
    assert.strictEqual(replayClaim, false);

    const killed = await revocation.revokeAllRefreshTokensForEmployee(prisma, 'emp-002', { reason: 'refresh_token_reuse' });
    assert.strictEqual(killed, 1);
    const succAfter = await revocation.findRefreshTokenRow(prisma, successor.refreshToken);
    assert.ok(succAfter.revokedAt, 'successor also killed');
  });

  await t('Scenario 2.b: CAS race — exactly one of two parallel claims wins', async () => {
    const prisma = buildMockPrisma();
    const s = await issueSession(prisma, 'emp-002-race');
    const row = await revocation.findRefreshTokenRow(prisma, s.refreshToken);
    const [a, b] = await Promise.all([
      revocation.claimRefreshToken(prisma, row.id),
      revocation.claimRefreshToken(prisma, row.id),
    ]);
    const winners = [a, b].filter(Boolean).length;
    assert.strictEqual(winners, 1);
  });

  await t('Scenario 2.c: refresh row stores sha256(token), never the token', async () => {
    const prisma = buildMockPrisma();
    const tok = 'plain.jwt.refresh.value';
    await revocation.recordRefreshToken(prisma, { employeeId: 'emp-hash', token: tok });
    const stored = prisma.__refreshById.get([...prisma.__refreshById.keys()][0]);
    assert.ok(stored);
    assert.strictEqual(stored.tokenHash, sha256(tok));
    assert.ok(!JSON.stringify(stored).includes(tok));
  });

  // ── Scenario 3: requireFreshAdmin re-reads the DB ──────────────────
  await t('Scenario 3.a: demote admin → requireAuth OK, requireFreshAdmin 403', async () => {
    const prisma = buildMockPrisma();
    prisma.__setEmployee('emp-003', true);
    const srv = await listen(buildApp(prisma));
    const { accessToken } = await issueSession(prisma, 'emp-003', { isAdmin: true });

    const r1 = await req(srv, 'POST', '/api/_dr005/admin-action', { token: accessToken });
    assert.strictEqual(r1.status, 200);

    prisma.__setIsAdmin('emp-003', false);

    const r2 = await req(srv, 'GET', '/api/_dr005/protected', { token: accessToken });
    assert.strictEqual(r2.status, 200);

    const r3 = await req(srv, 'POST', '/api/_dr005/admin-action', { token: accessToken });
    assert.strictEqual(r3.status, 403);
    assert.strictEqual(r3.body.code, 'ADMIN_REQUIRED');
    srv.close();
  });

  await t('Scenario 3.b: requireFreshAdmin with no prisma wired → 503 (fail closed)', async () => {
    const app = express();
    app.use(express.json());
    // Chain requireAuth first so req.employeeId is set; requireFreshAdmin's
    // 503 path only triggers after we've passed the auth check.
    app.post('/api/_dr005/admin-action', requireAuth, requireFreshAdmin, (req, res) => res.json({ ok: true }));
    const srv = await listen(app);
    const tok = jwt.sign(
      { employeeId: 'emp-no-db', isAdmin: true, jti: 'j' },
      process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '15m' }
    );
    const r = await req(srv, 'POST', '/api/_dr005/admin-action', { token: tok });
    assert.strictEqual(r.status, 503);
    assert.strictEqual(r.body.code, 'ADMIN_CHECK_FAILED');
    srv.close();
  });

  await t('Scenario 3.c: requireAuth with no prisma wired → graceful fallback (200)', async () => {
    const app = express();
    app.use(express.json());
    app.get('/api/_dr005/protected', requireAuth, (req, res) => res.json({ ok: true, employeeId: req.employeeId }));
    const srv = await listen(app);
    const tok = jwt.sign(
      { employeeId: 'emp-no-db-2', isAdmin: false, jti: 'j2' },
      process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '15m' }
    );
    const r = await req(srv, 'GET', '/api/_dr005/protected', { token: tok });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.employeeId, 'emp-no-db-2');
    srv.close();
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('SMOKE CRASHED', err);
  process.exit(2);
});
