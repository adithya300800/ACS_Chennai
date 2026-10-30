'use strict';

const mockS3Send = jest.fn();

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: (...args) => mockS3Send(...args), destroy: jest.fn() })),
  PutObjectCommand: class { constructor(input) { this.input = input; } },
  GetObjectCommand: class { constructor(input) { this.input = input; } },
  HeadObjectCommand: class { constructor(input) { this.input = input; } },
  DeleteObjectCommand: class { constructor(input) { this.input = input; } },
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));

describe('BOQ artifact storage', () => {
  let storage;
  const env = {
    accountId: process.env.R2_BOQ_ACCOUNT_ID,
    accessKeyId: process.env.R2_BOQ_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_BOQ_SECRET_ACCESS_KEY,
    bucket: process.env.R2_BOQ_BUCKET,
  };

  beforeEach(() => {
    process.env.R2_BOQ_ACCOUNT_ID = 'test-account';
    process.env.R2_BOQ_ACCESS_KEY_ID = 'test-key';
    process.env.R2_BOQ_SECRET_ACCESS_KEY = 'test-secret';
    process.env.R2_BOQ_BUCKET = 'boq-generator-test';
    mockS3Send.mockReset();
    jest.resetModules();
    storage = require('../src/lib/boqStorage');
  });

  afterAll(() => {
    for (const [key, value] of Object.entries({
      R2_BOQ_ACCOUNT_ID: env.accountId,
      R2_BOQ_ACCESS_KEY_ID: env.accessKeyId,
      R2_BOQ_SECRET_ACCESS_KEY: env.secretAccessKey,
      R2_BOQ_BUCKET: env.bucket,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('writes snapshots and XLSX buffers to the private bucket with explicit media types', async () => {
    mockS3Send.mockResolvedValue({});
    const document = { schema_version: '1.0', lines: [] };
    const buffer = Buffer.from('test-xlsx');

    await storage.writeSnapshot({ blobPath: 'snapshots/project/job/rev-1.json', document });
    await storage.writeExport({ blobPath: 'exports/project/job/rev-1.xlsx', buffer });

    expect(mockS3Send).toHaveBeenCalledTimes(2);
    expect(mockS3Send.mock.calls[0][0].input).toMatchObject({
      Bucket: 'boq-generator-test', Key: 'snapshots/project/job/rev-1.json',
      Body: Buffer.from(JSON.stringify(document)), ContentType: 'application/json',
    });
    expect(mockS3Send.mock.calls[1][0].input).toMatchObject({
      Bucket: 'boq-generator-test', Key: 'exports/project/job/rev-1.xlsx',
      Body: buffer, ContentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
  });

  it('reads binary exports and treats only R2 not-found responses as missing', async () => {
    const binary = Buffer.from('xlsx-content');
    mockS3Send
      .mockResolvedValueOnce({ Body: (async function* stream() { yield binary.subarray(0, 3); yield binary.subarray(3); }()) })
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(Object.assign(new Error('not found'), { $metadata: { httpStatusCode: 404 } }));

    await expect(storage.readExport('exports/project/job/rev-1.xlsx')).resolves.toEqual(binary);
    await expect(storage.blobExists('exports/project/job/rev-1.xlsx')).resolves.toBe(true);
    await expect(storage.blobExists('exports/project/job/missing.xlsx')).resolves.toBe(false);
  });
});