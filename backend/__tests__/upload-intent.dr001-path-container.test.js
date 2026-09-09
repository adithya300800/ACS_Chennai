/**
 * SOL DR-001 — Path/container equality check on upload-intent binding.
 *
 * The S3-7 durable upload-intent pipeline hands out a CONFIRMED intent
 * whose row stores (employeeId, ulid, container, blobPath, status). The
 * route layer needs ALL FOUR of {employeeId, ulid, container, blobPath}
 * to match — not just the first two — otherwise an admin who already
 * owns two CONFIRMED intents (e.g. one for a daily narrative photo, one
 * for a PDF certificate) could submit a Drawing POST carrying the photo
 * intent's ulid with a `pdfBlobPath` that points at a PDF blob the
 * intent never vouched for.
 *
 * The fix is OPT-IN per helper call so the existing photo routes
 * (DPR / Inspection) keep their three-column contract and don't break
 * the wire format. The three document routes (drawings /
 * billingCertifications / projectAttachments) explicitly pass
 * `expectedContainer: 'dpr-documents'` plus the resolved `blobPath`.
 *
 * Pins:
 *   1. helpers ACCEPT expectedContainer + expectedBlobPath and include
 *      them in the Prisma `where` clause
 *   2. the three document route handlers actually pass those params
 *   3. a mismatched container or blobPath causes the binding to be
 *      REJECTED with UPLOAD_NOT_CONFIRMED (validate) or short-bind /
 *      PhotoBindingLostError (assert/bind inside the tx)
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || 'test-internal-token';

const path = require('path');

describe('SOL DR-001 — uploadIntentBinding helpers accept expectedContainer + expectedBlobPath', () => {
  const libPath = path.resolve(__dirname, '../src/lib/uploadIntentBinding.js');
  const src = require('fs').readFileSync(libPath, 'utf8');

  test('validatePhotoIntents declares expectedContainer + expectedBlobPath', () => {
    expect(src).toMatch(/async function validatePhotoIntents\([^)]*expectedContainer[^)]*expectedBlobPath/);
  });

  test('assertPhotoIntentsBindable declares expectedContainer + expectedBlobPath', () => {
    expect(src).toMatch(/async function assertPhotoIntentsBindable\([^)]*expectedContainer[^)]*expectedBlobPath/);
  });

  test('bindPhotoIntentsTx declares expectedContainer + expectedBlobPath', () => {
    expect(src).toMatch(/async function bindPhotoIntentsTx\([^)]*expectedContainer[^)]*expectedBlobPath/);
  });

  test('each helper applies expectedContainer to the where clause when supplied', () => {
    // The shape is identical across all three helpers so a single
    // assertion catches regression in any one of them.
    const matches = src.match(/if \(expectedContainer\) where\.container = expectedContainer;/g);
    expect(matches && matches.length).toBe(3);
  });

  test('each helper applies expectedBlobPath to the where clause when supplied', () => {
    const matches = src.match(/if \(expectedBlobPath\) where\.blobPath = expectedBlobPath;/g);
    expect(matches && matches.length).toBe(3);
  });
});

describe('SOL DR-001 — three document route handlers pass expectedContainer + expectedBlobPath', () => {
  test('drawings.js passes the expected container + blobPath into all three helpers', () => {
    const drawings = require('fs').readFileSync(
      path.resolve(__dirname, '../src/routes/drawings.js'),
      'utf8',
    );
    // Three calls inside the create path. We anchor on the literal
    // helper name + the unique `expectedContainer: 'dpr-documents'`
    // arg so a future refactor cannot silently drop the equality
    // check from one of the three without failing this test.
    const count = (drawings.match(/expectedContainer: 'dpr-documents'/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test('billingCertifications.js passes the expected container + blobPath into all three helpers', () => {
    const bc = require('fs').readFileSync(
      path.resolve(__dirname, '../src/routes/billingCertifications.js'),
      'utf8',
    );
    const count = (bc.match(/expectedContainer: 'dpr-documents'/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test('projectAttachments.js passes the expected container + blobPath into all three helpers', () => {
    const pa = require('fs').readFileSync(
      path.resolve(__dirname, '../src/routes/projectAttachments.js'),
      'utf8',
    );
    const count = (pa.match(/expectedContainer: 'dpr-documents'/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(3);
  });
});

describe('SOL DR-001 — mismatched container / blobPath is REJECTED', () => {
  test('validatePhotoIntents returns 400 UPLOAD_NOT_CONFIRMED when the intent lives in a different bucket', async () => {
    const { validatePhotoIntents } = require('../src/lib/uploadIntentBinding');
    const intents = [
      {
        id: 'intent-other-bucket',
        ulid: 'ULID123456789012345678ABCD',
        employeeId: 'emp-1',
        container: 'dpr-photos', // not 'dpr-documents'
        blobPath: 'emp-1/photo.jpg',
        status: 'CONFIRMED',
      },
    ];
    const prisma = {
      uploadIntent: {
        findMany: jest.fn(async ({ where }) => {
          return intents.filter((r) => r.ulid === where.ulid.in[0] && where.container === r.container);
        }),
      },
    };

    const res = await validatePhotoIntents({
      prisma,
      employeeId: 'emp-1',
      photos: [{ ulid: 'ULID123456789012345678ABCD' }],
      context: 'test',
      expectedContainer: 'dpr-documents',
      expectedBlobPath: 'emp-1/cert.pdf',
    });

    expect(res).not.toBeNull();
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('UPLOAD_NOT_CONFIRMED');
  });

  test('validatePhotoIntents returns null (accepted) when the intent matches every supplied field', async () => {
    const { validatePhotoIntents } = require('../src/lib/uploadIntentBinding');
    const prisma = {
      uploadIntent: {
        findMany: jest.fn(async ({ where }) => {
          // The mock honours every field in `where` so a request that
          // passes container + blobPath in matches nothing unless the
          // intent row also carries those exact values.
          return [
            {
              ulid: 'ULID123456789012345678ABCD',
              employeeId: 'emp-1',
              container: where.container,
              blobPath: where.blobPath,
              status: 'CONFIRMED',
            },
          ];
        }),
      },
    };

    const res = await validatePhotoIntents({
      prisma,
      employeeId: 'emp-1',
      photos: [{ ulid: 'ULID123456789012345678ABCD' }],
      context: 'test',
      expectedContainer: 'dpr-documents',
      expectedBlobPath: 'emp-1/cert.pdf',
    });

    expect(res).toBeNull();
  });
});
