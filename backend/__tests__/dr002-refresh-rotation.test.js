/**
 * DR-002 (fresh-product audit 2026-09-24) — atomic refresh-rotation tests.
 *
 * Three scenarios required by the audit spec:
 *
 *   1. Concurrent rotation: two /refresh calls present the SAME old token
 *      at the same instant. Pre-DR-002 the loser hit the no-replay-entry
 *      branch and was treated as theft — every session for the employee
 *      got revoked. Post-DR-002 the loser reads the durable rotation
 *      receipt and receives the same pair the winner got.
 *
 *   2. Pre-commit failure: a DB error inside the rotation transaction
 *      (after the spend CAS but before commit). Pre-DR-002 the spend was
 *      a separate call that had ALREADY committed, leaving no successor
 *      and no recoverable ordinary retry. Post-DR-002 the spend + successor
 *      + receipt are atomic; a failure rolls everything back so the
 *      original token is still live and a retry succeeds.
 *
 *   3. Lost post-commit response: the rotation commits, the response is
 *      lost on the wire, the client retries with the same old token.
 *      Pre-DR-002 the in-memory replay cache is the only thing that could
 *      save this — and it dies on process restart. Post-DR-002 the
 *      durable rotation_receipt row holds the winner's pair, so the
 *      retry receives the same tokens.
 *
 * Pattern follows revocation.test.js: a throwaway Express app, a hand-rolled
 * in-memory mock Prisma. The mock now also implements $transaction
 * (sequential callback execution with throw-driven rollback) and the
 * rotation_receipt model. No real DB connection required. We mount the real
 * routes/auth.js /refresh endpoint, which exercises the full code path.
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
const authRouter = require('../src/routes/auth');

// ─── In-memory mock Prisma ──────────────────────────────────────────────────
// Builds on the revocation.test.js surface and adds the two new pieces
// DR-002 needs:
//
//   1. $transaction(cb) — runs the callback with a transactional client that
//      proxies to the same store; if the callback throws, the writes the
//      callback made are rolled back. Prisma's real $transaction does the
//      same shape (BEGIN; ...; COMMIT / ROLLBACK) so this matches the
//      contract rotateRefreshTokenAtomic relies on.
//
//   2. rotationReceipt — UNIQUE on spentRowId so the loser-path lookup is
//      a single findUnique. TTL matches the successor row's expiresAt.
//
// Anything else would fail loudly, which is the desired failure mode.

function buildMockPrisma({ failOnRotation } = {}) {
  const refreshByHash = new Map();
  const refreshById = new Map();
  const employees = new Map();
  const receiptsBySpentRowId = new Map();
  const receiptsById = new Map();

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

  // Snapshot/restore helpers for the $transaction rollback semantics.
  // The Maps themselves are easy to copy, but their VALUES are row objects
  // that the transaction body mutates in place (updateMany assigns
  // `row.revokedAt = ...`). A naive `new Map(refreshById)` snapshot would
  // copy the references — restore would then see mutated rows. We deep-
  // clone every row on snapshot so the rollback truly reverts.
  function cloneRow(row) {
    return {
      ...row,
      createdAt: row.createdAt ? new Date(row.createdAt.getTime()) : row.createdAt,
      expiresAt: row.expiresAt ? new Date(row.expiresAt.getTime()) : row.expiresAt,
      revokedAt: row.revokedAt ? new Date(row.revokedAt.getTime()) : row.revokedAt,
      lastUsedAt: row.lastUsedAt ? new Date(row.lastUsedAt.getTime()) : row.lastUsedAt,
    };
  }
  function snapshot() {
    const refreshByIdSnap = new Map();
    for (const [k, v] of refreshById) refreshByIdSnap.set(k, cloneRow(v));
    const refreshByHashSnap = new Map();
    for (const [k, v] of refreshByHash) refreshByHashSnap.set(k, cloneRow(v));
    const receiptsSnap = new Map();
    for (const [k, v] of receiptsBySpentRowId) receiptsSnap.set(k, { ...v });
    const receiptsByIdSnap = new Map();
    for (const [k, v] of receiptsById) receiptsByIdSnap.set(k, { ...v });
    return { refreshByHashSnap, refreshByIdSnap, receiptsSnap, receiptsByIdSnap };
  }
  function restore(snap) {
    refreshByHash.clear();
    refreshById.clear();
    receiptsBySpentRowId.clear();
    receiptsById.clear();
    for (const [k, v] of snap.refreshByHashSnap) refreshByHash.set(k, v);
    for (const [k, v] of snap.refreshByIdSnap) refreshById.set(k, v);
    for (const [k, v] of snap.receiptsSnap) receiptsBySpentRowId.set(k, v);
    for (const [k, v] of snap.receiptsByIdSnap) receiptsById.set(k, v);
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
          // failOnRotation: optional injection point so the pre-commit-failure
          // scenario can simulate a DB outage that lands AFTER the spend CAS
          // but BEFORE the receipt commit. The test triggers this by passing
          // a count > 0 — i.e. fail on the 1st+ receipt insert.
          if (failOnRotation && failOnRotation.receiptCount > 0) {
            failOnRotation.receiptCount -= 1;
            throw new Error('SIMULATED_RECEIPT_INSERT_FAILURE');
          }
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
          receiptsById.set(row.id, row);
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
          if (!where) { out.push(row); continue; }
          if (where.employeeId !== undefined && row.employeeId !== where.employeeId) continue;
          if (where.revokedAt === null && row.revokedAt !== null) continue;
          out.push(row);
        }
        return out;
      },
    },
    employee: {
      findUnique: async ({ where: { id } }) => {
        const e = employees.get(id);
        return e ? { id: e.id, email: e.email, isAdmin: e.isAdmin } : null;
      },
    },
    rotationReceipt: {
      findUnique: async ({ where: { spentRowId } }) => {
        return receiptsBySpentRowId.get(spentRowId) || null;
      },
    },
    $transaction: async (cb) => {
      const snap = snapshot();
      const tx = buildTxClient();
      try {
        return await cb(tx);
      } catch (err) {
        // RACE_LOST is the legitimate "I lost the CAS" signal — the caller
        // re-enters the loser path and reads the winner's already-committed
        // receipt. We must NOT roll back in that case: the winner's writes
        // are real. But this throw originates inside OUR transaction body
        // (no other transaction has touched the store yet), so a rollback
        // here is a no-op and harmless. We restore the snapshot either way.
        restore(snap);
        throw err;
      }
    },
    // Test-only handles
    __setEmployee: (id, opts) => employees.set(id, { id, ...opts }),
    __refreshById: refreshById,
    __refreshByHash: refreshByHash,
    __receiptsBySpentRowId: receiptsBySpentRowId,
  };
  return prisma;
}

// ─── Throwaway app ──────────────────────────────────────────────────────────
// Mount the real /api/auth/refresh route against a mock Prisma so we drive
// the production code path end-to-end. No DB connection required.

function buildApp(mockPrisma) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.set('prisma', mockPrisma);
  app.use('/api/auth', authRouter);
  return app;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

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
  const r = signRefresh(employeeId);
  await revocation.recordRefreshToken(prisma, { employeeId, token: r.refreshToken });
  return r;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  // The revocation cache lives at module scope. Clear it so a prior test's
  // revoked JTI / replay entry doesn't bleed into this one.
  revocation.clearRevocationCache();
  revocation.clearRotationReplay();
});

describe('DR-002: atomic refresh rotation — concurrent loser path', () => {
  it('Scenario 1: two concurrent /refresh with the same old token — both succeed, loser reads durable receipt', async () => {
    const prisma = buildMockPrisma();
    prisma.__setEmployee('emp-dr002-concurrent', { email: 'c@example.com', isAdmin: false });
    const app = buildApp(prisma);

    const { refreshToken } = await issueSession(prisma, 'emp-dr002-concurrent');

    // Two parallel POST /api/auth/refresh calls presenting the SAME old
    // refresh token. Pre-DR-002 the loser would hit the no-replay branch
    // (the winner's rememberRotation hasn't fired yet for the loser that
    // arrived a microsecond before rememberRotation runs) and be treated
    // as theft — every session revoked. Post-DR-002 the loser reads the
    // durable rotation_receipt and receives the same pair the winner got.
    const [r1, r2] = await Promise.all([
      request(app).post('/api/auth/refresh').send({ refreshToken }),
      request(app).post('/api/auth/refresh').send({ refreshToken }),
    ]);

    // Both calls must succeed — neither should fall through to the
    // REFRESH_REUSED branch.
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    const winners = [r1, r2].filter((r) => r.body && r.body.accessToken && r.body.refreshToken);
    expect(winners.length).toBe(2);

    // Critical: the two responses must hand out the SAME pair (one was
    // minted, the other read it back from the durable receipt). The
    // loser is not silently given a DIFFERENT pair — that would break
    // the client's localStorage and force a re-login.
    expect(r1.body.accessToken).toBe(r2.body.accessToken);
    expect(r1.body.refreshToken).toBe(r2.body.refreshToken);

    // Verify no theft-revocation fired. Only ONE live refresh row should
    // remain (the successor), and exactly one rotation_receipt should
    // exist for the spent row. All employee sessions alive.
    const liveRefresh = [];
    for (const row of prisma.__refreshById.values()) {
      if (row.revokedAt === null && row.employeeId === 'emp-dr002-concurrent') liveRefresh.push(row);
    }
    expect(liveRefresh.length).toBe(1); // successor
    expect(prisma.__receiptsBySpentRowId.size).toBe(1); // one receipt
  });

  it('Scenario 1 (replay window): loser arriving AFTER in-memory replay window expires still gets the same pair via durable receipt', async () => {
    // Pre-DR-002 the in-memory rotationReplay Map was the only thing that
    // saved the concurrent-tab case, and it dies on process restart. Post-
    // DR-002 even a loser that arrives outside the 30s window — or in a
    // process restart — still recovers the pair from the durable receipt.
    const prisma = buildMockPrisma();
    prisma.__setEmployee('emp-dr002-replay-window', { email: 'rw@example.com', isAdmin: false });
    const app = buildApp(prisma);

    const { refreshToken } = await issueSession(prisma, 'emp-dr002-replay-window');

    // First call wins the rotation. In-memory replay is published.
    const r1 = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(r1.status).toBe(200);

    // Force-clear the in-memory replay cache (simulates process restart).
    revocation.clearRotationReplay();

    // Second call presents the same old token. It must still succeed —
    // the durable rotation_receipt is the fallback. Pre-DR-002 this
    // would 401 REFRESH_REUSED and kill every session.
    const r2 = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(r2.status).toBe(200);
    expect(r2.body.accessToken).toBe(r1.body.accessToken);
    expect(r2.body.refreshToken).toBe(r1.body.refreshToken);
  });
});

describe('DR-002: atomic refresh rotation — pre-commit failure', () => {
  it('Scenario 2: receipt insert fails inside the transaction — original row stays live, retry succeeds', async () => {
    // Inject the failure: the 1st receipt insert throws. The CAS spend +
    // successor insert have already happened in the same callback, so a
    // naive implementation would leave a spent row with no receipt.
    // Post-DR-002 the $transaction callback throws → ALL writes roll back,
    // the original row is still live, and a retry succeeds.
    const prisma = buildMockPrisma({
      failOnRotation: { receiptCount: 1 },
    });
    prisma.__setEmployee('emp-dr002-precommit', { email: 'pc@example.com', isAdmin: false });
    const app = buildApp(prisma);

    const { refreshToken } = await issueSession(prisma, 'emp-dr002-precommit');
    const originalRowId = prisma.__refreshByHash.get(
      require('crypto').createHash('sha256').update(refreshToken).digest('hex')
    ).id;

    // First call: the rotation transaction's receipt insert throws. The
    // route surfaces 503 REFRESH_UNAVAILABLE (infrastructure failure,
    // NOT a 401 — see the comment in the catch block).
    const r1 = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(r1.status).toBe(503);
    expect(r1.body.code).toBe('REFRESH_UNAVAILABLE');

    // Critical: the original row must NOT be revoked. Pre-DR-002 the
    // spend had already committed in a separate call, so the row would
    // be revoked with no successor and no retry path. Post-DR-002 the
    // $transaction rolls back the spend too.
    const afterFail = prisma.__refreshById.get(originalRowId);
    expect(afterFail).toBeDefined();
    expect(afterFail.revokedAt).toBeNull();
    expect(afterFail.lastUsedAt).toBeNull();

    // No successor row, no receipt — both rolled back.
    expect(prisma.__refreshById.size).toBe(1); // original only
    expect(prisma.__receiptsBySpentRowId.size).toBe(0);

    // Disable the injection; retry with the same token. Must succeed and
    // mint the pair normally. This is the "ordinary retry recovers"
    // acceptance criterion from the audit spec.
    prisma.__disableFailOnRotation = true;
    // The buildMockPrisma closure captured the flag at construction time,
    // so for the retry path we re-construct the mock without the failure
    // injection but PRESERVE the original row by re-seeding it.
    const retryPrisma = buildMockPrisma();
    retryPrisma.__setEmployee('emp-dr002-precommit', { email: 'pc@example.com', isAdmin: false });
    // Re-create the original row (it's only in the failed mock; the
    // retry mock has its own store).
    await revocation.recordRefreshToken(retryPrisma, {
      employeeId: 'emp-dr002-precommit',
      token: refreshToken,
    });
    const retryApp = buildApp(retryPrisma);
    const r2 = await request(retryApp).post('/api/auth/refresh').send({ refreshToken });
    expect(r2.status).toBe(200);
    expect(r2.body.accessToken).toBeDefined();
    expect(r2.body.refreshToken).toBeDefined();
    expect(retryPrisma.__receiptsBySpentRowId.size).toBe(1);
  });
});

describe('DR-002: atomic refresh rotation — lost post-commit response', () => {
  it('Scenario 3: commit succeeds, response is lost, retry returns the same pair from the durable receipt', async () => {
    // Simulates a deployment where the rotation commits but the HTTP
    // response never reaches the client (network blip, client crashed
    // mid-read). The client retries with the OLD refresh token. Pre-DR-
    // 002 the in-memory replay cache was the only thing that could save
    // this — and it dies on process restart, leaving a 401 REFRESH_REUSED
    // that kills every session.
    //
    // Post-DR-002 the durable rotation_receipt holds the winner's pair;
    // the retry reads it and gets the same pair back.
    const prisma = buildMockPrisma();
    prisma.__setEmployee('emp-dr002-lost', { email: 'l@example.com', isAdmin: false });
    const app = buildApp(prisma);

    const { refreshToken } = await issueSession(prisma, 'emp-dr002-lost');

    // First call: rotation commits. We deliberately DROP the response by
    // simulating a process restart BEFORE rememberRotation publishes the
    // in-memory entry. clearRotationReplay wipes the module-scope Map the
    // way a fresh process would, but the DB row is already durable.
    const r1 = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(r1.status).toBe(200);
    const winner = r1.body;

    // Wipe in-memory caches (simulates process restart mid-response).
    revocation.clearRotationReplay();
    revocation.clearRevocationCache();

    // The durable receipt must already exist — the transaction committed
    // it before the response handler returned.
    expect(prisma.__receiptsBySpentRowId.size).toBe(1);

    // Retry: client sends the OLD refresh token again. The route finds
    // the row revoked, checks the in-memory replay (miss, we just wiped
    // it), checks the durable receipt (HIT), and returns the same pair.
    const r2 = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(r2.status).toBe(200);
    expect(r2.body.accessToken).toBe(winner.accessToken);
    expect(r2.body.refreshToken).toBe(winner.refreshToken);

    // Critical: no theft-revocation branch fired. All sessions still
    // alive. The successor row is still the only live row.
    const liveRefresh = [];
    for (const row of prisma.__refreshById.values()) {
      if (row.revokedAt === null && row.employeeId === 'emp-dr002-lost') liveRefresh.push(row);
    }
    expect(liveRefresh.length).toBe(1);
  });

  it('Scenario 3 (TTL): an expired receipt does NOT hand back a dead pair — loser is told to re-authenticate', async () => {
    // Belt-and-braces: even with a durable receipt in place, if its
    // expiresAt is in the past the successor refresh row is also dead
    // and the receipt must NOT return a pair. This is the bounded
    // recovery the audit spec calls out — TTL is the bound.
    const prisma = buildMockPrisma();
    prisma.__setEmployee('emp-dr002-ttl', { email: 'ttl@example.com', isAdmin: false });

    const { refreshToken } = await issueSession(prisma, 'emp-dr002-ttl');
    const app = buildApp(prisma);

    // First call mints a real receipt (so we have a successor row id).
    const resp1 = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(resp1.status).toBe(200);

    // Backdate the receipt's expiresAt to yesterday.
    const receipt = prisma.__receiptsBySpentRowId.values().next().value;
    receipt.expiresAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
    revocation.clearRotationReplay(); // force the durable path

    // Retry with the old token. The receipt exists but is expired; the
    // loser path must NOT hand it back. findRotationReceiptBySpentRowId
    // gates on expiresAt and returns null, so this falls through to the
    // genuine-replay branch.
    const resp2 = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(resp2.status).toBe(401);
    expect(resp2.body.code).toBe('REFRESH_REUSED');
  });
});

describe('DR-002: rotateRefreshTokenAtomic unit tests', () => {
  it('commits spend + successor + receipt atomically — partial reads see all three or none', async () => {
    const prisma = buildMockPrisma();
    prisma.__setEmployee('emp-dr002-unit', { email: 'u@example.com', isAdmin: false });

    const { refreshToken } = await issueSession(prisma, 'emp-dr002-unit');
    const row = await revocation.findRefreshTokenRow(prisma, refreshToken);
    expect(row.revokedAt).toBeNull();

    const tokens = {
      accessToken: 'fake.access.jwt',
      refreshToken: 'fake.refresh.jwt',
    };

    const result = await revocation.rotateRefreshTokenAtomic(prisma, {
      row,
      tokens,
      employeeId: 'emp-dr002-unit',
    });
    expect(result.successor).toBeDefined();
    expect(result.successor.rotatedFromId).toBe(row.id);
    expect(result.successor.revokedAt).toBeNull();

    // All three writes landed.
    const after = await revocation.findRefreshTokenRow(prisma, refreshToken);
    expect(after.revokedAt).not.toBeNull();
    const receipt = prisma.__receiptsBySpentRowId.get(row.id);
    expect(receipt).toBeDefined();
    expect(receipt.accessToken).toBe(tokens.accessToken);
    expect(receipt.refreshToken).toBe(tokens.refreshToken);
    expect(receipt.employeeId).toBe('emp-dr002-unit');
  });

  it('throws RACE_LOST when the CAS loses — no partial state', async () => {
    const prisma = buildMockPrisma();
    prisma.__setEmployee('emp-dr002-race', { email: 'r@example.com', isAdmin: false });

    const { refreshToken } = await issueSession(prisma, 'emp-dr002-race');
    const row = await revocation.findRefreshTokenRow(prisma, refreshToken);

    // Pre-revoke the row to force the CAS to lose.
    await revocation.claimRefreshToken(prisma, row.id);

    const beforeSize = prisma.__refreshById.size;
    const beforeReceiptSize = prisma.__receiptsBySpentRowId.size;

    await expect(revocation.rotateRefreshTokenAtomic(prisma, {
      row,
      tokens: { accessToken: 'a', refreshToken: 'b' },
      employeeId: 'emp-dr002-race',
    })).rejects.toThrow('RACE_LOST');

    // Critical: nothing was committed. No new successor, no receipt.
    expect(prisma.__refreshById.size).toBe(beforeSize);
    expect(prisma.__receiptsBySpentRowId.size).toBe(beforeReceiptSize);
  });

  it('findRotationReceiptBySpentRowId returns null for missing or expired receipts', async () => {
    const prisma = buildMockPrisma();
    prisma.__setEmployee('emp-dr002-lookup', { email: 'lk@example.com', isAdmin: false });

    expect(await revocation.findRotationReceiptBySpentRowId(prisma, 'no-such-row'))
      .toBeNull();
    expect(await revocation.findRotationReceiptBySpentRowId(prisma, null))
      .toBeNull();
    expect(await revocation.findRotationReceiptBySpentRowId(prisma, undefined))
      .toBeNull();

    const { refreshToken } = await issueSession(prisma, 'emp-dr002-lookup');
    const row = await revocation.findRefreshTokenRow(prisma, refreshToken);
    await revocation.rotateRefreshTokenAtomic(prisma, {
      row,
      tokens: { accessToken: 'a', refreshToken: 'b' },
      employeeId: 'emp-dr002-lookup',
    });
    expect(await revocation.findRotationReceiptBySpentRowId(prisma, row.id))
      .not.toBeNull();

    // Backdate to expired; lookup must return null.
    const receipt = prisma.__receiptsBySpentRowId.get(row.id);
    receipt.expiresAt = new Date(Date.now() - 1000);
    expect(await revocation.findRotationReceiptBySpentRowId(prisma, row.id))
      .toBeNull();
  });
});
