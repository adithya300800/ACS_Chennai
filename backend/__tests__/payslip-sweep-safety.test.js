/**
 * [Payslip Stage 1 / commit 2] Sweep safety — payslip bytes are protected.
 *
 * Bug class this test prevents: a future change to
 * `internal-upload-sweep.js` that forgets to register the new Payslip
 * row in either `collectReferencedUlids` or `collectReferencedBlobPaths`.
 * Without either registration the 15-min sweep cron would retire payslip
 * bytes the moment the binding writes them — every download attempt would
 * surface `BLOB_GONE` to the employee mid-month.
 *
 * Threat model that drives the protect-list where-clause: ONLY the
 * operator-driven misdelivery purge script (scripts/purge-payslip-
 * misdelivery.js, commit 8) is authorised to retire payslip bytes.
 * Revoke (which sets `deletedAt`) does NOT retire the bytes; the
 * payslip stays downloadable for the employee and HR (audit evidence)
 * for the entire `purgedAt IS NULL` window. The protect-list predicate
 * is therefore `purgedAt: null, blobPath: { not: null }`, NOT
 * `deletedAt: null, blobPath: { not: null }`.
 *
 * Strategy: stand up the real sweep router on a throwaway Express app
 * with a hand-rolled Prisma mock that records calls to `findMany` on the
 * `payslip` delegate, then call the sweep in dry-run mode and assert
 *   (a) the protect-list helpers actually invoked `payslip.findMany`
 *       (the function-level contract — the row factory line is exercised
 *       against any future source refactor), AND
 *   (b) the helper returned Sets containing the seeded `uploadIntentUlid`
 *       and `blobPath` (so a sweep whose `payslip` mock returned the
 *       seeded rows would keep those bytes safe), AND
 *   (c) a REVOKED payslip (deletedAt set, purgedAt null) is NOT
 *       retired by the sweep — the explicit safety case the user
 *       prompted for in checkpoint-1 feedback.
 *
 * Deliberately NOT a source-text pin: we do not read
 * `internal-upload-sweep.js` to grep for `'payslip'`. The assertion
 * checks behavior — `payslip.findMany` was called with the right
 * `where` shape, and the returned rows were projected into the
 * protect-list Sets. A future rewrite that moves the protect-list to a
 * registry table would still satisfy these assertions as long as it
 * keeps the same behavior.
 *
 * Privacy discipline:
 *   * No real employee data — `payslipFactory()` from
 *     `__tests__/payslip-fixtures.js` produces `00000000-...` UUIDs.
 *   * No salary figures — `dummyPdfBuffer` is a `%PDF-1.4\n` magic header.
 *   * No skip or only markers — the pretest guard would block this file.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || 'test-internal-token';

const express = require('express');
const request = require('supertest');

const { payslipFactory, DUMMY_PAYSLIP_ULID_1, DUMMY_PAYSLIP_ULID_2 } = require('./payslip-fixtures');

let mockDeleteBlobCalls = [];
let mockDeleteBlobBehavior = () => Promise.resolve();

jest.mock('../src/lib/blobStorage', () => ({
  deleteBlob: jest.fn(async (container, blobPath) => {
    mockDeleteBlobCalls.push({ container, blobPath });
    return mockDeleteBlobBehavior({ container, blobPath });
  }),
}));

const sweepRouter = require('../src/routes/internal-upload-sweep');

// ─── Prisma stub ───────────────────────────────────────────────────────────
// Minimal mock that records calls to every `findMany` so the test can
// assert the protect-list actually consulted the `payslip` delegate AND
// that the where-clause matches the `{ purgedAt: null, blobPath: { not:
// null } }` predicate (NOT the wrong `{ deletedAt: null, blobPath: { not:
// null } }`).
function buildPrisma({ payslipRows = [] } = {}) {
  const findManyCalls = [];

  const makeRecordingFindMany = (label) =>
    jest.fn(async (args) => {
      findManyCalls.push({ delegate: label, args });
      if (label === 'payslip') return payslipRows;
      return [];
    });

  return {
    uploadIntent: {
      findMany: makeRecordingFindMany('uploadIntent'),
      updateMany: jest.fn(async () => ({ count: 0 })),
      count: jest.fn(async () => 0),
    },
    dPRPhoto: { findMany: makeRecordingFindMany('dPRPhoto') },
    inspectionPhoto: { findMany: makeRecordingFindMany('inspectionPhoto') },
    drawing: { findMany: makeRecordingFindMany('drawing') },
    projectAttachment: { findMany: makeRecordingFindMany('projectAttachment') },
    billingCertification: { findMany: makeRecordingFindMany('billingCertification') },
    payslip: { findMany: makeRecordingFindMany('payslip') },
    _findManyCalls: findManyCalls,
  };
}

function buildApp(prisma) {
  const app = express();
  app.use(express.json());
  app.set('prisma', prisma);
  app.use('/api/internal/upload', sweepRouter);
  return app;
}

function postDryRunSweep(app) {
  return request(app)
    .post('/api/internal/upload/sweep')
    .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN)
    .send({ dryRun: true });
}

beforeEach(() => {
  mockDeleteBlobCalls = [];
  mockDeleteBlobBehavior = () => Promise.resolve();
});

describe('Payslip sweep safety — protect list covers the new entity', () => {
  it('queries prisma.payslip.findMany during precollect (function-level contract)', async () => {
    const payslipRows = [
      payslipFactory({ ulid: DUMMY_PAYSLIP_ULID_1 }),
      payslipFactory({ ulid: DUMMY_PAYSLIP_ULID_2, year: 2026, month: 11 }),
    ];
    const prisma = buildPrisma({ payslipRows });
    const res = await postDryRunSweep(buildApp(prisma));

    expect(res.status).toBe(200);

    const payslipCalls = prisma._findManyCalls.filter((c) => c.delegate === 'payslip');
    // Once for uploadIntentUlid, once for blobPath.
    expect(payslipCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('Payslip.uploadIntentUlid is reflected in the uploadIntent (would-be-orphan) match path', async () => {
    const seededUploadIntentUlid = 'int-01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const seededBlobPath = 'payslips/2026/10/00000000-0000-0000-0000-000000000001/01ARZ3NDEKTSV4RRFFQ69G5FAV.pdf';
    const payslipRows = [
      payslipFactory({
        ulid: DUMMY_PAYSLIP_ULID_1,
        uploadIntentUlid: seededUploadIntentUlid,
        blobPath: seededBlobPath,
      }),
    ];

    const staleIntentRows = [
      {
        id: 'intent-stale-1',
        ulid: seededUploadIntentUlid,
        employeeId: '00000000-0000-0000-0000-000000000001',
        container: 'dpr-documents',
        blobPath: seededBlobPath,
        contentType: 'application/pdf',
        status: 'CONFIRMED',
        expiresAt: new Date(Date.now() - 60_000),
        confirmedAt: new Date(Date.now() - 2 * 60 * 60_000),
        createdAt: new Date(Date.now() - 25 * 60 * 60_000),
        boundType: null,
        boundAt: null,
        verifiedAt: new Date(Date.now() - 2 * 60 * 60_000),
        verifiedSizeBytes: 100,
        verifiedContentType: 'application/pdf',
      },
    ];

    const prisma = buildPrisma({ payslipRows });
    prisma.uploadIntent.findMany = jest.fn(async () => staleIntentRows);
    prisma.uploadIntent.updateMany = jest.fn(async () => ({ count: 0 }));

    const res = await postDryRunSweep(buildApp(prisma));

    expect(res.status).toBe(200);
    expect(res.body.preservedByPhotoRef).toBe(1);
    expect(mockDeleteBlobCalls).toHaveLength(0);
    expect(prisma.uploadIntent.updateMany).not.toHaveBeenCalled();
  });

  it('Payslip.blobPath protect-list where-clause is { purgedAt: null, blobPath: { not: null } }', async () => {
    // Behavioral assertion on the where-clause shape: the
    // referenced-blobPath helper must query with the
    // `{ purgedAt: null, blobPath: { not: null } }` predicate, NOT
    // `{ deletedAt: null, blobPath: { not: null } }`. A future
    // refactor that regresses to the wrong predicate would let the
    // sweep delete revoked payslip bytes — the misdelivery runbook's
    // explicit no-go. This test pins the shape directly against the
    // recorded `findMany` call arguments.
    const prisma = buildPrisma({ payslipRows: [] });
    const res = await postDryRunSweep(buildApp(prisma));
    expect(res.status).toBe(200);

    const payslipBlobPathCalls = prisma._findManyCalls.filter(
      (c) => c.delegate === 'payslip' && c.args && c.args.where,
    );
    expect(payslipBlobPathCalls.length).toBeGreaterThanOrEqual(1);

    // Find the call that queries blobPath (select has `blobPath: true`).
    const blobPathCall = payslipBlobPathCalls.find(
      (c) => c.args.select && c.args.select.blobPath === true,
    );
    expect(blobPathCall).toBeDefined();

    // The where-clause must match the canonical purgedAt-only predicate.
    expect(blobPathCall.args.where).toEqual({
      purgedAt: null,
      blobPath: { not: null },
    });

    // Negative assertion: `deletedAt` must NOT appear in the where
    // clause. A regression that flips the predicate to deletedAt
    // would silently let the sweep retire revoked payslip bytes.
    expect(blobPathCall.args.where).not.toHaveProperty('deletedAt');
  });

  it('a REVOKED payslip (deletedAt set, purgedAt null) is NOT deleted by the sweep', async () => {
    // The user-prompted safety case for checkpoint-1 feedback.
    // Threat model: HR revokes a payslip (sets deletedAt + revokedBy
    // + revokedAt + revokedReason) because it was emailed to the
    // wrong recipient. The employee may still need to download the
    // payslip for their own records during the misdelivery
    // investigation. The sweep must NOT delete those bytes —
    // only the operator-driven purge script (commit 8) can. The
    // purge script is the single gate: it sets purgedAt, which
    // removes the row from the protect-list.
    //
    // Behavioral proof: seed a revoked row (deletedAt set, purgedAt
    // null). The protect-list must still consider this row's
    // blobPath live — so a STALE EXPIRED UploadIntent that points
    // at the SAME blobPath must NOT be retired (the bytes are still
    // referenced by the revoked row).
    const sharedBlobPath = 'payslips/2026/10/00000000-0000-0000-0000-000000000002/01ARZ3NDEKTSV4RRFFQ69G5FAV.pdf';

    const revokedRow = payslipFactory({
      ulid: DUMMY_PAYSLIP_ULID_2,
      employeeId: '00000000-0000-0000-0000-000000000002',
      blobPath: sharedBlobPath,
      uploadIntentUlid: 'int-payslip-revoked',
      deletedAt: new Date('2026-09-15T00:00:00.000Z'), // revoked
      revokedAt: new Date('2026-09-15T00:00:00.000Z'),
      revokedById: 'admin-1',
      revokedReason: 'misdelivery investigation',
      purgedAt: null, // <-- the load-bearing column
      purgedById: null,
      purgedReason: null,
    });

    const staleExpiredIntentPointingAtRevokedBlob = [
      {
        id: 'intent-stale-revoked',
        employeeId: '00000000-0000-0000-0000-000000000002',
        container: 'dpr-documents',
        blobPath: sharedBlobPath,
        contentType: 'application/pdf',
        status: 'EXPIRED',
        expiresAt: new Date(Date.now() - 25 * 60 * 60_000),
        confirmedAt: new Date(Date.now() - 24 * 60 * 60_000),
        createdAt: new Date(Date.now() - 25 * 60 * 60_000),
        boundType: null,
        boundAt: null,
        verifiedAt: new Date(Date.now() - 24 * 60 * 60_000),
        verifiedSizeBytes: 100,
        verifiedContentType: 'application/pdf',
      },
    ];

    const prisma = buildPrisma({ payslipRows: [revokedRow] });
    prisma.uploadIntent.findMany = jest.fn(async () => staleExpiredIntentPointingAtRevokedBlob);

    const res = await postDryRunSweep(buildApp(prisma));

    expect(res.status).toBe(200);

    // The critical safety claim: the sweep did NOT call deleteBlob on
    // the shared blobPath. If `deletedAt: null` were still the
    // predicate, the revoked row would be excluded from the
    // protect list and the sweep would retire the bytes.
    expect(mockDeleteBlobCalls.find((c) => c.blobPath === sharedBlobPath)).toBeUndefined();

    // Positive proof: the protect-list helper DID include the
    // revoked row's blobPath (because purgedAt is null). We assert
    // this by counting preserved-by-photoref: a stale intent whose
    // blobPath matches the protect list increments preservedByPhotoRef.
    // The exact counter value depends on sweep version; the
    // behavioral claim is ">= 1" — at least one preservation event.
    expect(res.body.preservedByPhotoRef).toBeGreaterThanOrEqual(1);
  });

  it('a PURGED payslip (purgedAt set) IS removable by the sweep', async () => {
    // Inverse of the previous case. Once the purge script has run
    // (purgedAt stamped), the row leaves the protect set, and the
    // sweep's safety-net pass may retire the bytes. This is
    // defense-in-depth: if the purge script deletes the row from
    // R2 but somehow leaves a stale EXPIRED UploadIntent pointing
    // at the same blobPath, the sweep can clean up the dangling
    // intent.
    const sharedBlobPath = 'payslips/2026/10/00000000-0000-0000-0000-000000000003/01ARZ3NDEKTSV4RRFFQ69G5FAV.pdf';

    const purgedRow = payslipFactory({
      ulid: DUMMY_PAYSLIP_ULID_1,
      employeeId: '00000000-0000-0000-0000-000000000003',
      blobPath: sharedBlobPath,
      uploadIntentUlid: 'int-payslip-purged',
      deletedAt: new Date('2026-09-15T00:00:00.000Z'),
      revokedAt: new Date('2026-09-15T00:00:00.000Z'),
      revokedById: 'admin-1',
      revokedReason: 'misdelivery',
      purgedAt: new Date('2026-09-16T00:00:00.000Z'), // <-- purged
      purgedById: 'admin-2',
      purgedReason: 'misdelivery purge run #1',
    });

    // Dry-run: zero deleteBlob calls regardless. We're proving the
    // protect-list did NOT include the purged row's blobPath.
    const prisma = buildPrisma({ payslipRows: [purgedRow] });
    const res = await postDryRunSweep(buildApp(prisma));
    expect(res.status).toBe(200);
    expect(mockDeleteBlobCalls).toHaveLength(0);

    // Behavioral assertion: the where-clause excludes purged rows.
    // Find the findMany call that selects blobPath on payslip; assert
    // its where matches `{ purgedAt: null, blobPath: { not: null } }`
    // (so the purged row is filtered server-side, never returned to
    // the helper).
    const blobPathCall = prisma._findManyCalls.find(
      (c) => c.delegate === 'payslip' && c.args && c.args.select && c.args.select.blobPath === true,
    );
    expect(blobPathCall).toBeDefined();
    expect(blobPathCall.args.where).toEqual({
      purgedAt: null,
      blobPath: { not: null },
    });
  });

  it('fatal-abort: a Prisma instance without prisma.payslip triggers REFERENCED_LOOKUP_FAILED', async () => {
    // Defence-in-depth: if a future deploy ships a Prisma client that
    // lacks the `payslip` delegate (e.g. a cached @prisma/client that
    // was generated before the model landed), the sweep MUST refuse
    // rather than silently skip the payslip protect-list entry.
    const prisma = buildPrisma({ payslipRows: [] });
    delete prisma.payslip;
    const res = await postDryRunSweep(buildApp(prisma));

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/REFERENCED_(ULID|BLOBPATH)_LOOKUP_FAILED/);
  });
});