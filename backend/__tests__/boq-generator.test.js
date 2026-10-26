'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'boq-generator-test-secret-at-least-32-characters';

const express = require('express');
const request = require('supertest');

let mockVerifiedUpload = {
  contentLength: 128,
  contentType: 'application/octet-stream',
  prefix: Buffer.from('0\nSECTION\n'),
};
let mockUploadSequence = 0;
const mockVerifyUpload = jest.fn(async () => mockVerifiedUpload);
const mockCreateUploadUrl = jest.fn(async ({ projectId, employeeId, uploadId, extension }) => ({
  sasUrl: `https://private.example/${uploadId}`,
  blobPath: `drawings/${projectId}/${employeeId}/${uploadId}.${extension}`,
  expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
}));
const mockReadSnapshot = jest.fn(async () => ({ schema_version: '1.0', lines: [{ id: 'line-1' }] }));

jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => {
    const employeeId = req.headers['x-test-employee'];
    if (!employeeId) return res.status(401).json({ error: 'Authorization required' });
    req.employeeId = employeeId;
    next();
  },
}));

jest.mock('../src/lib/boqStorage', () => ({
  DEFAULT_BUCKET: 'boq-generator',
  bucketName: () => 'boq-generator',
  generateULID: () => {
    mockUploadSequence += 1;
    return '01ARZ3NDEKTSV4RRFFQ69G5FAV';
  },
  createUploadUrl: (...args) => mockCreateUploadUrl(...args),
  verifyUpload: (...args) => mockVerifyUpload(...args),
  readSnapshot: (...args) => mockReadSnapshot(...args),
}));

const router = require('../src/routes/boqGenerator');

const PROJECT_ID = 'project-1';
const EMPLOYEE_ID = 'employee-1';
const OTHER_EMPLOYEE_ID = 'employee-2';
const ADMIN_ID = 'admin-1';

function buildPrisma({ assigned = true } = {}) {
  const intents = [];
  const jobs = [];
  const snapshots = [];
  const dedupe = new Map();
  const employees = new Map([
    [EMPLOYEE_ID, { id: EMPLOYEE_ID, isAdmin: false }],
    [OTHER_EMPLOYEE_ID, { id: OTHER_EMPLOYEE_ID, isAdmin: false }],
    [ADMIN_ID, { id: ADMIN_ID, isAdmin: true }],
  ]);

  const matchesIntent = (row, where = {}) => {
    for (const field of ['id', 'employeeId', 'container', 'projectId', 'status']) {
      if (where[field] !== undefined && row[field] !== where[field]) return false;
    }
    if (where.ulid && Array.isArray(where.ulid.in) && !where.ulid.in.includes(row.ulid)) return false;
    if (where.boundAt === null && row.boundAt !== null) return false;
    if (where.expiresAt?.gt && row.expiresAt <= where.expiresAt.gt) return false;
    if (where.verifiedAt?.not === null && !row.verifiedAt) return false;
    if (where.verifiedSizeBytes?.gt && !(row.verifiedSizeBytes > where.verifiedSizeBytes.gt)) return false;
    return true;
  };

  const api = {
    project: {
      findUnique: jest.fn(async ({ where }) => where.id === PROJECT_ID ? { id: PROJECT_ID, isActive: true } : null),
    },
    employee: {
      findUnique: jest.fn(async ({ where }) => employees.get(where.id) || null),
    },
    projectAssignment: {
      findUnique: jest.fn(async ({ where }) => assigned && where.projectId_employeeId.projectId === PROJECT_ID &&
        where.projectId_employeeId.employeeId === EMPLOYEE_ID ? { id: 'assignment-1' } : null),
    },
    uploadIntent: {
      create: jest.fn(async ({ data }) => {
        const row = { id: `intent-${data.ulid}`, ...data, boundAt: null, boundType: null, verifiedAt: null, verifiedSizeBytes: null };
        intents.push(row);
        return row;
      }),
      findUnique: jest.fn(async ({ where }) => {
        if (where.employeeId_ulid) {
          return intents.find((row) => row.employeeId === where.employeeId_ulid.employeeId && row.ulid === where.employeeId_ulid.ulid) || null;
        }
        return intents.find((row) => row.id === where.id) || null;
      }),
      findMany: jest.fn(async ({ where }) => intents.filter((row) => matchesIntent(row, where))),
      updateMany: jest.fn(async ({ where, data }) => {
        const hits = intents.filter((row) => matchesIntent(row, where));
        hits.forEach((row) => Object.assign(row, data));
        return { count: hits.length };
      }),
    },
    boqJob: {
      create: jest.fn(async ({ data }) => {
        const row = { ...data, createdAt: new Date(), updatedAt: data.updatedAt };
        jobs.push(row);
        return row;
      }),
      findUnique: jest.fn(async ({ where }) => jobs.find((row) => row.id === where.id) || null),
    },
    boqSnapshot: {
      findFirst: jest.fn(async ({ where }) => snapshots.filter((row) => row.boqJobId === where.boqJobId)
        .sort((a, b) => b.revision - a.revision)[0] || null),
    },
    requestDedupe: {
      create: jest.fn(async ({ data }) => {
        if (dedupe.has(data.key)) {
          const error = new Error('unique constraint');
          error.code = 'P2002';
          throw error;
        }
        dedupe.set(data.key, { ...data, createdAt: new Date(), resultBody: null });
      }),
      findUnique: jest.fn(async ({ where }) => dedupe.get(where.key) || null),
      update: jest.fn(async ({ where, data }) => {
        const row = dedupe.get(where.key);
        if (!row) throw new Error('dedupe missing');
        Object.assign(row, data);
        return row;
      }),
      deleteMany: jest.fn(async ({ where }) => {
        const row = dedupe.get(where.key);
        if (!row || row.state !== where.state) return { count: 0 };
        dedupe.delete(where.key);
        return { count: 1 };
      }),
    },
    $transaction: jest.fn(async (callback) => callback(api)),
    _intents: intents,
    _jobs: jobs,
    _snapshots: snapshots,
    _dedupe: dedupe,
  };
  return api;
}

function buildApp(prisma) {
  const app = express();
  app.use(express.json());
  app.set('prisma', prisma);
  app.use('/api/boq-generator', router);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  return app;
}

async function createConfirmedUpload(app, prisma, overrides = {}) {
  const presign = await request(app)
    .post('/api/boq-generator/uploads/presign')
    .set('x-test-employee', EMPLOYEE_ID)
    .send({ projectId: PROJECT_ID, filename: 'floor-01.dxf', sizeBytes: 128, ...overrides });
  expect(presign.status).toBe(201);
  mockVerifiedUpload = {
    contentLength: 128,
    contentType: 'application/octet-stream',
    prefix: Buffer.from('0\nSECTION\n'),
  };
  const confirm = await request(app)
    .post('/api/boq-generator/uploads/confirm')
    .set('x-test-employee', EMPLOYEE_ID)
    .send({ uploadId: presign.body.uploadId });
  return { presign, confirm, intent: prisma._intents[0] };
}

beforeEach(() => {
  mockUploadSequence = 0;
  mockVerifiedUpload = {
    contentLength: 128,
    contentType: 'application/octet-stream',
    prefix: Buffer.from('0\nSECTION\n'),
  };
  jest.clearAllMocks();
});

describe('BOQ Generator private upload lifecycle', () => {
  it('requires authentication and project assignment before issuing an upload URL', async () => {
    const prisma = buildPrisma({ assigned: false });
    const app = buildApp(prisma);
    const unauthenticated = await request(app).post('/api/boq-generator/uploads/presign').send({});
    const unassigned = await request(app)
      .post('/api/boq-generator/uploads/presign')
      .set('x-test-employee', EMPLOYEE_ID)
      .send({ projectId: PROJECT_ID, filename: 'plan.ifc', sizeBytes: 50 });

    expect(unauthenticated.status).toBe(401);
    expect(unassigned.status).toBe(404);
    expect(prisma.uploadIntent.create).not.toHaveBeenCalled();
    expect(mockCreateUploadUrl).not.toHaveBeenCalled();
  });

  it('allows administrators to presign for an active project without an assignment row', async () => {
    const prisma = buildPrisma({ assigned: false });
    const app = buildApp(prisma);
    const response = await request(app)
      .post('/api/boq-generator/uploads/presign')
      .set('x-test-employee', ADMIN_ID)
      .send({ projectId: PROJECT_ID, filename: 'plan.ifc', sizeBytes: 50 });

    expect(response.status).toBe(201);
    expect(prisma.uploadIntent.create).toHaveBeenCalledTimes(1);
  });

  it('presigns only supported private inputs and confirms exact size plus file signature', async () => {
    const prisma = buildPrisma();
    const app = buildApp(prisma);
    const rejected = await request(app)
      .post('/api/boq-generator/uploads/presign')
      .set('x-test-employee', EMPLOYEE_ID)
      .send({ projectId: PROJECT_ID, filename: 'plan.pdf', sizeBytes: 128 });
    expect(rejected.status).toBe(400);

    const { presign, confirm, intent } = await createConfirmedUpload(app, prisma, { filename: '../../floor-01.dxf' });
    expect(presign.body.blobPath).toBe(`drawings/${PROJECT_ID}/${EMPLOYEE_ID}/${presign.body.uploadId}.dxf`);
    expect(confirm.status).toBe(200);
    expect(confirm.body).toMatchObject({ verified: true, sizeBytes: 128, fileType: 'dxf' });
    expect(intent).toMatchObject({
      container: 'boq-generator',
      projectId: PROJECT_ID,
      originalFilename: 'floor-01.dxf',
      status: 'CONFIRMED',
      verifiedSizeBytes: 128,
    });
  });

  it('refuses mismatched size and PDF bytes without confirming the intent', async () => {
    const prisma = buildPrisma();
    const app = buildApp(prisma);
    const presign = await request(app)
      .post('/api/boq-generator/uploads/presign')
      .set('x-test-employee', EMPLOYEE_ID)
      .send({ projectId: PROJECT_ID, filename: 'model.dxf', sizeBytes: 128 });
    mockVerifiedUpload = { contentLength: 127, contentType: 'application/octet-stream', prefix: Buffer.from('%PDF-1.7') };
    const sizeMismatch = await request(app)
      .post('/api/boq-generator/uploads/confirm')
      .set('x-test-employee', EMPLOYEE_ID)
      .send({ uploadId: presign.body.uploadId });
    expect(sizeMismatch.status).toBe(400);
    expect(sizeMismatch.body.code).toBe('UPLOAD_SIZE_MISMATCH');
    expect(prisma._intents[0].status).toBe('PENDING');

    mockVerifiedUpload.contentLength = 128;
    const pdf = await request(app)
      .post('/api/boq-generator/uploads/confirm')
      .set('x-test-employee', EMPLOYEE_ID)
      .send({ uploadId: presign.body.uploadId });
    expect(pdf.status).toBe(400);
    expect(pdf.body.code).toBe('PDF_NOT_SUPPORTED');
    expect(prisma._intents[0].status).toBe('PENDING');
  });
});

describe('BOQ Generator jobs and authorized snapshot reads', () => {
  it('atomically binds confirmed uploads, durably creates a job, and replays the same key', async () => {
    const prisma = buildPrisma();
    const app = buildApp(prisma);
    const { presign, confirm } = await createConfirmedUpload(app, prisma);
    expect(confirm.status).toBe(200);

    const payload = { projectId: PROJECT_ID, uploads: [presign.body.uploadId], dxfScale: 100, rateSource: 'SOR-2026', wastagePct: 5 };
    const first = await request(app)
      .post('/api/boq-generator/jobs')
      .set('x-test-employee', EMPLOYEE_ID)
      .set('Idempotency-Key', 'job-key-1')
      .send(payload);
    const replay = await request(app)
      .post('/api/boq-generator/jobs')
      .set('x-test-employee', EMPLOYEE_ID)
      .set('Idempotency-Key', 'job-key-1')
      .send(payload);

    expect(first.status).toBe(201);
    expect(first.body.status).toBe('DRAFT');
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(replay.body.id).toBe(first.body.id);
    expect(prisma._jobs).toHaveLength(1);
    expect(prisma._intents[0]).toMatchObject({ boundType: 'boq_job', status: 'CONFIRMED' });
    expect(prisma._intents[0].boundAt).toBeInstanceOf(Date);
    expect([...prisma._dedupe.values()][0]).toMatchObject({ state: 'COMPLETED', recordKind: 'boqJob', recordId: first.body.id });
    expect(JSON.stringify(first.body)).not.toContain('serviceJobId');
    expect(JSON.stringify(first.body)).not.toContain('blobPath');
  });

  it('rejects unassigned users with 404 for job and snapshot resources', async () => {
    const prisma = buildPrisma();
    const app = buildApp(prisma);
    const { presign } = await createConfirmedUpload(app, prisma);
    const created = await request(app)
      .post('/api/boq-generator/jobs')
      .set('x-test-employee', EMPLOYEE_ID)
      .set('Idempotency-Key', 'job-key-2')
      .send({ projectId: PROJECT_ID, uploads: [presign.body.uploadId] });
    prisma._snapshots.push({ boqJobId: created.body.id, revision: 1, snapshotBlobPath: 'snapshots/private.json' });

    const unauthorizedJob = await request(app)
      .get(`/api/boq-generator/jobs/${created.body.id}`)
      .set('x-test-employee', OTHER_EMPLOYEE_ID);
    const unauthorizedSnapshot = await request(app)
      .get(`/api/boq-generator/jobs/${created.body.id}/boq`)
      .set('x-test-employee', OTHER_EMPLOYEE_ID);

    expect(unauthorizedJob.status).toBe(404);
    expect(unauthorizedSnapshot.status).toBe(404);
    expect(mockReadSnapshot).not.toHaveBeenCalled();
  });

  it('returns the private snapshot JSON only after project authorization', async () => {
    const prisma = buildPrisma();
    const app = buildApp(prisma);
    const { presign } = await createConfirmedUpload(app, prisma);
    const created = await request(app)
      .post('/api/boq-generator/jobs')
      .set('x-test-employee', EMPLOYEE_ID)
      .set('Idempotency-Key', 'job-key-3')
      .send({ projectId: PROJECT_ID, uploads: [presign.body.uploadId] });
    prisma._snapshots.push({ boqJobId: created.body.id, revision: 1, snapshotBlobPath: 'snapshots/private.json' });

    const result = await request(app)
      .get(`/api/boq-generator/jobs/${created.body.id}/boq`)
      .set('x-test-employee', EMPLOYEE_ID);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ schema_version: '1.0', lines: [{ id: 'line-1' }] });
    expect(mockReadSnapshot).toHaveBeenCalledWith('snapshots/private.json');
  });
});