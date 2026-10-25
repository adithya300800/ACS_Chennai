// DR-034 — refresh recovery hardening.
//
// WHAT THIS PINS DOWN
//
// The refresh-rotation chain has two recovery channels for a client that
// presents an ALREADY-SPENT refresh token:
//
//   (a) the in-memory replay map (30s, per process), and
//   (b) the durable `rotation_receipt` row (survives a restart).
//
// Both exist so that a legitimate loser — a sibling tab that raced the
// winner, or a client whose "response was lost" — is handed the
// winner's pair instead of being mistaken for a thief (which revokes
// EVERY session for the employee).
//
// Three properties are asserted here:
//
//   1. BOUNDED EXPOSURE. The receipt row stores the token pair IN THE
//      CLEAR — it is the one place the schema undoes the sha256-at-rest
//      design of `refresh_token`. Its lifetime IS the exposure window,
//      so it must be bounded (ROTATION_RECEIPT_TTL_MS), not the
//      successor's 7-day lifetime.
//
//   2. THE RECEIPT DIES WITH ITS SESSION. Signing out revokes the
//      successor refresh row but not the predecessor's receipt. Without
//      a successor-liveness check, presenting the OLD token after a
//      logout hands back a working session for a credential the user
//      explicitly retired.
//
//   3. REVOCATION IS COMPLETE AND SCOPED. Revoking an employee's
//      sessions must also delete their durable receipts (they hold
//      usable credentials) — and must NOT disturb an unrelated
//      employee's in-flight rotation.
//
// Plus one regression guard: the legitimate loser must still recover
// inside the bounded window, or every slow retry becomes a forced
// logout.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-must-be-at-least-32-chars-long-BBBB';
process.env.PII_LOG_SALT = process.env.PII_LOG_SALT || 'test-pii-salt-32-chars-min-deadbeef';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const revocation = require('../src/lib/revocation');
const authRouter = require('../src/routes/auth');

// ─── In-memory Prisma mock ──────────────────────────────────────────────────
//
// Mirrors the real schema's behaviour for the four delegates this suite
// touches: refresh_token (by hash / by id), rotation_receipt (by
// spentRowId), employee, and the $transaction wrapper.

function buildMockPrisma() {
  const refreshByHash = new Map();
  const refreshById = new Map();
  const employees = new Map();
  const receiptsBySpentRowId = new Map();

  function makeRow(row) {
    return {
      id: row.id || crypto.randomUUID(),
      employeeId: row.employeeId,
      tokenHash: row.tokenHash,
      createdAt: row.createdAt || new Date(),
      rotatedFromId: row.rotatedFromId || null,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt || null,
      lastUsedAt: row.lastUsedAt || null,
    };
  }

  function buildTxClient() {
    return {
      refreshToken: {
        updateMany: async ({ where, data }) => {
          let count = 0;
          for (const row of refreshById.values()) {
            if (where.id !== undefined && row.id !== where.id) continue;
            if (where.revokedAt === null && row.revokedAt !== null) continue;
            if (data.revokedAt !== undefined) row.revokedAt = data.revokedAt;
            if (data.lastUsedAt !== undefined) row.lastUsedAt = data.lastUsedAt;
            count++;
          }
          return { count };
        },
        create: async ({ data }) => {
          const row = makeRow(data);
          refreshByHash.set(row.tokenHash, row);
          refreshById.set(row.id, row);
          return row;
        },
      },
      rotationReceipt: {
        create: async ({ data }) => {
          if (receiptsBySpentRowId.has(data.spentRowId)) {
            throw new Error('UNIQUE_CONSTRAINT_VIOLATION');
          }
          const row = {
            id: data.id || crypto.randomUUID(),
            spentRowId: data.spentRowId,
            successorRowId: data.successorRowId,
            employeeId: data.employeeId,
            accessToken: data.accessToken,
            refreshToken: data.refreshToken,
            createdAt: data.createdAt || new Date(),
            expiresAt: data.expiresAt,
          };
          receiptsBySpentRowId.set(row.spentRowId, row);
          return row;
        },
      },
    };
  }

  const prisma = {
    refreshToken: {
      findUnique: async ({ where }) => {
        if (where.tokenHash !== undefined) return refreshByHash.get(where.tokenHash) || null;
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
      create: async ({ data }) => {
        const row = makeRow(data);
        refreshByHash.set(row.tokenHash, row);
        refreshById.set(row.id, row);
        return row;
      },
      findMany: async ({ where } = {}) => {
        const out = [];
        for (const row of refreshById.values()) {
          if (where) {
            if (where.employeeId !== undefined && row.employeeId !== where.employeeId) continue;
            if (where.revokedAt === null && row.revokedAt !== null) continue;
          }
          out.push(row);
        }
        return out;
      },
      deleteMany: async ({ where } = {}) => {
        let count = 0;
        for (const [key, row] of refreshById.entries()) {
          if (where?.expiresAt?.lt && !(row.expiresAt < where.expiresAt.lt)) continue;
          refreshById.delete(key);
          refreshByHash.delete(row.tokenHash);
          count++;
        }
        return { count };
      },
    },
    // The access-token revocation table. `requireAuth` consults it on
    // every request (fail-closed), so the mock has to answer it.
    revokedToken: {
      findUnique: async () => null,
      upsert: async ({ create }) => ({ ...create }),
      deleteMany: async () => ({ count: 0 }),
    },
    employee: {
      findUnique: async ({ where: { id } }) => {
        const e = employees.get(id);
        return e ? { id: e.id, email: e.email, isAdmin: e.isAdmin } : null;
      },
    },
    rotationReceipt: {
      findUnique: async ({ where: { spentRowId } }) => receiptsBySpentRowId.get(spentRowId) || null,
      deleteMany: async ({ where } = {}) => {
        let count = 0;
        for (const [key, receipt] of receiptsBySpentRowId.entries()) {
          if (where.employeeId !== undefined && receipt.employeeId !== where.employeeId) continue;
          receiptsBySpentRowId.delete(key);
          count++;
        }
        return { count };
      },
    },
    $transaction: async (cb) => cb(buildTxClient()),
    // Test-only handles
    __setEmployee: (id, opts) => employees.set(id, { id, ...opts }),
    __refreshById: refreshById,
    __refreshByHash: refreshByHash,
    __receiptsBySpentRowId: receiptsBySpentRowId,
  };
  return prisma;
}

function buildApp(mockPrisma) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.set('prisma', mockPrisma);
  app.use('/api/auth', authRouter);
  return app;
}

function signRefresh(employeeId) {
  const refreshToken = jwt.sign(
    { employeeId, jti: crypto.randomBytes(16).toString('base64url') },
    process.env.JWT_REFRESH_SECRET,
    { algorithm: 'HS256', expiresIn: '7d' },
  );
  return { refreshToken };
}

async function issueSession(prisma, employeeId) {
  const r = signRefresh(employeeId);
  await revocation.recordRefreshToken(prisma, { employeeId, token: r.refreshToken });
  return r;
}

beforeEach(() => {
  revocation.clearRevocationCache();
  revocation.clearRotationReplay();
});

describe('DR-034 — rotation receipt is bounded and dies with its session', () => {
  test('the receipt TTL is bounded, not the successor\'s 7-day lifetime', async () => {
    const prisma = buildMockPrisma();
    prisma.__setEmployee('emp-ttl', { email: 't@example.com', isAdmin: false });

    const { refreshToken } = await issueSession(prisma, 'emp-ttl');
    const before = Date.now();
    await request(buildApp(prisma)).post('/api/auth/refresh').send({ refreshToken });

    const receipt = prisma.__receiptsBySpentRowId.values().next().value;
    expect(receipt).toBeDefined();

    const ttl = receipt.expiresAt.getTime() - before;
    // Within the bounded window (plus a generous allowance for clock
    // skew and test scheduling).
    expect(ttl).toBeLessThanOrEqual(revocation.ROTATION_RECEIPT_TTL_MS + 5_000);
    // And decisively NOT the successor's 7-day lifetime — that is the
    // exposure this bound exists to remove.
    expect(ttl).toBeLessThan(60 * 60 * 1000);
    expect(revocation.ROTATION_RECEIPT_TTL_MS).toBeLessThan(24 * 60 * 60 * 1000);
  });

  test('a receipt whose successor was revoked is dead — logout cannot be replayed', async () => {
    const prisma = buildMockPrisma();
    prisma.__setEmployee('emp-logout', { email: 'lo@example.com', isAdmin: false });
    const app = buildApp(prisma);

    const { refreshToken } = await issueSession(prisma, 'emp-logout');

    // Rotate: the OLD token is spent, a successor is minted, a receipt
    // records the pair.
    const r1 = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(r1.status).toBe(200);
    const successorToken = r1.body.refreshToken;

    // The user signs out. POST /logout revokes the refresh token the
    // client presented — the successor.
    const logout = await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${r1.body.accessToken}`)
      .send({ refreshToken: successorToken });
    expect(logout.status).toBe(204);

    // The receipt row itself may still be there, but it must no longer
    // be able to hand out a session.
    const spentRowId = prisma.__refreshByHash.get(
      crypto.createHash('sha256').update(refreshToken).digest('hex'),
    ).id;
    const receipt = await revocation.findRotationReceiptBySpentRowId(prisma, spentRowId);
    expect(receipt).toBeNull();

    // And at the wire: replaying the OLD token must not mint a session.
    // The in-memory replay map is a SEPARATE, much shorter-lived channel
    // (ROTATION_REPLAY_MS = 30s) and its payload is already dead after
    // a logout — the logout revoked both the access token (via
    // revoked_token) and the successor refresh row. Clear it here so
    // this assertion is about the DURABLE channel, which is the one
    // that used to survive for the successor's full 7-day lifetime.
    revocation.clearRotationReplay();
    const replay = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('REFRESH_REUSED');
  });

  test('the legitimate loser still recovers the winner\'s pair inside the window', async () => {
    // The bound must not be so tight that an ordinary sibling-tab race
    // turns into a forced logout for every user. This is the regression
    // guard on the TTL change.
    const prisma = buildMockPrisma();
    prisma.__setEmployee('emp-loser', { email: 'w@example.com', isAdmin: false });
    const app = buildApp(prisma);

    const { refreshToken } = await issueSession(prisma, 'emp-loser');

    const r1 = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(r1.status).toBe(200);

    // Simulate a process restart: the in-memory replay map is gone, the
    // durable receipt is the only way back.
    revocation.clearRotationReplay();

    const r2 = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(r2.status).toBe(200);
    expect(r2.body.accessToken).toBe(r1.body.accessToken);
    expect(r2.body.refreshToken).toBe(r1.body.refreshToken);
  });
});

describe('DR-034 — revocation is complete and scoped', () => {
  test('revoking an employee\'s sessions deletes their durable receipts', async () => {
    const prisma = buildMockPrisma();
    prisma.__setEmployee('emp-revoke', { email: 'r@example.com', isAdmin: false });
    const app = buildApp(prisma);

    const { refreshToken } = await issueSession(prisma, 'emp-revoke');
    await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(prisma.__receiptsBySpentRowId.size).toBe(1);

    await revocation.revokeAllRefreshTokensForEmployee(prisma, 'emp-revoke', {
      reason: 'test',
    });

    // The receipt held a usable credential pair in the clear. Once the
    // session is revoked it must be gone, not merely expired.
    expect(prisma.__receiptsBySpentRowId.size).toBe(0);
  });

  test('revoking one employee does NOT clear another employee\'s in-flight replay entry', async () => {
    // The in-memory replay map is module-scoped and shared by every
    // employee. A global wipe on revoke would make an unrelated
    // employee's concurrent tab miss the fast path — a cross-tenant
    // side effect of a single sign-out.
    const prisma = buildMockPrisma();
    prisma.__setEmployee('emp-a', { email: 'a@example.com', isAdmin: false });
    prisma.__setEmployee('emp-b', { email: 'b@example.com', isAdmin: false });

    revocation.rememberRotation('row-a', { accessToken: 'a-access', refreshToken: 'a-refresh' }, 'emp-a');
    revocation.rememberRotation('row-b', { accessToken: 'b-access', refreshToken: 'b-refresh' }, 'emp-b');

    await revocation.revokeAllRefreshTokensForEmployee(prisma, 'emp-a', { reason: 'test' });

    expect(revocation.takeRotationReplay('row-a')).toBeNull();
    expect(revocation.takeRotationReplay('row-b')).toEqual({
      accessToken: 'b-access',
      refreshToken: 'b-refresh',
    });
  });
});
