/**
 * [DR-008] validatePhotoIntents — cross-check client claims against the
 * canonical (container, contentType, verifiedContentType) tuple on the
 * intent row.
 *
 * The audit's failure mode: a CONFIRMED intent is selected by ulid alone
 * while the client supplies a different content-type or container in the
 * photo payload. Without this check the photo row is written with the
 * lie and the binder claims an object whose bytes don't exist on the
 * server.
 *
 * Source of truth:
 *   - container    -> intent.container           (immutable post-mint)
 *   - contentType  -> intent.verifiedContentType (if present, else intent.contentType)
 *
 * The container check is suppressed when the caller pins
 * `expectedContainer` so existing /sas-url + /confirm-upload callers
 * (which already enforce container-equality via the findMany predicate)
 * don't double-fire the same signal twice.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';

const path = require('path');
const fs = require('fs');

describe('SOL DR-008 — validatePhotoIntents cross-checks client claims against canonical intent', () => {
  const libPath = path.resolve(__dirname, '../src/lib/uploadIntentBinding.js');

  test('helper pulls the canonical tuple (container, contentType, verifiedContentType) at the validate step', () => {
    const src = fs.readFileSync(libPath, 'utf8');
    // The select on the validate-time findMany must include the four
    // canonical fields; if any one is dropped the discrepancy check is
    // partial and a fake claim can sneak past.
    expect(src).toMatch(/select:\s*\{[\s\S]{0,200}ulid:\s*true,[\s\S]{0,200}container:\s*true,[\s\S]{0,200}blobPath:\s*true,[\s\S]{0,200}contentType:\s*true,[\s\S]{0,200}verifiedContentType:\s*true/);
  });

  test('helper declares the ULID_CLAIM_MISMATCH envelope code', () => {
    const src = fs.readFileSync(libPath, 'utf8');
    expect(src).toMatch(/error:\s*'ULID_CLAIM_MISMATCH'/);
    expect(src).toMatch(/status:\s*400/);
  });

  test('returns 400 ULID_CLAIM_MISMATCH when client claim disagrees with verifiedContentType', async () => {
    const { validatePhotoIntents } = require('../src/lib/uploadIntentBinding');
    const prisma = {
      uploadIntent: {
        findMany: jest.fn(async () => ([
          {
            ulid: 'ULID123456789012345678ABCD',
            container: 'dpr-photos',
            blobPath: 'emp-1/photo.jpg',
            contentType: 'image/png',
            verifiedContentType: 'image/png', // server-issued, from HEAD
            verifiedSizeBytes: 102400,
          },
        ])),
      },
    };

    const res = await validatePhotoIntents({
      prisma,
      employeeId: 'emp-1',
      photos: [{
        ulid: 'ULID123456789012345678ABCD',
        container: 'dpr-photos',
        contentType: 'image/jpeg', // ← LIE
        sizeBytes: 102400,
      }],
      context: 'dr008-test',
    });

    expect(res).not.toBeNull();
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ULID_CLAIM_MISMATCH');
    expect(res.body.photoIndexes).toEqual([0]);
    expect(res.body.details[0]).toMatchObject({
      ulid: 'ULID123456789012345678ABCD',
      field: 'contentType',
      claimed: 'image/jpeg',
      verified: 'image/png',
    });
  });

  test('returns 400 ULID_CLAIM_MISMATCH when client claim disagrees with the intent container (no expectedContainer pinned)', async () => {
    const { validatePhotoIntents } = require('../src/lib/uploadIntentBinding');
    const prisma = {
      uploadIntent: {
        findMany: jest.fn(async () => ([
          {
            ulid: 'ULID123456789012345678ABCD',
            container: 'dpr-photos', // intent lives here
            blobPath: 'emp-1/photo.jpg',
            contentType: 'image/jpeg',
          },
        ])),
      },
    };

    const res = await validatePhotoIntents({
      prisma,
      employeeId: 'emp-1',
      photos: [{
        ulid: 'ULID123456789012345678ABCD',
        container: 'dpr-documents', // ← LIE
        contentType: 'image/jpeg',
      }],
      context: 'dr008-test',
    });

    expect(res).not.toBeNull();
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ULID_CLAIM_MISMATCH');
    expect(res.body.details[0]).toMatchObject({
      ulid: 'ULID123456789012345678ABCD',
      field: 'container',
      claimed: 'dpr-documents',
      intent: 'dpr-photos',
    });
  });

  test('skips container check when caller pins expectedContainer (findMany predicate already enforced it)', async () => {
    // The dpr.js / inspection.js POSTs already pass `expectedContainer`
    // to the findMany predicate. If we ALSO fired the container check
    // here, the same perfectly valid claim would produce two error
    // signals for one wrong path — double-counted noise. Pin the
    // skip-path so the gate stays single-source-of-truth.
    const { validatePhotoIntents } = require('../src/lib/uploadIntentBinding');
    const prisma = {
      uploadIntent: {
        findMany: jest.fn(async () => ([
          {
            ulid: 'ULID123456789012345678ABCD',
            container: 'dpr-photos',
            blobPath: 'emp-1/photo.jpg',
            contentType: 'image/jpeg',
          },
        ])),
      },
    };

    const res = await validatePhotoIntents({
      prisma,
      employeeId: 'emp-1',
      photos: [{
        ulid: 'ULID123456789012345678ABCD',
        container: 'dpr-photos', // matches — even though expectedContainer='dpr-photos' was also pinned
        contentType: 'image/jpeg',
      }],
      context: 'dr008-test',
      expectedContainer: 'dpr-photos',
    });

    expect(res).toBeNull();
  });

  test('falls back to registered contentType when verifiedContentType is NULL (legacy rows pre-DR-004)', async () => {
    const { validatePhotoIntents } = require('../src/lib/uploadIntentBinding');
    const prisma = {
      uploadIntent: {
        findMany: jest.fn(async () => ([
          {
            ulid: 'ULID123456789012345678ABCD',
            container: 'dpr-photos',
            blobPath: 'emp-1/photo.jpg',
            contentType: 'image/png',
            verifiedContentType: null, // pre-DR-004 row
          },
        ])),
      },
    };

    // Client claims the registered (legacy) type — accepted.
    const accepted = await validatePhotoIntents({
      prisma,
      employeeId: 'emp-1',
      photos: [{ ulid: 'ULID123456789012345678ABCD', container: 'dpr-photos', contentType: 'image/png' }],
      context: 'dr008-test',
    });
    expect(accepted).toBeNull();

    // Client claims something else — rejected using the registered contentType.
    const rejected = await validatePhotoIntents({
      prisma,
      employeeId: 'emp-1',
      photos: [{ ulid: 'ULID123456789012345678ABCD', container: 'dpr-photos', contentType: 'image/jpeg' }],
      context: 'dr008-test',
    });
    expect(rejected).not.toBeNull();
    expect(rejected.body.error).toBe('ULID_CLAIM_MISMATCH');
    expect(rejected.body.details[0]).toMatchObject({
      field: 'contentType',
      claimed: 'image/jpeg',
      intent: 'image/png',
    });
  });

  test('returns null when all claims exactly match the canonical tuple', async () => {
    const { validatePhotoIntents } = require('../src/lib/uploadIntentBinding');
    const prisma = {
      uploadIntent: {
        findMany: jest.fn(async () => ([
          {
            ulid: 'ULID123456789012345678ABCD',
            container: 'dpr-photos',
            blobPath: 'emp-1/photo.jpg',
            contentType: 'image/jpeg',
            verifiedContentType: 'image/jpeg',
          },
        ])),
      },
    };

    const res = await validatePhotoIntents({
      prisma,
      employeeId: 'emp-1',
      photos: [{
        ulid: 'ULID123456789012345678ABCD',
        container: 'dpr-photos',
        contentType: 'image/jpeg',
        sizeBytes: 2048,
      }],
      context: 'dr008-test',
    });

    expect(res).toBeNull();
  });

  test('does not regress the existing UPLOAD_NOT_CONFIRMED path (missing intent still wins over mismatch)', async () => {
    const { validatePhotoIntents } = require('../src/lib/uploadIntentBinding');
    const prisma = {
      uploadIntent: {
        findMany: jest.fn(async () => ([
          {
            ulid: 'ULID123456789012345678ABCD',
            container: 'dpr-photos',
            blobPath: 'emp-1/photo.jpg',
            contentType: 'image/jpeg',
          },
        ])),
      },
    };

    const res = await validatePhotoIntents({
      prisma,
      employeeId: 'emp-1',
      photos: [
        { ulid: 'ULID123456789012345678ABCD', container: 'dpr-photos', contentType: 'image/jpeg' },
        { ulid: '00000000000000000000000ZZZ', container: 'dpr-photos', contentType: 'image/jpeg' }, // no intent
      ],
      context: 'dr008-test',
    });

    expect(res).not.toBeNull();
    // Missing-intent takes precedence so the diagnostic stays simple for clients.
    expect(res.body.error).toBe('UPLOAD_NOT_CONFIRMED');
    expect(res.body.photoIndexes).toEqual([1]);
  });
});
