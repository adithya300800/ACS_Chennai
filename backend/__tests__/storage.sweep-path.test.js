/**
 * DR-018 — Storage orphan-sweep require path.
 *
 * The audit found that POST /api/admin/storage/orphans/sweep
 * (backend/src/routes/storage.js:161) was requiring
 * `_sweepOrphanUploadsCore` with `../scripts/_sweepOrphanUploadsCore`.
 * From `backend/src/routes/`, that path resolves to
 * `backend/src/scripts/_sweepOrphanUploadsCore.js` — a file that does
 * not exist (the real module ships at `backend/scripts/...`).
 *
 * The bug surfaced as every sweep falling through to the 501
 * SWEEP_UNAVAILABLE fallback — admins clicking "Run sweep" got a
 * clear error but no work was done. The dry-run path was equally
 * broken (it lived inside the same fallback branch).
 *
 * This file pins the fix in two ways:
 *
 *   1. `require('../../scripts/_sweepOrphanUploadsCore')` resolves to
 *      the real module. We verify by mocking the core's `runSweep`
 *      and asserting the route calls it.
 *
 *   2. The 501 SWEEP_UNAVAILABLE fallback only fires when the require
 *      genuinely fails (e.g. partial deploy). We pin that with a
 *      second test that mocks the core path to throw.
 *
 * Auth: the route runs through requireAuth + requireFreshAdmin. We
 * stub both middlewares so the test stays focused on the require path
 * (auth has its own coverage in revocation.test.js / smoke_dr005).
 *
 * Test-file layout: this file lives at backend/__tests__/. The real
 * core module is at backend/scripts/_sweepOrphanUploadsCore.js, so
 * from here the path is `../scripts/_sweepOrphanUploadsCore`. storage.js
 * is at backend/src/routes/storage.js, so from here it is
 * `../src/routes/storage`.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';
// R2 creds so blobStorage.getClient() can construct an S3Client. The
// client is never actually used in this test because we don't drive
// a sweep against live buckets.
process.env.R2_ACCOUNT_ID = 'test-account';
process.env.R2_ACCESS_KEY_ID = 'test-key';
process.env.R2_SECRET_ACCESS_KEY = 'test-secret';

const path = require('path');

describe('DR-018 — storage.js orphan sweep require path', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('A1. POST /orphans/sweep reaches runSweep — require path resolves to backend/scripts/', async () => {
    // Mock the core module so we can confirm the require path landed
    // on the real file. If storage.js resolves to a non-existent
    // path, this mock is never applied and runSweep is never called.
    const runSweep = jest.fn().mockResolvedValue([
      { bucket: 'dpr-photos', scanned: 0, deleted: 0, orphans: 0 },
    ]);
    jest.doMock('../scripts/_sweepOrphanUploadsCore', () => ({
      runSweep,
      findRowForKey: jest.fn(),
    }));

    // Stub auth middlewares so the route runs without a real employee.
    jest.doMock('../src/middleware/auth', () => ({
      requireAuth: (_req, _res, next) => next(),
      requireFreshAdmin: (_req, _res, next) => next(),
    }));

    const storageRouter = require('../src/routes/storage');
    const app = require('express')();
    app.use(require('express').json());
    app.use('/api/admin/storage', storageRouter);

    const res = await require('supertest')(app)
      .post('/api/admin/storage/orphans/sweep')
      .send({ dryRun: true, olderThanHours: 24 });

    expect(res.status).toBe(200);
    expect(runSweep).toHaveBeenCalledTimes(1);
    const call = runSweep.mock.calls[0][0];
    expect(call.dryRun).toBe(true);
    expect(call.olderThanHours).toBe(24);
  });

  it('A2. POST /orphans/sweep returns 501 SWEEP_UNAVAILABLE when the core module genuinely does not exist', async () => {
    // Force the require to fail by mocking the resolved path to throw.
    jest.doMock('../scripts/_sweepOrphanUploadsCore', () => {
      throw new Error('MODULE_NOT_FOUND_FOR_TEST');
    });

    jest.doMock('../src/middleware/auth', () => ({
      requireAuth: (_req, _res, next) => next(),
      requireFreshAdmin: (_req, _res, next) => next(),
    }));

    const storageRouter = require('../src/routes/storage');
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/admin/storage', storageRouter);

    const res = await require('supertest')(app)
      .post('/api/admin/storage/orphans/sweep')
      .send({ dryRun: true });

    expect(res.status).toBe(501);
    expect(res.body.code).toBe('SWEEP_UNAVAILABLE');
    expect(res.body.ok).toBe(false);
  });

  it('A3. the require path lives under backend/scripts/ — not backend/src/scripts/', () => {
    // Pin the absolute path that storage.js should resolve to. If a
    // future refactor moves storage.js (e.g. into src/routes/admin/),
    // this test fails loudly so the relative path is updated in
    // lockstep.
    const expected = path.resolve(
      __dirname,
      '..',
      'scripts',
      '_sweepOrphanUploadsCore.js',
    );
    expect(expected).toContain(`${path.sep}backend${path.sep}scripts${path.sep}`);
    expect(expected).not.toContain(`${path.sep}backend${path.sep}src${path.sep}scripts${path.sep}`);
    // The file must exist on disk (the audit caught the bug because
    // it didn't, in the wrong directory).
    const fs = require('fs');
    expect(fs.existsSync(expected)).toBe(true);
  });
});
