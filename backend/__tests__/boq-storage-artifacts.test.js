'use strict';

const mockS3Send = jest.fn();
const mockS3Client = jest.fn(() => ({ send: (...args) => mockS3Send(...args), destroy: jest.fn() }));

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: mockS3Client,
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
    sharedAccountId: process.env.R2_ACCOUNT_ID,
    sharedAccessKeyId: process.env.R2_ACCESS_KEY_ID,
    sharedSecretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    sharedBucket: process.env.R2_BUCKET_DPR_DOCUMENTS,
  };

  beforeEach(() => {
    process.env.R2_BOQ_ACCOUNT_ID = 'test-account';
    process.env.R2_BOQ_ACCESS_KEY_ID = 'test-key';
    process.env.R2_BOQ_SECRET_ACCESS_KEY = 'test-secret';
    process.env.R2_BOQ_BUCKET = 'boq-generator-test';
    process.env.R2_ACCOUNT_ID = 'shared-account';
    process.env.R2_ACCESS_KEY_ID = 'shared-key';
    process.env.R2_SECRET_ACCESS_KEY = 'shared-secret';
    process.env.R2_BUCKET_DPR_DOCUMENTS = 'dpr-documents';
    mockS3Send.mockReset();
    mockS3Client.mockClear();
    jest.resetModules();
    storage = require('../src/lib/boqStorage');
  });

  afterAll(() => {
    for (const [key, value] of Object.entries({
      R2_BOQ_ACCOUNT_ID: env.accountId,
      R2_BOQ_ACCESS_KEY_ID: env.accessKeyId,
      R2_BOQ_SECRET_ACCESS_KEY: env.secretAccessKey,
      R2_BOQ_BUCKET: env.bucket,
      R2_ACCOUNT_ID: env.sharedAccountId,
      R2_ACCESS_KEY_ID: env.sharedAccessKeyId,
      R2_SECRET_ACCESS_KEY: env.sharedSecretAccessKey,
      R2_BUCKET_DPR_DOCUMENTS: env.sharedBucket,
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

  it('falls back to the portal R2 credentials and dpr-documents bucket when BOQ overrides are absent', async () => {
    delete process.env.R2_BOQ_ACCOUNT_ID;
    delete process.env.R2_BOQ_ACCESS_KEY_ID;
    delete process.env.R2_BOQ_SECRET_ACCESS_KEY;
    delete process.env.R2_BOQ_BUCKET;
    jest.resetModules();
    storage = require('../src/lib/boqStorage');
    mockS3Send.mockResolvedValue({});

    await storage.writeSnapshot({ blobPath: 'snapshots/project/job/rev-1.json', document: { lines: [] } });

    expect(storage.bucketName()).toBe('dpr-documents');
    expect(mockS3Client).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: 'https://shared-account.r2.cloudflarestorage.com',
      credentials: { accessKeyId: 'shared-key', secretAccessKey: 'shared-secret' },
    }));
    expect(mockS3Send.mock.calls[0][0].input.Bucket).toBe('dpr-documents');
  });

  it('prefers dedicated BOQ credentials and bucket when configured', async () => {
    mockS3Send.mockResolvedValue({});

    await storage.writeSnapshot({ blobPath: 'snapshots/project/job/rev-1.json', document: { lines: [] } });

    expect(storage.bucketName()).toBe('boq-generator-test');
    expect(mockS3Client).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: 'https://test-account.r2.cloudflarestorage.com',
      credentials: { accessKeyId: 'test-key', secretAccessKey: 'test-secret' },
    }));
    expect(mockS3Send.mock.calls[0][0].input.Bucket).toBe('boq-generator-test');
  });

  it('uses the shared access-key pair when BOQ-specific key fields are incomplete', async () => {
    delete process.env.R2_BOQ_SECRET_ACCESS_KEY;
    jest.resetModules();
    storage = require('../src/lib/boqStorage');
    mockS3Send.mockResolvedValue({});

    await storage.writeSnapshot({ blobPath: 'snapshots/project/job/rev-1.json', document: { lines: [] } });

    expect(mockS3Client).toHaveBeenCalledWith(expect.objectContaining({
      credentials: { accessKeyId: 'shared-key', secretAccessKey: 'shared-secret' },
    }));
  });

  it('uses the configured portal documents bucket when the BOQ bucket override is absent', () => {
    delete process.env.R2_BOQ_BUCKET;
    delete process.env.R2_BOQ_ACCOUNT_ID;
    delete process.env.R2_BOQ_ACCESS_KEY_ID;
    delete process.env.R2_BOQ_SECRET_ACCESS_KEY;
    process.env.R2_BUCKET_DPR_DOCUMENTS = 'shared-documents';
    jest.resetModules();
    storage = require('../src/lib/boqStorage');

    expect(storage.bucketName()).toBe('shared-documents');
  });

  it('preserves the legacy default bucket for dedicated BOQ credentials without a bucket override', () => {
    delete process.env.R2_BOQ_BUCKET;
    process.env.R2_BOQ_ACCOUNT_ID = 'test-account';
    process.env.R2_BOQ_ACCESS_KEY_ID = 'test-key';
    process.env.R2_BOQ_SECRET_ACCESS_KEY = 'test-secret';
    jest.resetModules();
    storage = require('../src/lib/boqStorage');

    expect(storage.bucketName()).toBe('boq-generator');
  });
});