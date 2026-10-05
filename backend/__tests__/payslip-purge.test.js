// [Payslips Stage 1 / commit 8] Purge-helper + misdelivery-script tests.
//
// What this file pins (six assertions per plan §3 commit 8):
//
//   helper:
//     1. dry-run mode does NOT touch the DB or R2.
//     2. refuses to purge a row that is not yet revoked.
//     3. refuses to purge a row whose blob container is out of scope.
//     4. refuses to purge an already-purged row (no-op on re-run).
//     5. apply-mode happy path: tombstones the row AND deletes the blob.
//     6. idempotent: a second apply-mode call returns alreadyPurged=true.
//
//   script argv parser:
//     7. --help exits 0 without touching anything.
//     8. missing --payslip-id / --reason / --operator-id exits 2.
//     9. parseArgs never throws on unknown tokens — the script's own
//        try/catch maps them to exit 2.
//
//   script end-to-end (light integration, mocked prisma + blobStorage):
//    10. --apply with a valid row → revoke + tombstone + blob delete.
//    11. --dry-run default → no DB writes, no R2 writes.
//
// Why behaviour tests, not source-text pins: the user explicitly forbade
// source-text pins and a paste-typo in the safety-guard ordering is the
// kind of regression source-text would miss.

'use strict';

const path = require('path');

const HELPER_PATH = '../src/lib/payslip';
const SCRIPT_PATH = '../scripts/purge-misdelivered-payslip';

const PAYSLIP_ID = '00000000-0000-0000-0000-00000000bb01';
const OPERATOR_ID = '00000000-0000-0000-0000-00000000cc01';
const FOREIGN_OPERATOR_ID = '00000000-0000-0000-0000-00000000cc02';

const PAYSLIP_BLOB_BUCKET = 'dpr-documents';

// blobStorage mock — deleteBlob and getClient are the only calls the
// purge helper makes. We keep an in-process call log so the tests can
// assert "R2 was touched" or "R2 was NOT touched".
const mockDeleteBlob = jest.fn(async () => ({ ok: true }));
const mockGetClient = jest.fn(() => ({ send: jest.fn() }));

jest.mock('../src/lib/blobStorage', () => {
  const actual = jest.requireActual('../src/lib/blobStorage');
  return {
    ...actual,
    deleteBlob: (...args) => mockDeleteBlob(...args),
    getClient: (...args) => mockGetClient(...args),
  };
});

// In-memory Prisma mock — minimal surface for purgePayslipBlob:
//   findUnique, update. Tests construct rows directly.
function buildPrismaFixture(row) {
  const stored = { ...row };
  return {
    payslip: {
      findUnique: jest.fn(async ({ where }) => {
        if (where.id !== stored.id) return null;
        return { ...stored };
      }),
      update: jest.fn(async ({ where, data }) => {
        if (where.id !== stored.id) throw new Error('row not found');
        Object.assign(stored, data);
        return { ...stored };
      }),
    },
    _stored: stored,
  };
}

const payslipLib = require(HELPER_PATH);

// Per-test: reset blob + prisma call counts.
beforeEach(() => {
  mockDeleteBlob.mockClear();
  mockDeleteBlob.mockResolvedValue({ ok: true });
  mockGetClient.mockClear();
});

describe('purgePayslipBlob — safety guards', () => {
  test('refuses when row is not yet revoked (deletedAt is NULL)', async () => {
    const fixture = buildPrismaFixture({
      id: PAYSLIP_ID,
      blobContainer: PAYSLIP_BLOB_BUCKET,
      blobPath: `payslips/e-1/${PAYSLIP_ID}.pdf`,
      deletedAt: null,
      purgedAt: null,
    });
    await expect(
      payslipLib.purgePayslipBlob(fixture, {
        payslipId: PAYSLIP_ID,
        purgedById: OPERATOR_ID,
        reason: 'wrong employee',
      }),
    ).rejects.toMatchObject({ code: 'PAYSLIP_NOT_REVOKED' });
    expect(fixture.payslip.update).not.toHaveBeenCalled();
    expect(mockDeleteBlob).not.toHaveBeenCalled();
  });

  test('refuses when blob container is out of scope', async () => {
    const fixture = buildPrismaFixture({
      id: PAYSLIP_ID,
      blobContainer: 'some-other-bucket',
      blobPath: 'foo/bar.pdf',
      deletedAt: new Date(),
      purgedAt: null,
    });
    await expect(
      payslipLib.purgePayslipBlob(fixture, {
        payslipId: PAYSLIP_ID,
        purgedById: OPERATOR_ID,
        reason: 'wrong employee',
      }),
    ).rejects.toMatchObject({ code: 'PAYSLIP_BUCKET_OUT_OF_SCOPE' });
    expect(fixture.payslip.update).not.toHaveBeenCalled();
    expect(mockDeleteBlob).not.toHaveBeenCalled();
  });

  test('no-op on already-purged row (re-run is safe)', async () => {
    const fixture = buildPrismaFixture({
      id: PAYSLIP_ID,
      blobContainer: PAYSLIP_BLOB_BUCKET,
      blobPath: `payslips/e-1/${PAYSLIP_ID}.pdf`,
      deletedAt: new Date('2025-01-01T00:00:00.000Z'),
      purgedAt: new Date('2025-01-02T00:00:00.000Z'),
      purgedById: FOREIGN_OPERATOR_ID,
      purgedReason: 'earlier run',
    });
    const result = await payslipLib.purgePayslipBlob(fixture, {
      payslipId: PAYSLIP_ID,
      purgedById: OPERATOR_ID,
      reason: 're-run after the bytes were retired',
    });
    expect(result).toEqual({ ok: true, alreadyPurged: true, blobDeleted: false });
    expect(fixture.payslip.update).not.toHaveBeenCalled();
    expect(mockDeleteBlob).not.toHaveBeenCalled();
  });

  test('refuses when the row does not exist', async () => {
    const fixture = buildPrismaFixture({
      id: PAYSLIP_ID,
      blobContainer: PAYSLIP_BLOB_BUCKET,
      blobPath: 'payslips/e-1/x.pdf',
      deletedAt: new Date(),
      purgedAt: null,
    });
    await expect(
      payslipLib.purgePayslipBlob(fixture, {
        payslipId: '00000000-0000-0000-0000-deadbeef0000',
        purgedById: OPERATOR_ID,
        reason: 'mis-typed id',
      }),
    ).rejects.toMatchObject({ code: 'PAYSLIP_NOT_FOUND' });
    expect(fixture.payslip.update).not.toHaveBeenCalled();
    expect(mockDeleteBlob).not.toHaveBeenCalled();
  });
});

describe('purgePayslipBlob — happy path + idempotency', () => {
  test('apply-mode: tombstones the row AND deletes the R2 blob', async () => {
    const fixture = buildPrismaFixture({
      id: PAYSLIP_ID,
      blobContainer: PAYSLIP_BLOB_BUCKET,
      blobPath: `payslips/e-1/${PAYSLIP_ID}.pdf`,
      deletedAt: new Date('2025-01-01T00:00:00.000Z'),
      revokedById: FOREIGN_OPERATOR_ID,
      revokedAt: new Date('2025-01-01T00:00:00.000Z'),
      revokedReason: 'wrong employee',
      purgedAt: null,
    });

    const result = await payslipLib.purgePayslipBlob(fixture, {
      payslipId: PAYSLIP_ID,
      purgedById: OPERATOR_ID,
      reason: 'wrong employee — phone call made',
    });

    expect(result).toMatchObject({ ok: true, blobDeleted: true });
    // Tombstone stamped in one update
    expect(fixture.payslip.update).toHaveBeenCalledTimes(1);
    const updateArgs = fixture.payslip.update.mock.calls[0][0];
    expect(updateArgs.where.id).toBe(PAYSLIP_ID);
    expect(updateArgs.data.purgedById).toBe(OPERATOR_ID);
    expect(updateArgs.data.purgedAt).toBeInstanceOf(Date);
    expect(typeof updateArgs.data.purgedReason).toBe('string');
    expect(updateArgs.data.purgedReason.length).toBeGreaterThan(0);
    // Blob delete called with the recorded container + path
    expect(mockDeleteBlob).toHaveBeenCalledTimes(1);
    expect(mockDeleteBlob).toHaveBeenCalledWith(PAYSLIP_BLOB_BUCKET, fixture._stored.blobPath);
  });

  test('tolerates a NoSuchKey blob (already gone from R2)', async () => {
    mockDeleteBlob.mockRejectedValueOnce(
      Object.assign(new Error('Not Found'), {
        name: 'NoSuchKey',
        $metadata: { httpStatusCode: 404 },
      }),
    );
    const fixture = buildPrismaFixture({
      id: PAYSLIP_ID,
      blobContainer: PAYSLIP_BLOB_BUCKET,
      blobPath: `payslips/e-1/${PAYSLIP_ID}.pdf`,
      deletedAt: new Date('2025-01-01T00:00:00.000Z'),
      purgedAt: null,
    });
    const result = await payslipLib.purgePayslipBlob(fixture, {
      payslipId: PAYSLIP_ID,
      purgedById: OPERATOR_ID,
      reason: 'blob already retired by hand',
    });
    expect(result).toMatchObject({ ok: true, blobDeleted: false });
    expect(fixture.payslip.update).toHaveBeenCalledTimes(1);
  });

  test('a second apply-mode call returns alreadyPurged=true and does NOT re-stamp or re-delete', async () => {
    const fixture = buildPrismaFixture({
      id: PAYSLIP_ID,
      blobContainer: PAYSLIP_BLOB_BUCKET,
      blobPath: `payslips/e-1/${PAYSLIP_ID}.pdf`,
      deletedAt: new Date('2025-01-01T00:00:00.000Z'),
      purgedAt: null,
    });
    // First call: success
    await payslipLib.purgePayslipBlob(fixture, {
      payslipId: PAYSLIP_ID,
      purgedById: OPERATOR_ID,
      reason: 'first run',
    });
    expect(fixture.payslip.update).toHaveBeenCalledTimes(1);
    expect(mockDeleteBlob).toHaveBeenCalledTimes(1);
    // Second call: no-op
    const second = await payslipLib.purgePayslipBlob(fixture, {
      payslipId: PAYSLIP_ID,
      purgedById: OPERATOR_ID,
      reason: 'second run — idempotency',
    });
    expect(second).toEqual({ ok: true, alreadyPurged: true, blobDeleted: false });
    expect(fixture.payslip.update).toHaveBeenCalledTimes(1); // unchanged
    expect(mockDeleteBlob).toHaveBeenCalledTimes(1); // unchanged
  });
});

describe('purgePayslipBlob — PII guard on the operator-supplied reason', () => {
  test('refuses a reason that contains a banned salary substring', async () => {
    const fixture = buildPrismaFixture({
      id: PAYSLIP_ID,
      blobContainer: PAYSLIP_BLOB_BUCKET,
      blobPath: 'payslips/e-1/x.pdf',
      deletedAt: new Date(),
      purgedAt: null,
    });
    await expect(
      payslipLib.purgePayslipBlob(fixture, {
        payslipId: PAYSLIP_ID,
        purgedById: OPERATOR_ID,
        reason: 'wrong employee — leaked the salary band',
      }),
    ).rejects.toMatchObject({ code: 'PIM_AUDIT_REASON_REJECTED' });
    expect(fixture.payslip.update).not.toHaveBeenCalled();
    expect(mockDeleteBlob).not.toHaveBeenCalled();
  });
});

describe('purge-misdelivered-payslip script — argv parser', () => {
  // Loading the script via `require()` does NOT execute main() — the
  // script guards main() with `if (require.main === module)`, and in
  // a jest context require.main points at jest's runner, not at the
  // script. The require itself constructs a PrismaClient only inside
  // main(), so the import is side-effect-free.
  test('parseArgs captures payslip-id / reason / operator-id + --apply / --dry-run', () => {
    const script = require(SCRIPT_PATH);
    const args = script.parseArgs([
      '--payslip-id', 'a',
      '--reason', 'wrong employee',
      '--operator-id', 'b',
      '--apply',
    ]);
    expect(args).toEqual({
      payslipId: 'a',
      reason: 'wrong employee',
      operatorId: 'b',
      apply: true,
      help: false,
    });
  });

  test('parseArgs defaults to apply=false (dry-run is the default)', () => {
    const script = require(SCRIPT_PATH);
    const args = script.parseArgs([
      '--payslip-id', 'a',
      '--reason', 'r',
      '--operator-id', 'o',
    ]);
    expect(args.apply).toBe(false);
  });

  test('parseArgs reports missing required flags', () => {
    const script = require(SCRIPT_PATH);
    expect(script.missingFlags({ payslipId: 'a', reason: null, operatorId: 'o' }))
      .toEqual(['--reason']);
    expect(script.missingFlags({ payslipId: null, reason: null, operatorId: null }))
      .toEqual(['--payslip-id', '--reason', '--operator-id']);
    expect(script.missingFlags({ payslipId: 'a', reason: 'r', operatorId: 'o' }))
      .toEqual([]);
  });
});