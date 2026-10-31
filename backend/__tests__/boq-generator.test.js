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
const mockStoredArtifacts = new Map();
const mockVerifyUpload = jest.fn(async () => mockVerifiedUpload);
const mockCreateUploadUrl = jest.fn(async ({ projectId, employeeId, uploadId, extension }) => ({
  sasUrl: `https://private.example/${uploadId}`,
  blobPath: `drawings/${projectId}/${employeeId}/${uploadId}.${extension}`,
  expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
}));
const mockCreateReadUrl = jest.fn(async (blobPath) => ({
  sasUrl: `https://private.example/read/${encodeURIComponent(blobPath)}?sig=private`,
  expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
}));
const mockReadSnapshot = jest.fn(async (blobPath) => mockStoredArtifacts.get(blobPath) || ({ schema_version: '1.0', lines: [{ id: 'line-1' }] }));
const mockWriteSnapshot = jest.fn(async ({ blobPath, document }) => { mockStoredArtifacts.set(blobPath, document); });
const mockWriteExport = jest.fn(async ({ blobPath, buffer }) => { mockStoredArtifacts.set(blobPath, Buffer.from(buffer)); });
const mockReadExport = jest.fn(async (blobPath) => mockStoredArtifacts.get(blobPath) || null);
const mockBlobExists = jest.fn(async (blobPath) => mockStoredArtifacts.has(blobPath));
const mockDeleteBlob = jest.fn(async (blobPath) => { mockStoredArtifacts.delete(blobPath); });
const mockBoqClient = {
  submitJob: jest.fn(async () => ({ job_id: 'service-job-1', status: 'queued' })),
  getJob: jest.fn(async () => ({ job_id: 'service-job-1', status: 'running', data_status: 'SAMPLE', production_mode: false })),
  getSnapshot: jest.fn(async () => ({
    schema_version: '1.0', kind: 'acs.boq.snapshot', data_status: 'SAMPLE',
    totals: { currency: 'INR', amount: 123.45, line_count: 1, priced_line_count: 1, unpriced_line_count: 0, withheld_count: 0 },
    lines: [{ line_id: 'line-1', qty: 2, rate: 61.725, amount: 123.45 }],
    withheld: [], scale: { factor: 1, confirmed_by: EMPLOYEE_ID },
  })),
  getBoqXlsx: jest.fn(async () => Buffer.from('test-xlsx')),
  deleteJob: jest.fn(async () => ({ deleted: true })),
  correctLine: jest.fn(async () => ({ correction: { id: 'correction-1', kind: 'override_qty', reason: 'Measured on site', requested_by: 'boqjob:job-1' } })),
  getMeta: jest.fn(async () => ({ data_status: 'SAMPLE', production_mode: false, sor_sources: [{ name: 'TN_PWD_SOR', is_sample: true }] })),
};
jest.mock('exceljs', () => ({
  Workbook: jest.fn(() => {
    const sheets = [];
    return {
      addWorksheet(name) {
        const sheet = {
          name,
          rows: [],
          headerFooter: {},
          addRow(row) { this.rows.push(row); },
          addRows(rows) { this.rows.push(...rows); },
        };
        sheets.push(sheet);
        return sheet;
      },
      xlsx: { writeBuffer: async () => Buffer.from(JSON.stringify(sheets.map(({ name, rows }) => ({ name, rows })))) },
    };
  }),
}));

jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => {
    const employeeId = req.headers['x-test-employee'];
    if (!employeeId) return res.status(401).json({ error: 'Authorization required' });
    req.employeeId = employeeId;
    req.isAdmin = req.headers['x-test-admin'] === 'true';
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
  createReadUrl: (...args) => mockCreateReadUrl(...args),
  verifyUpload: (...args) => mockVerifyUpload(...args),
  readSnapshot: (...args) => mockReadSnapshot(...args),
  writeSnapshot: (...args) => mockWriteSnapshot(...args),
  writeExport: (...args) => mockWriteExport(...args),
  readExport: (...args) => mockReadExport(...args),
  blobExists: (...args) => mockBlobExists(...args),
  deleteBlob: (...args) => mockDeleteBlob(...args),
}));

jest.mock('../src/lib/boqClient', () => mockBoqClient, { virtual: true });
const router = require('../src/routes/boqGenerator');

const PROJECT_ID = 'project-1';
const EMPLOYEE_ID = 'employee-1';
const OTHER_EMPLOYEE_ID = 'employee-2';
const ADMIN_ID = 'admin-1';
const RATE_LIMIT_EMPLOYEE_ID = 'employee-rate-limit';
const NON_PILOT_EMPLOYEE_ID = 'employee-non-pilot';

function buildPrisma() {
  const intents = [];
  const jobs = [];
  const snapshots = [];
  const dedupe = new Map();
  const employees = new Map([
    [EMPLOYEE_ID, { id: EMPLOYEE_ID, name: 'Owner', email: 'owner@example.test', isAdmin: false }],
    [OTHER_EMPLOYEE_ID, { id: OTHER_EMPLOYEE_ID, name: 'Colleague', email: 'colleague@example.test', isAdmin: false }],
    [ADMIN_ID, { id: ADMIN_ID, name: 'Admin', email: 'admin@example.test', isAdmin: true }],
    [RATE_LIMIT_EMPLOYEE_ID, { id: RATE_LIMIT_EMPLOYEE_ID, name: 'Rate Limit', email: 'rate-limit@example.test', isAdmin: false }],
    [NON_PILOT_EMPLOYEE_ID, { id: NON_PILOT_EMPLOYEE_ID, name: 'Not Pilot', email: 'not-pilot@example.test', isAdmin: false }],
  ]);

  const matchesIntent = (row, where = {}) => {
    for (const field of ['id', 'employeeId', 'container', 'projectId', 'status', 'boundType']) {
      if (where[field] !== undefined && row[field] !== where[field]) return false;
    }
    if (where.ulid && Array.isArray(where.ulid.in) && !where.ulid.in.includes(row.ulid)) return false;
    if (where.boundAt === null && row.boundAt !== null) return false;
    if (where.boundAt?.not === null && row.boundAt === null) return false;
    if (where.expiresAt?.gt && row.expiresAt <= where.expiresAt.gt) return false;
    if (where.verifiedAt?.not === null && !row.verifiedAt) return false;
    if (where.verifiedSizeBytes?.gt && !(row.verifiedSizeBytes > where.verifiedSizeBytes.gt)) return false;
    return true;
  };

  const api = {
    project: {
      findUnique: jest.fn(async ({ where }) => where.id === PROJECT_ID ? { id: PROJECT_ID, name: 'Test Project', isActive: true } : null),
    },
    projectAssignment: {
      findUnique: jest.fn(async ({ where }) => (
        where.projectId_employeeId?.projectId === PROJECT_ID &&
        [EMPLOYEE_ID, OTHER_EMPLOYEE_ID, RATE_LIMIT_EMPLOYEE_ID].includes(where.projectId_employeeId?.employeeId)
          ? { id: 'assignment-owner' }
          : null
      )),
      findMany: jest.fn(async () => []),
    },
    employee: {
      findUnique: jest.fn(async ({ where }) => employees.get(where.id) || null),
      findMany: jest.fn(async ({ where = {} } = {}) => [...employees.values()]
        .filter((employee) => !where.id?.in || where.id.in.includes(employee.id))),
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
      delete: jest.fn(async ({ where }) => {
        const index = jobs.findIndex((row) => row.id === where.id);
        if (index < 0) throw new Error('job not found');
        return jobs.splice(index, 1)[0];
      }),
      findMany: jest.fn(async ({ where = {}, take } = {}) => jobs
        .filter((row) => !where.employeeId || row.employeeId === where.employeeId)
        .filter((row) => !where.projectId || row.projectId === where.projectId)
        .filter((row) => !where.status || (where.status.in ? where.status.in.includes(row.status) : row.status === where.status))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, take || undefined)),
      update: jest.fn(async ({ where, data }) => {
        const row = jobs.find((candidate) => candidate.id === where.id);
        if (!row) throw new Error('job not found');
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      }),
      count: jest.fn(async ({ where = {} } = {}) => jobs.filter((row) => row.employeeId === where.employeeId &&
        (!where.status?.in || where.status.in.includes(row.status))).length),
    },
    boqSnapshot: {
      create: jest.fn(async ({ data }) => {
        const row = { id: `snapshot-${data.boqJobId}-${data.revision}`, ...data };
        snapshots.push(row);
        return row;
      }),
      findFirst: jest.fn(async ({ where }) => snapshots.filter((row) => row.boqJobId === where.boqJobId)
        .sort((a, b) => b.revision - a.revision)[0] || null),
      findMany: jest.fn(async ({ where = {} }) => snapshots.filter((row) => (
        Array.isArray(where?.boqJobId?.in)
          ? where.boqJobId.in.includes(row.boqJobId)
          : row.boqJobId === where?.boqJobId
      ))),
      deleteMany: jest.fn(async ({ where }) => {
        const hits = snapshots.filter((row) => row.boqJobId === where.boqJobId);
        for (const hit of hits) snapshots.splice(snapshots.indexOf(hit), 1);
        return { count: hits.length };
      }),
      update: jest.fn(async ({ where, data }) => {
        const row = snapshots.find((candidate) => candidate.id === where.id);
        if (!row) throw new Error('snapshot not found');
        Object.assign(row, data);
        return row;
      }),
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
    _employees: employees,
  };
  return api;
}

function buildApp(prisma) {
  process.env.INTERNAL_API_TOKEN = 'test-boq-reconcile-token';
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use((req, _res, next) => {
    req.id = req.headers['x-request-id'] || 'test-request-id';
    next();
  });
  app.set('prisma', prisma);
  app.use('/api/boq-generator', router);
  app.use('/api/internal/boq-reconcile', require('../src/routes/internal-boq-reconcile'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  return app;
}

async function createConfirmedUpload(app, prisma, overrides = {}) {
  const employeeId = overrides.employeeId || EMPLOYEE_ID;
  const uploadOverrides = { ...overrides };
  delete uploadOverrides.employeeId;
  const presign = await request(app)
    .post('/api/boq-generator/uploads/presign')
    .set('x-test-employee', employeeId)
    .send({ projectId: PROJECT_ID, filename: 'floor-01.dxf', sizeBytes: 128, ...uploadOverrides });
  expect(presign.status).toBe(201);
  mockVerifiedUpload = {
    contentLength: 128,
    contentType: 'application/octet-stream',
    prefix: Buffer.from('0\nSECTION\n'),
  };
  const confirm = await request(app)
    .post('/api/boq-generator/uploads/confirm')
    .set('x-test-employee', employeeId)
    .send({ uploadId: presign.body.uploadId });
  return { presign, confirm, intent: prisma._intents[0] };
}

beforeEach(async () => {
  process.env.INTERNAL_API_TOKEN = 'test-boq-reconcile-token';
  global.setImmediate = global.setImmediate || ((callback, ...args) => setTimeout(callback, 0, ...args));
  delete process.env.BOQ_PILOT_EMPLOYEE_IDS;
  process.env.BOQ_PILOT_EMPLOYEE_IDS = [EMPLOYEE_ID, OTHER_EMPLOYEE_ID, RATE_LIMIT_EMPLOYEE_ID, NON_PILOT_EMPLOYEE_ID].join(',');
  router.resetMetaCacheForTests();
  await router.resetRateLimitsForTests(
    [EMPLOYEE_ID, OTHER_EMPLOYEE_ID, ADMIN_ID, RATE_LIMIT_EMPLOYEE_ID, NON_PILOT_EMPLOYEE_ID],
    ['203.0.113.10', '::ffff:127.0.0.1', '::1', '127.0.0.1'],
  );
  require('../src/lib/idempotency')._clearCache();
  mockUploadSequence = 0;
  mockStoredArtifacts.clear();
  mockVerifiedUpload = {
    contentLength: 128,
    contentType: 'application/octet-stream',
    prefix: Buffer.from('0\nSECTION\n'),
  };
  jest.clearAllMocks();
  mockBoqClient.submitJob.mockResolvedValue({ job_id: 'service-job-1', status: 'queued' });
  mockBoqClient.getJob.mockResolvedValue({ job_id: 'service-job-1', status: 'running', data_status: 'SAMPLE', production_mode: false });
  mockBoqClient.getSnapshot.mockResolvedValue({
    schema_version: '1.0', kind: 'acs.boq.snapshot', data_status: 'SAMPLE',
    totals: { currency: 'INR', amount: 123.45, line_count: 1, priced_line_count: 1, unpriced_line_count: 0, withheld_count: 0 },
    lines: [{ line_id: 'line-1', qty: 2, rate: 61.725, amount: 123.45 }],
    withheld: [], scale: { factor: 1, confirmed_by: EMPLOYEE_ID },
  });
  mockBoqClient.getBoqXlsx.mockResolvedValue(Buffer.from('test-xlsx'));
  mockBoqClient.correctLine.mockResolvedValue({ correction: { id: 'correction-1' } });
  mockBoqClient.deleteJob.mockResolvedValue({ deleted: true });
  mockBoqClient.getMeta.mockResolvedValue({ data_status: 'SAMPLE', production_mode: false, sor_sources: [{ name: 'TN_PWD_SOR', is_sample: true }] });
});

describe('BOQ Generator private upload lifecycle', () => {
  it('limits authenticated BOQ API requests per employee', async () => {
    const prisma = buildPrisma();
    const app = buildApp(prisma);
    const responses = [];

    for (let index = 0; index < 121; index += 1) {
      responses.push(await request(app)
        .get('/api/boq-generator/meta')
        .set('x-test-employee', EMPLOYEE_ID));
    }
    const otherEmployee = await request(app)
      .get('/api/boq-generator/meta')
      .set('x-test-employee', OTHER_EMPLOYEE_ID);

    expect(responses.slice(0, 120).every((response) => response.status === 200)).toBe(true);
    expect(responses[120].status).toBe(429);
    expect(responses[120].body.code).toBe('BOQ_API_THROTTLED');
    expect(otherEmployee.status).toBe(200);
  });

  it('limits unauthenticated BOQ API requests per IP before authentication', async () => {
    const app = buildApp(buildPrisma());
    const responses = [];
    for (let index = 0; index < 601; index += 1) {
      responses.push(await request(app)
        .get('/api/boq-generator/access')
        .set('x-forwarded-for', '203.0.113.10'));
    }

    expect(responses.slice(0, 600).every((response) => response.status === 401)).toBe(true);
    expect(responses[600].status).toBe(429);
    expect(responses[600].body.code).toBe('BOQ_API_IP_THROTTLED');
  });

  it('keeps the anonymous IP limit separate from authenticated employee limits', async () => {
    const app = buildApp(buildPrisma());
    const responses = [];
    for (let index = 0; index < 121; index += 1) {
      responses.push(await request(app)
        .get('/api/boq-generator/meta')
        .set('x-test-employee', EMPLOYEE_ID));
    }
    expect(responses.slice(0, 120).every((response) => response.status === 200)).toBe(true);
    expect(responses[120].body.code).toBe('BOQ_API_THROTTLED');
  });

  it('requires authentication and allows assigned employees to upload', async () => {
    const prisma = buildPrisma();
    const app = buildApp(prisma);
    const unauthenticated = await request(app).post('/api/boq-generator/uploads/presign').send({});
    prisma.projectAssignment.findUnique.mockResolvedValue({ id: 'assignment-owner' });
    const employeeUpload = await request(app)
      .post('/api/boq-generator/uploads/presign')
      .set('x-test-employee', OTHER_EMPLOYEE_ID)
      .send({ projectId: PROJECT_ID, filename: 'plan.ifc', sizeBytes: 50 });

    expect(unauthenticated.status).toBe(401);
    expect(employeeUpload.status).toBe(201);
    expect(prisma.uploadIntent.create).toHaveBeenCalledTimes(1);
    expect(mockCreateUploadUrl).toHaveBeenCalledTimes(1);
  });

  it('refuses upload and job creation when the authenticated employee row no longer exists', async () => {
    const prisma = buildPrisma();
    prisma.employee.findUnique.mockResolvedValueOnce(null);
    const app = buildApp(prisma);
    const upload = await request(app)
      .post('/api/boq-generator/uploads/presign')
      .set('x-test-employee', 'deleted-employee')
      .send({ projectId: PROJECT_ID, filename: 'plan.ifc', sizeBytes: 50 });
    const job = await request(app)
      .post('/api/boq-generator/jobs')
      .set('x-test-employee', 'deleted-employee')
      .set('Idempotency-Key', 'deleted-employee-job')
      .send({ projectId: PROJECT_ID, uploads: ['01ARZ3NDEKTSV4RRFFQ69G5FAV'] });

    expect(upload.status).toBe(404);
    expect(job.status).toBe(404);
    expect(mockCreateUploadUrl).not.toHaveBeenCalled();
    expect(prisma.boqJob.create).not.toHaveBeenCalled();
  });

  it('requires assignment before an employee submits a drawing for a project', async () => {
    const prisma = buildPrisma();
    const app = buildApp(prisma);
    prisma.projectAssignment.findUnique.mockResolvedValue(null);
    const upload = await request(app)
      .post('/api/boq-generator/uploads/presign')
      .set('x-test-employee', OTHER_EMPLOYEE_ID)
      .send({ projectId: PROJECT_ID, filename: 'floor.dxf', sizeBytes: 128 });
    expect(upload.status).toBe(404);
    expect(mockCreateUploadUrl).not.toHaveBeenCalled();
  });

  it('lets a project creator upload while pending but still requires assignment to create a job', async () => {
    const prisma = buildPrisma();
    prisma.project.findUnique
      .mockResolvedValueOnce({ id: PROJECT_ID, name: 'Test Project', isActive: true, createdById: EMPLOYEE_ID })
      .mockResolvedValueOnce({ id: PROJECT_ID, name: 'Test Project', isActive: true, createdById: EMPLOYEE_ID })
      .mockResolvedValueOnce({ id: PROJECT_ID, name: 'Test Project', isActive: true, createdById: EMPLOYEE_ID });
    prisma.projectAssignment.findUnique.mockResolvedValue(null);
    const app = buildApp(prisma);
    const { presign, confirm } = await createConfirmedUpload(app, prisma, { employeeId: EMPLOYEE_ID });
    const job = await request(app)
      .post('/api/boq-generator/jobs')
      .set('x-test-employee', EMPLOYEE_ID)
      .set('Idempotency-Key', 'pending-project-job')
      .send({ projectId: PROJECT_ID, uploads: [presign.body.uploadId] });

    expect(confirm.status).toBe(200);
    expect(job.status).toBe(404);
    expect(prisma.boqJob.create).not.toHaveBeenCalled();
  });

  it('does not grant the project creator upload access after an administrator allocates it', async () => {
    const prisma = buildPrisma();
    prisma.project.findUnique.mockResolvedValue({ id: PROJECT_ID, name: 'Test Project', isActive: true, createdById: EMPLOYEE_ID });
    prisma.projectAssignment.findMany.mockResolvedValue([{ id: 'assignment-for-another-employee' }]);
    prisma.projectAssignment.findUnique.mockResolvedValue(null);
    const app = buildApp(prisma);
    const upload = await request(app)
      .post('/api/boq-generator/uploads/presign')
      .set('x-test-employee', EMPLOYEE_ID)
      .send({ projectId: PROJECT_ID, filename: 'floor.dxf', sizeBytes: 128 });

    expect(upload.status).toBe(404);
    expect(mockCreateUploadUrl).not.toHaveBeenCalled();
  });

  it('allows administrators to presign for an active project', async () => {
    const prisma = buildPrisma();
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
  it('lists only the signed-in employee\'s runs, while admins can list every run', async () => {
    const prisma = buildPrisma();
    prisma.boqJob.findMany.mockImplementation(async ({ where = {}, take } = {}) => prisma._jobs
      .filter((row) => !where.employeeId || row.employeeId === where.employeeId)
      .filter((row) => !where.projectId || row.projectId === where.projectId)
      .filter((row) => !where.status || (where.status.in ? where.status.in.includes(row.status) : row.status === where.status))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, take || undefined));
    prisma._jobs.push(
      { id: 'job-owner', employeeId: EMPLOYEE_ID, projectId: PROJECT_ID, status: 'DRAFT', inputFiles: [], createdAt: new Date('2026-01-02') },
      { id: 'job-colleague', employeeId: OTHER_EMPLOYEE_ID, projectId: PROJECT_ID, status: 'DRAFT', inputFiles: [], createdAt: new Date('2026-01-01') },
    );
    const app = buildApp(prisma);

    const ownRuns = await request(app)
      .post('/api/boq-generator/jobs/search').send({})
      .set('x-test-employee', EMPLOYEE_ID);
    const adminRuns = await request(app)
      .post('/api/boq-generator/jobs/search').send({})
      .set('x-test-employee', ADMIN_ID)
      .set('x-test-admin', 'true');

    expect(ownRuns.status).toBe(200);
    expect(ownRuns.body.jobs.map((job) => job.id)).toEqual(['job-owner']);
    expect(adminRuns.status).toBe(200);
    expect(adminRuns.body.jobs.map((job) => job.id)).toEqual(['job-owner', 'job-colleague']);
    expect(adminRuns.body.jobs).toContainEqual(expect.objectContaining({ employeeId: OTHER_EMPLOYEE_ID }));
  });

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
    expect(first.body.status).toBe('SUBMITTED');
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(replay.body.id).toBe(first.body.id);
    expect(replay.body.status).toBe('SUBMITTED');
    expect(prisma._jobs).toHaveLength(1);
    expect(mockBoqClient.submitJob).toHaveBeenCalledTimes(1);
    expect(prisma._intents[0]).toMatchObject({ boundType: 'boq_job', status: 'CONFIRMED' });
    expect(prisma._intents[0].boundAt).toBeInstanceOf(Date);
    expect([...prisma._dedupe.values()][0]).toMatchObject({ state: 'COMPLETED', recordKind: 'boqJob', recordId: first.body.id });
    expect(JSON.stringify(first.body)).not.toContain('serviceJobId');
    expect(JSON.stringify(first.body)).not.toContain('blobPath');
  });

  it('submits confirmed uploads to the service using the TN PWD contract and hides service identifiers', async () => {
    const prisma = buildPrisma();
    const app = buildApp(prisma);
    mockBoqClient.submitJob.mockResolvedValue({ job_id: 'service-job-1', status: 'queued' });
    const { presign } = await createConfirmedUpload(app, prisma);
    const submitted = await request(app)
      .post('/api/boq-generator/jobs')
      .set('x-test-employee', EMPLOYEE_ID)
      .set('x-request-id', 'portal-request-1')
      .set('Idempotency-Key', 'client-job-key-1')
      .send({ projectId: PROJECT_ID, uploads: [presign.body.uploadId], dxfScale: 100, rateSource: 'SOR-2026', wastagePct: 5 });

    expect(submitted.status).toBe(201);
    expect(submitted.body).toMatchObject({ status: 'SUBMITTED', dxfScale: 100 });
    expect(JSON.stringify(submitted.body)).not.toContain('service-job-1');
    expect(JSON.stringify(submitted.body)).not.toContain('private.example');
    expect(mockBoqClient.submitJob).toHaveBeenCalledWith(expect.objectContaining({
      jobId: submitted.body.id,
      requestId: 'portal-request-1',
      payload: {
        sources: [{
          url: expect.stringContaining('https://private.example/read/'),
          filename: 'floor-01.dxf',
          size: 128,
        }],
        config: {
          name: expect.any(String),
          project_ref: PROJECT_ID,
          sor_priority: ['SOR-2026'],
          location_factor: 1,
          wastage_pct: 5,
          drawing_scale: 100,
          requested_by: 'Owner',
        },
      },
    }));
    expect(prisma._jobs[0]).toMatchObject({
      serviceJobId: 'service-job-1', status: 'SUBMITTED', dataStatus: 'SAMPLE', productionMode: false,
    });
  });

  it('requires an active project assignment for uploads and job creation', async () => {
    const prisma = buildPrisma();
    const app = buildApp(prisma);
    prisma.projectAssignment.findUnique.mockResolvedValue(null);
    const upload = await request(app)
      .post('/api/boq-generator/uploads/presign')
      .set('x-test-employee', OTHER_EMPLOYEE_ID)
      .send({ projectId: PROJECT_ID, filename: 'floor.dxf', sizeBytes: 128 });
    const job = await request(app)
      .post('/api/boq-generator/jobs')
      .set('x-test-employee', OTHER_EMPLOYEE_ID)
      .set('Idempotency-Key', 'unassigned-project-job')
      .send({ projectId: PROJECT_ID, uploads: ['01ARZ3NDEKTSV4RRFFQ69G5FAV'] });

    expect(upload.status).toBe(404);
    expect(job.status).toBe(404);
    expect(mockCreateUploadUrl).not.toHaveBeenCalled();
    expect(prisma.boqJob.create).not.toHaveBeenCalled();
  });

  it('captures a scale advisory included in the service accepted response', async () => {
    const prisma = buildPrisma();
    const advisory = [{ source_file: 'floor.dxf', reason: 'extent implausible' }];
    const flags = [{ reason_code: 'SCALE_IMPLAUSIBLE', detail: 'Verify the drawing scale' }];
    const scaleSuggestion = { drawing_scale: 1, confidence: 0.84, source: 'geometry' };
    mockBoqClient.submitJob.mockResolvedValueOnce({
      job_id: 'service-job-accepted-advisory', status: 'done', data_status: 'SAMPLE',
      production_mode: false, needs_scale_check: true, scale_diagnostics: advisory, flags,
      scale_suggestion: scaleSuggestion,
    });
    const app = buildApp(prisma);
    const { presign } = await createConfirmedUpload(app, prisma);
    const response = await request(app)
      .post('/api/boq-generator/jobs')
      .set('x-test-employee', EMPLOYEE_ID)
      .set('Idempotency-Key', 'job-key-accepted-advisory')
      .send({ projectId: PROJECT_ID, uploads: [presign.body.uploadId], dxfScale: 100 });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      status: 'COMPLETED_PENDING_EXPORT', needsScaleCheck: true,
      scaleDiagnostics: advisory, scaleSuggestion, flags,
    });
    expect(prisma._jobs[0].settingsJson.serviceAdvisory).toEqual({
      needs_scale_check: true, scale_diagnostics: advisory, scale_suggestion: scaleSuggestion, flags,
    });

    const replay = await request(app)
      .post('/api/boq-generator/jobs')
      .set('x-test-employee', EMPLOYEE_ID)
      .set('Idempotency-Key', 'job-key-accepted-advisory')
      .send({ projectId: PROJECT_ID, uploads: [presign.body.uploadId], dxfScale: 100 });

    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(replay.body).toMatchObject({ needsScaleCheck: true, scaleDiagnostics: advisory, scaleSuggestion, flags });
    expect(replay.body.settings).not.toHaveProperty('serviceAdvisory');
  });

  it('keeps upload claims bound to a retryable draft after service submission fails', async () => {
    const prisma = buildPrisma();
    mockBoqClient.submitJob.mockRejectedValueOnce({ kind: 'network' });
    const app = buildApp(prisma);
    const { presign } = await createConfirmedUpload(app, prisma);
    const response = await request(app)
      .post('/api/boq-generator/jobs')
      .set('x-test-employee', EMPLOYEE_ID)
      .set('Idempotency-Key', 'job-key-service-failure-release')
      .send({ projectId: PROJECT_ID, uploads: [presign.body.uploadId] });

    expect(response.status).toBe(504);
    expect(prisma._jobs[0]).toMatchObject({ status: 'DRAFT', errorCode: 'BOQ_TIMEOUT' });
    expect(prisma._intents[0]).toMatchObject({ boundAt: expect.any(Date), boundType: 'boq_job' });

    mockBoqClient.submitJob.mockResolvedValueOnce({ job_id: 'service-job-retry', status: 'queued' });
    const retry = await request(app)
      .post('/api/boq-generator/jobs')
      .set('x-test-employee', EMPLOYEE_ID)
      .set('Idempotency-Key', 'job-key-service-failure-release')
      .send({ projectId: PROJECT_ID, uploads: [presign.body.uploadId] });
    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe('SUBMITTED');
    expect(prisma._intents[0]).toMatchObject({ boundAt: expect.any(Date), boundType: 'boq_job' });
    expect(mockBoqClient.submitJob).toHaveBeenCalledTimes(2);
  });

  it('denies non-pilot employees before BOQ metadata or project work', async () => {
    process.env.BOQ_PILOT_EMPLOYEE_IDS = EMPLOYEE_ID;
    const prisma = buildPrisma();
    const app = buildApp(prisma);
    const access = await request(app).get('/api/boq-generator/access').set('x-test-employee', NON_PILOT_EMPLOYEE_ID);
    const meta = await request(app).get('/api/boq-generator/meta').set('x-test-employee', NON_PILOT_EMPLOYEE_ID);

    expect(access.status).toBe(200);
    expect(access.body).toEqual({ isPilot: false, pilotEnabled: true });
    expect(meta.status).toBe(403);
    expect(meta.body.code).toBe('BOQ_PILOT_ACCESS');
    expect(mockBoqClient.getMeta).not.toHaveBeenCalled();
  });

  it('fails closed for employees when the pilot list is unset, while admins can still access', async () => {
    process.env.BOQ_PILOT_EMPLOYEE_IDS = '';
    const app = buildApp(buildPrisma());
    const access = await request(app).get('/api/boq-generator/access')
      .set('x-test-employee', ADMIN_ID).set('x-test-admin', 'true');
    const meta = await request(app).get('/api/boq-generator/meta')
      .set('x-test-employee', ADMIN_ID).set('x-test-admin', 'true');
    process.env.BOQ_PILOT_EMPLOYEE_IDS = `${ADMIN_ID}`;
    const denied = await request(app).get('/api/boq-generator/meta').set('x-test-employee', NON_PILOT_EMPLOYEE_ID);

    expect(access.body).toEqual({ isPilot: true, pilotEnabled: true });
    expect(meta.status).toBe(200);
    expect(denied.status).toBe(403);
  });

  it('rate limits upload presigns and job submissions per employee', async () => {
    const app = buildApp(buildPrisma());
    const presignRequests = await Promise.all(Array.from({ length: 31 }, () => request(app)
      .post('/api/boq-generator/uploads/presign')
      .set('x-test-employee', RATE_LIMIT_EMPLOYEE_ID)
      .send({ projectId: PROJECT_ID, filename: 'floor.dxf', sizeBytes: 128 })));
    expect(presignRequests.slice(0, 30).every((response) => response.status === 201)).toBe(true);
    expect(presignRequests[30].status).toBe(429);

    const jobRequests = await Promise.all(Array.from({ length: 11 }, () => request(app)
      .post('/api/boq-generator/jobs')
      .set('x-test-employee', OTHER_EMPLOYEE_ID)
      .send({})));
    expect(jobRequests.slice(0, 10).every((response) => response.status === 400)).toBe(true);
    expect(jobRequests[10].status).toBe(429);
  });

  it('polls upstream service status and persists it without exposing service job id', async () => {
    const prisma = buildPrisma();
    prisma._jobs.push({
      id: 'portal-job-poll', employeeId: EMPLOYEE_ID, projectId: PROJECT_ID,
      serviceJobId: 'service-job-1', status: 'SUBMITTED', inputFiles: [],
      createdAt: new Date(), updatedAt: new Date(),
    });
    const app = buildApp(prisma);
    const response = await request(app)
      .get('/api/boq-generator/jobs/portal-job-poll')
      .set('x-test-employee', EMPLOYEE_ID)
      .set('x-request-id', 'portal-poll-request');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: 'portal-job-poll', status: 'RUNNING', dataStatus: 'SAMPLE' });
    expect(JSON.stringify(response.body)).not.toContain('service-job-1');
    expect(mockBoqClient.getJob).toHaveBeenCalledWith({ serviceJobId: 'service-job-1', requestId: 'portal-poll-request' });
    expect(prisma._jobs[0].status).toBe('RUNNING');
  });

  it('stores and exposes the scale advisory and flags from the service poll', async () => {
    const prisma = buildPrisma();
    prisma._jobs.push({
      id: 'portal-job-scale', employeeId: EMPLOYEE_ID, projectId: PROJECT_ID,
      serviceJobId: 'service-job-1', status: 'RUNNING', inputFiles: [], settingsJson: { wastagePct: 5 },
      createdAt: new Date(), updatedAt: new Date(),
    });
    const advisory = [{ source_file: 'floor.dxf', reason: 'extent implausible', observed_extent_m: 900 }];
    const flags = [{ reason_code: 'SCALE_IMPLAUSIBLE', detail: 'Verify the drawing scale' }];
    const scaleSuggestion = { drawing_scale: 100, confidence: 0.42, source: 'geometry' };
    mockBoqClient.getJob.mockResolvedValueOnce({
      job_id: 'service-job-1', status: 'done', data_status: 'SAMPLE', production_mode: false,
      needs_scale_check: true, scale_diagnostics: advisory, scale_suggestion: scaleSuggestion, flags,
    });
    const app = buildApp(prisma);

    const response = await request(app)
      .get('/api/boq-generator/jobs/portal-job-scale')
      .set('x-test-employee', EMPLOYEE_ID);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'COMPLETED',
      needsScaleCheck: true,
      scaleDiagnostics: advisory,
      scaleSuggestion,
      flags,
    });
    expect(response.body.settings).not.toHaveProperty('serviceAdvisory');
    expect(response.body.settings.wastagePct).toBe(5);
    expect(prisma._jobs[0].settingsJson.serviceAdvisory).toEqual({
      needs_scale_check: true, scale_diagnostics: advisory, scale_suggestion: scaleSuggestion, flags,
    });
  });

  it('captures a completed service job snapshot and export durably before marking it complete', async () => {
    const prisma = buildPrisma();
    prisma._jobs.push({
      id: 'portal-job-complete', employeeId: EMPLOYEE_ID, projectId: PROJECT_ID,
      serviceJobId: 'service-job-1', status: 'RUNNING', inputFiles: [], settingsJson: {},
      dxfScale: 1, scaleConfirmedBy: EMPLOYEE_ID, revision: 1,
      createdAt: new Date(), updatedAt: new Date(),
    });
    mockBoqClient.getJob.mockResolvedValueOnce({
      job_id: 'service-job-1', status: 'done', data_status: 'SAMPLE', production_mode: false,
    });
    const snapshot = {
      schema_version: '1.0', kind: 'acs.boq.snapshot', data_status: 'SAMPLE',
      totals: { currency: 'INR', amount: 123.45, line_count: 1, priced_line_count: 1, unpriced_line_count: 0, withheld_count: 0 },
      lines: [{ line_id: 'line-1', qty: 2, rate: 61.725, amount: 123.45 }],
      withheld: [], flags: [], scale: { factor: 1, confirmed_by: EMPLOYEE_ID },
    };
    mockBoqClient.getSnapshot.mockResolvedValueOnce(snapshot);
    mockBoqClient.getBoqXlsx.mockResolvedValueOnce(Buffer.from('saved-xlsx'));
    const app = buildApp(prisma);

    const response = await request(app)
      .get('/api/boq-generator/jobs/portal-job-complete')
      .set('x-test-employee', EMPLOYEE_ID);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('COMPLETED');
    expect(mockBoqClient.getSnapshot).toHaveBeenCalledWith({ serviceJobId: 'service-job-1', requestId: 'test-request-id' });
    expect(mockBoqClient.getBoqXlsx).toHaveBeenCalledWith({ serviceJobId: 'service-job-1', requestId: 'test-request-id' });
    expect(mockWriteSnapshot).toHaveBeenCalledWith({
      blobPath: 'snapshots/project-1/portal-job-complete/rev-1.json', document: snapshot,
    });
    expect(mockWriteExport).toHaveBeenCalledWith({
      blobPath: 'exports/project-1/portal-job-complete/boq-portal-job-complete-rev-1.xlsx',
      buffer: Buffer.from('saved-xlsx'),
    });
    expect(prisma._snapshots).toHaveLength(1);
    expect(prisma._snapshots[0]).toMatchObject({
      boqJobId: 'portal-job-complete', revision: 1, schemaVersion: '1.0',
      dataStatus: 'SAMPLE', productionMode: false, currency: 'INR',
      totalsAmount: 123.45, lineCount: 1, withheldCount: 0, pricedLineCount: 1, unpricedLineCount: 0,
      snapshotBlobPath: 'snapshots/project-1/portal-job-complete/rev-1.json',
      exportBlobPath: 'exports/project-1/portal-job-complete/boq-portal-job-complete-rev-1.xlsx',
      savedById: EMPLOYEE_ID, scaleConfirmedBy: EMPLOYEE_ID,
    });
    expect(prisma._jobs[0].status).toBe('COMPLETED');
  });

  it('refuses an unknown snapshot schema without persisting it or completing the job', async () => {
    const prisma = buildPrisma();
    prisma._jobs.push({
      id: 'portal-job-unknown-snapshot', employeeId: EMPLOYEE_ID, projectId: PROJECT_ID,
      serviceJobId: 'service-job-1', status: 'RUNNING', inputFiles: [], settingsJson: {}, revision: 1,
      createdAt: new Date(), updatedAt: new Date(),
    });
    mockBoqClient.getJob.mockResolvedValueOnce({ job_id: 'service-job-1', status: 'done' });
    mockBoqClient.getSnapshot.mockResolvedValueOnce({ schema_version: '2.0', kind: 'acs.boq.snapshot', lines: [] });
    const app = buildApp(prisma);

    const response = await request(app)
      .get('/api/boq-generator/jobs/portal-job-unknown-snapshot')
      .set('x-test-employee', EMPLOYEE_ID);

    expect(response.status).toBe(502);
    expect(response.body.code).toBe('BOQ_SNAPSHOT_VERSION_UNSUPPORTED');
    expect(prisma._snapshots).toHaveLength(0);
    expect(mockWriteSnapshot).not.toHaveBeenCalled();
    expect(prisma._jobs[0].status).toBe('COMPLETED_PENDING_EXPORT');
  });

  it('retries only workbook capture after snapshot persistence succeeds', async () => {
    const prisma = buildPrisma();
    prisma._jobs.push({
      id: 'portal-job-export-retry', employeeId: EMPLOYEE_ID, projectId: PROJECT_ID,
      serviceJobId: 'service-job-1', status: 'RUNNING', inputFiles: [], settingsJson: {}, revision: 1,
      createdAt: new Date(), updatedAt: new Date(),
    });
    const snapshot = {
      schema_version: '1.0', kind: 'acs.boq.snapshot', data_status: 'SAMPLE',
      totals: { currency: 'INR', amount: 10, line_count: 1, withheld_count: 0 },
      lines: [{ line_id: 'line-1' }], withheld: [],
    };
    mockBoqClient.getJob.mockResolvedValueOnce({ job_id: 'service-job-1', status: 'done' });
    mockBoqClient.getSnapshot.mockResolvedValueOnce(snapshot);
    mockBoqClient.getBoqXlsx.mockRejectedValueOnce({ kind: 'network' });
    const app = buildApp(prisma);

    const first = await request(app)
      .get('/api/boq-generator/jobs/portal-job-export-retry')
      .set('x-test-employee', EMPLOYEE_ID);

    expect(first.status).toBe(200);
    expect(first.body.status).toBe('COMPLETED_PENDING_EXPORT');
    expect(prisma._snapshots).toHaveLength(1);
    expect(prisma._snapshots[0].exportBlobPath).toBeNull();

    mockBoqClient.getBoqXlsx.mockResolvedValueOnce(Buffer.from('retry-xlsx'));
    const second = await request(app)
      .get('/api/boq-generator/jobs/portal-job-export-retry')
      .set('x-test-employee', EMPLOYEE_ID);

    expect(second.status).toBe(200);
    expect(second.body.status).toBe('COMPLETED');
    expect(mockBoqClient.getSnapshot).toHaveBeenCalledTimes(1);
    expect(mockBoqClient.getBoqXlsx).toHaveBeenCalledTimes(2);
    expect(mockWriteSnapshot).toHaveBeenCalledTimes(1);
    expect(prisma._snapshots[0].exportBlobPath).toContain('.xlsx');
  });

  it('provides an idempotent explicit save route for completed jobs', async () => {
    const prisma = buildPrisma();
    prisma._jobs.push({
      id: 'portal-job-save', employeeId: EMPLOYEE_ID, projectId: PROJECT_ID,
      serviceJobId: 'service-job-1', status: 'COMPLETED_PENDING_EXPORT', inputFiles: [], settingsJson: {},
      revision: 1, createdAt: new Date(), updatedAt: new Date(),
    });
    prisma._snapshots.push({
      id: 'snapshot-save', boqJobId: 'portal-job-save', revision: 1, schemaVersion: '1.0',
      dataStatus: 'SAMPLE', productionMode: false, currency: 'INR', lineCount: 1, withheldCount: 0,
      snapshotBlobPath: 'snapshots/project-1/portal-job-save/rev-1.json', exportBlobPath: null,
      savedById: EMPLOYEE_ID,
    });
    const app = buildApp(prisma);

    const saved = await request(app)
      .post('/api/boq-generator/jobs/portal-job-save/save')
      .set('x-test-employee', EMPLOYEE_ID);
    const replay = await request(app)
      .post('/api/boq-generator/jobs/portal-job-save/save')
      .set('x-test-employee', EMPLOYEE_ID);

    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ status: 'COMPLETED', revision: 1 });
    expect(replay.status).toBe(200);
    expect(prisma._snapshots).toHaveLength(1);
    expect(mockBoqClient.getSnapshot).not.toHaveBeenCalled();
  });

  it('saves a line correction with server-owned requested_by and requires a nonempty reason', async () => {
    const prisma = buildPrisma();
    prisma._jobs.push({
      id: 'portal-job-correction', employeeId: EMPLOYEE_ID, projectId: PROJECT_ID,
      serviceJobId: 'service-job-1', status: 'COMPLETED', inputFiles: [], settingsJson: {},
      revision: 1, createdAt: new Date(), updatedAt: new Date(),
    });
    prisma._snapshots.push({
      id: 'snapshot-correction-rev-1', boqJobId: 'portal-job-correction', revision: 1,
      schemaVersion: '1.0', snapshotBlobPath: 'snapshots/project-1/portal-job-correction/rev-1.json',
      exportBlobPath: 'exports/project-1/portal-job-correction/rev-1.xlsx',
    });
    mockBoqClient.getSnapshot.mockResolvedValueOnce({
      schema_version: '1.0', kind: 'acs.boq.snapshot', data_status: 'SAMPLE',
      totals: { currency: 'INR', amount: 125, line_count: 1, withheld_count: 0 },
      lines: [{ line_id: 'line-1', qty: 4.5, rate: 27.78, amount: 125 }], withheld: [],
    });
    mockBoqClient.getBoqXlsx.mockResolvedValueOnce(Buffer.from('corrected-xlsx'));
    mockBoqClient.correctLine.mockResolvedValueOnce({
      job_id: 'service-job-1', correction: { id: 'correction-1', kind: 'override_qty', reason: 'Measured on site', requested_by: 'boqjob:portal-job-correction' },
    });
    const app = buildApp(prisma);

    const response = await request(app)
      .post('/api/boq-generator/jobs/portal-job-correction/lines/line-1/corrections')
      .set('x-test-employee', EMPLOYEE_ID)
      .send({ kind: 'override_qty', qty: 4.5, reason: 'Measured on site', requested_by: 'forged-user' });
    const missingReason = await request(app)
      .post('/api/boq-generator/jobs/portal-job-correction/lines/line-1/corrections')
      .set('x-test-employee', EMPLOYEE_ID)
      .send({ kind: 'override_qty', qty: 4.5, reason: '  ' });

    expect(response.status).toBe(200);
    expect(mockBoqClient.correctLine).toHaveBeenCalledWith({
      serviceJobId: 'service-job-1', lineId: 'line-1', requestId: 'test-request-id',
      payload: { kind: 'override_qty', qty: 4.5, reason: 'Measured on site', requested_by: 'boqjob:portal-job-correction' },
    });
    expect(response.body.correction).toMatchObject({ id: 'correction-1' });
    expect(JSON.stringify(response.body)).not.toContain('service-job-1');
    expect(missingReason.status).toBe(400);
    expect(mockBoqClient.correctLine).toHaveBeenCalledTimes(1);
    expect(prisma._snapshots).toHaveLength(2);
    expect(prisma._snapshots.map((snapshot) => snapshot.revision)).toEqual([1, 2]);
    expect(mockWriteSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      blobPath: 'snapshots/project-1/portal-job-correction/rev-2.json',
    }));
    expect(prisma._jobs[0].revision).toBe(2);
  });

  it('refuses rate corrections while the job uses non-real rates', async () => {
    const prisma = buildPrisma();
    prisma._jobs.push({
      id: 'portal-job-sample-rate', employeeId: EMPLOYEE_ID, projectId: PROJECT_ID,
      serviceJobId: 'service-job-1', status: 'COMPLETED', dataStatus: 'SAMPLE', inputFiles: [], settingsJson: {},
      createdAt: new Date(), updatedAt: new Date(),
    });
    const app = buildApp(prisma);

    const response = await request(app)
      .post('/api/boq-generator/jobs/portal-job-sample-rate/lines/line-1/corrections')
      .set('x-test-employee', EMPLOYEE_ID)
      .send({ kind: 'override_rate', rate: 100, reason: 'Use updated rate' });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('BOQ_RATE_CORRECTION_DISABLED');
    expect(mockBoqClient.correctLine).not.toHaveBeenCalled();
  });

  it('retries snapshot capture after an accepted correction without replacing the old revision', async () => {
    const prisma = buildPrisma();
    prisma._jobs.push({
      id: 'portal-job-correction-retry', employeeId: EMPLOYEE_ID, projectId: PROJECT_ID,
      serviceJobId: 'service-job-1', status: 'COMPLETED', inputFiles: [], settingsJson: {},
      revision: 1, createdAt: new Date(), updatedAt: new Date(),
    });
    prisma._snapshots.push({
      id: 'snapshot-correction-retry-rev-1', boqJobId: 'portal-job-correction-retry', revision: 1,
      schemaVersion: '1.0', snapshotBlobPath: 'snapshots/project-1/portal-job-correction-retry/rev-1.json',
      exportBlobPath: 'exports/project-1/portal-job-correction-retry/rev-1.xlsx',
    });
    mockBoqClient.correctLine.mockResolvedValueOnce({ correction: { id: 'correction-retry-1' } });
    mockBoqClient.getSnapshot.mockRejectedValueOnce({ kind: 'network' });
    const app = buildApp(prisma);

    const corrected = await request(app)
      .post('/api/boq-generator/jobs/portal-job-correction-retry/lines/line-1/corrections')
      .set('x-test-employee', EMPLOYEE_ID)
      .send({ kind: 'override_qty', qty: 3, reason: 'Measured on site' });

    expect(corrected.status).toBe(202);
    expect(prisma._jobs[0].settingsJson.pendingSnapshotRevision).toBe(2);

    mockBoqClient.getSnapshot.mockResolvedValueOnce({
      schema_version: '1.0', kind: 'acs.boq.snapshot', data_status: 'SAMPLE',
      totals: { currency: 'INR', amount: 30, line_count: 1, withheld_count: 0 },
      lines: [{ line_id: 'line-1', qty: 3 }], withheld: [],
    });
    const saved = await request(app)
      .post('/api/boq-generator/jobs/portal-job-correction-retry/save')
      .set('x-test-employee', EMPLOYEE_ID);

    expect(saved.status).toBe(200);
    expect(prisma._snapshots.map((snapshot) => snapshot.revision)).toEqual([1, 2]);
    expect(prisma._jobs[0].revision).toBe(2);
    expect(prisma._jobs[0].settingsJson.pendingSnapshotRevision).toBeUndefined();
  });

  it('deletes an owned job from the service and removes its portal artifacts', async () => {
    const prisma = buildPrisma();
    const snapshotPath = 'snapshots/project-1/portal-job-delete/rev-1.json';
    const exportPath = 'exports/project-1/portal-job-delete/boq-portal-job-delete-rev-1.xlsx';
    const drawingPath = 'drawings/project-1/employee-1/upload-delete.dxf';
    mockStoredArtifacts.set(snapshotPath, { schema_version: '1.0' });
    mockStoredArtifacts.set(exportPath, Buffer.from('xlsx'));
    prisma._jobs.push({
      id: 'portal-job-delete', employeeId: EMPLOYEE_ID, projectId: PROJECT_ID,
      serviceJobId: 'service-job-delete', status: 'COMPLETED',
      inputFiles: [{ uploadId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', blobPath: drawingPath }], settingsJson: {},
      createdAt: new Date(), updatedAt: new Date(),
    });
    prisma._intents.push({
      employeeId: EMPLOYEE_ID, ulid: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      status: 'CONFIRMED', boundType: 'boq_job', boundAt: new Date(),
    });
    prisma._snapshots.push({ id: 'snapshot-delete', boqJobId: 'portal-job-delete', revision: 1, snapshotBlobPath: snapshotPath, exportBlobPath: exportPath });
    const app = buildApp(prisma);

    const response = await request(app)
      .delete('/api/boq-generator/jobs/portal-job-delete')
      .set('x-test-employee', EMPLOYEE_ID);

    expect(response.status).toBe(200);
    expect(response.body.deleted).toBe(true);
    expect(mockBoqClient.deleteJob).toHaveBeenCalledWith({ serviceJobId: 'service-job-delete', requestId: 'test-request-id' });
    expect(mockDeleteBlob).toHaveBeenCalledWith(snapshotPath);
    expect(mockDeleteBlob).toHaveBeenCalledWith(exportPath);
    expect(mockDeleteBlob).toHaveBeenCalledWith(drawingPath);
    expect(prisma._jobs).toHaveLength(0);
    expect(prisma._snapshots).toHaveLength(0);
    expect(prisma._intents[0]).toMatchObject({ status: 'EXPIRED', boundType: null, boundAt: null });
  });

  it('continues deletion cleanup when the service job is already gone', async () => {
    const prisma = buildPrisma();
    mockBoqClient.deleteJob.mockRejectedValueOnce({ code: 'JOB_NOT_FOUND' });
    prisma._jobs.push({
      id: 'portal-job-delete-gone', employeeId: EMPLOYEE_ID, projectId: PROJECT_ID,
      serviceJobId: 'service-job-already-gone', status: 'COMPLETED', inputFiles: [], settingsJson: {},
      createdAt: new Date(), updatedAt: new Date(),
    });
    const app = buildApp(prisma);

    const response = await request(app)
      .delete('/api/boq-generator/jobs/portal-job-delete-gone')
      .set('x-test-employee', EMPLOYEE_ID);

    expect(response.status).toBe(200);
    expect(response.body.deleted).toBe(true);
    expect(prisma._jobs).toHaveLength(0);
  });

  it('keeps a deletion marker so R2 cleanup failure can be retried without repeating service delete', async () => {
    const prisma = buildPrisma();
    const exportPath = 'exports/project-1/portal-job-delete-retry/rev-1.xlsx';
    prisma._jobs.push({
      id: 'portal-job-delete-retry', employeeId: EMPLOYEE_ID, projectId: PROJECT_ID,
      serviceJobId: 'service-job-delete-retry', status: 'COMPLETED', inputFiles: [], settingsJson: {},
      createdAt: new Date(), updatedAt: new Date(),
    });
    prisma._snapshots.push({ id: 'snapshot-delete-retry', boqJobId: 'portal-job-delete-retry', revision: 1, snapshotBlobPath: 'snapshots/project-1/portal-job-delete-retry/rev-1.json', exportBlobPath: exportPath });
    mockDeleteBlob.mockRejectedValueOnce(new Error('R2 unavailable'));
    const app = buildApp(prisma);

    const first = await request(app)
      .delete('/api/boq-generator/jobs/portal-job-delete-retry')
      .set('x-test-employee', EMPLOYEE_ID);
    const second = await request(app)
      .delete('/api/boq-generator/jobs/portal-job-delete-retry')
      .set('x-test-employee', EMPLOYEE_ID);

    expect(first.status).toBe(503);
    expect(second.status).toBe(200);
    expect(mockBoqClient.deleteJob).toHaveBeenCalledTimes(1);
    expect(prisma._jobs).toHaveLength(0);
  });

  it('requires export acknowledgement and serves only the stored snapshot export', async () => {
    const prisma = buildPrisma();
    const exportPath = 'exports/project-1/portal-job-export/boq-portal-job-export-rev-1.xlsx';
    prisma._jobs.push({
      id: 'portal-job-export', employeeId: EMPLOYEE_ID, projectId: PROJECT_ID,
      serviceJobId: 'service-job-1', status: 'COMPLETED', inputFiles: [], settingsJson: {},
      createdAt: new Date(), updatedAt: new Date(),
    });
    prisma._snapshots.push({ id: 'snapshot-export', boqJobId: 'portal-job-export', revision: 1, snapshotBlobPath: 'snapshots/project-1/portal-job-export/rev-1.json', exportBlobPath: exportPath, acknowledgedById: null, acknowledgedAt: null });
    mockStoredArtifacts.set(exportPath, Buffer.from('stored-xlsx'));
    const app = buildApp(prisma);

    const blocked = await request(app)
      .get('/api/boq-generator/jobs/portal-job-export/export')
      .set('x-test-employee', EMPLOYEE_ID);
    const acknowledged = await request(app)
      .post('/api/boq-generator/jobs/portal-job-export/export/acknowledge')
      .set('x-test-employee', EMPLOYEE_ID)
      .send({ acknowledged: true });
    const downloaded = await request(app)
      .get('/api/boq-generator/jobs/portal-job-export/export')
      .set('x-test-employee', EMPLOYEE_ID);

    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('BOQ_EXPORT_ACK_REQUIRED');
    expect(acknowledged.status).toBe(200);
    expect(prisma._snapshots[0].acknowledgedById).toBe(EMPLOYEE_ID);
    expect(prisma._snapshots[0].acknowledgedAt).toBeInstanceOf(Date);
    expect(downloaded.status).toBe(200);
    expect(downloaded.body.downloadUrl).toContain('https://private.example/read/');
    expect(downloaded.body.expiresAt).toBeTruthy();
    expect(mockCreateReadUrl).toHaveBeenCalledWith(exportPath);
  });

  it('regenerates an export from the frozen snapshot', async () => {
    const prisma = buildPrisma();
    const snapshotPath = 'snapshots/project-1/portal-job-regen/rev-1.json';
    const document = {
      schema_version: '1.0', data_status: 'SAMPLE', needs_scale_check: true,
      totals: { currency: 'INR', amount: 123.45, line_count: 2, withheld_count: 1 },
      inputs: [{ name: 'floor.dxf' }],
      lines: [{ line_id: 'line-1', group_name: 'Concrete', item_code: 'RCC-01', description: 'Concrete', unit: 'm3', qty: 2, qty_rounded: 2, rate: 61.725, amount: 123.45 }],
      withheld: [{ reason_code: 'NO_CANDIDATE_IN_ANY_SOURCE' }],
      scale: { factor: 1, confirmed_by: EMPLOYEE_ID },
    };
    mockStoredArtifacts.set(snapshotPath, document);
    prisma._jobs.push({
      id: 'portal-job-regen', employeeId: EMPLOYEE_ID, projectId: PROJECT_ID,
      serviceJobId: 'service-job-1', status: 'COMPLETED', dataStatus: 'SAMPLE', productionMode: false,
      settingsJson: { additionalExclusions: 'Electrical work' }, inputFiles: [],
      createdAt: new Date(), updatedAt: new Date(),
    });
    prisma._snapshots.push({
      id: 'snapshot-regen', boqJobId: 'portal-job-regen', revision: 1,
      schemaVersion: '1.0', snapshotBlobPath: snapshotPath, exportBlobPath: null,
      acknowledgedById: EMPLOYEE_ID, acknowledgedAt: new Date(),
    });
    const app = buildApp(prisma);

    const response = await request(app)
      .post('/api/boq-generator/jobs/portal-job-regen/export/regenerate')
      .set('x-test-employee', EMPLOYEE_ID);

    expect(response.status).toBe(200);
    expect(response.body.regenerated).toBe(true);
    expect(response.body.filename).toContain('regenerated-from-saved-snapshot');
    const regenerated = mockStoredArtifacts.get(response.body.exportBlobPath);
    expect(mockWriteExport).toHaveBeenCalledWith(expect.objectContaining({
      blobPath: response.body.exportBlobPath,
      buffer: expect.any(Buffer),
    }));
    expect(Buffer.isBuffer(regenerated)).toBe(true);
    expect(prisma._snapshots[0].exportBlobPath).toBe(response.body.exportBlobPath);
  });

  it('reconciles in-flight jobs behind the internal token and captures completed output', async () => {
    const prisma = buildPrisma();
    prisma._jobs.push({
      id: 'portal-job-reconcile', employeeId: EMPLOYEE_ID, projectId: PROJECT_ID,
      serviceJobId: 'service-job-1', status: 'SUBMITTED', inputFiles: [], settingsJson: {}, revision: 1,
      createdAt: new Date(), updatedAt: new Date(),
    });
    mockBoqClient.getJob.mockResolvedValue({ job_id: 'service-job-1', status: 'done', data_status: 'SAMPLE', production_mode: false });
    const app = buildApp(prisma);

    process.env.INTERNAL_API_TOKEN = 'test-boq-reconcile-token';
    const denied = await request(app).post('/api/internal/boq-reconcile').send({});
    const response = await request(app)
      .post('/api/internal/boq-reconcile')
      .set('X-Internal-Token', 'test-boq-reconcile-token')
      .send({});

    expect(denied.status).toBe(403);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ reconciled: 1, completed: 1, pendingExport: 0 });
    expect(prisma._jobs[0].status).toBe('COMPLETED');
  });

  it('marks forgotten service jobs LOST while keeping already captured snapshots available', async () => {
    const prisma = buildPrisma();
    prisma._jobs.push({
      id: 'portal-job-lost', employeeId: EMPLOYEE_ID, projectId: PROJECT_ID,
      serviceJobId: 'service-job-forgotten', status: 'RUNNING', inputFiles: [], settingsJson: {},
      createdAt: new Date(), updatedAt: new Date(),
    });
    prisma._snapshots.push({
      id: 'snapshot-lost', boqJobId: 'portal-job-lost', revision: 1,
      snapshotBlobPath: 'snapshots/project-1/portal-job-lost/rev-1.json', exportBlobPath: null,
    });
    mockBoqClient.getJob.mockRejectedValueOnce({ code: 'JOB_NOT_FOUND' });
    const app = buildApp(prisma);

    const response = await request(app)
      .get('/api/boq-generator/jobs/portal-job-lost')
      .set('x-test-employee', EMPLOYEE_ID);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('LOST');
    const snapshot = await request(app)
      .get('/api/boq-generator/jobs/portal-job-lost/boq')
      .set('x-test-employee', EMPLOYEE_ID);
    expect(snapshot.status).toBe(200);
    expect(snapshot.body).toMatchObject({ schema_version: '1.0' });
  });

  it('resubmits a LOST job from its still-bound private uploads using a fresh service idempotency key', async () => {
    const prisma = buildPrisma();
    prisma._jobs.push({
      id: 'portal-job-lost-retry', employeeId: EMPLOYEE_ID, projectId: PROJECT_ID,
      serviceJobId: 'service-job-forgotten', status: 'LOST', dxfScale: 1,
      inputFiles: [{ uploadId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', filename: 'floor.dxf', fileType: 'dxf', sizeBytes: 128, blobPath: 'drawings/project-1/employee-1/file.dxf' }],
      settingsJson: {}, createdAt: new Date(), updatedAt: new Date(),
    });
    mockBoqClient.submitJob.mockResolvedValueOnce({ job_id: 'service-job-retry', status: 'queued' });
    const app = buildApp(prisma);
    const response = await request(app).post('/api/boq-generator/jobs/portal-job-lost-retry/retry')
      .set('x-test-employee', EMPLOYEE_ID);

    expect(response.status).toBe(200);
    expect(response.body.id).toBe('portal-job-lost-retry');
    expect(mockBoqClient.submitJob).toHaveBeenCalledWith(expect.objectContaining({
      jobId: 'portal-job-lost-retry:retry:1',
    }));
  });

  it('does not advertise retry for a LOST job with no source files', async () => {
    const prisma = buildPrisma();
    prisma._jobs.push({ id: 'lost-without-files', employeeId: EMPLOYEE_ID, projectId: PROJECT_ID, status: 'LOST', inputFiles: [], settingsJson: {} });
    const app = buildApp(prisma);
    const response = await request(app).post('/api/boq-generator/jobs/lost-without-files/retry').set('x-test-employee', EMPLOYEE_ID);
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('BOQ_NOT_RETRYABLE');
  });

  it('persists sanitized upstream job error details for operator diagnosis', async () => {
    const prisma = buildPrisma();
    prisma._jobs.push({
      id: 'portal-job-failed', employeeId: EMPLOYEE_ID, projectId: PROJECT_ID,
      serviceJobId: 'service-job-1', status: 'SUBMITTED', inputFiles: [], settingsJson: {},
      createdAt: new Date(), updatedAt: new Date(),
    });
    mockBoqClient.getJob.mockResolvedValueOnce({
      job_id: 'service-job-1',
      status: 'failed',
      error: { code: 'SOURCE_UNCALIBRATED', message: 'Scale missing', details: ['floor.dxf: scale missing'] },
    });
    const app = buildApp(prisma);

    const response = await request(app)
      .get('/api/boq-generator/jobs/portal-job-failed')
      .set('x-test-employee', EMPLOYEE_ID);

    expect(response.status).toBe(200);
    expect(prisma._jobs[0]).toMatchObject({ status: 'FAILED', errorDetails: ['floor.dxf: scale missing'] });
    expect(response.body.error).toMatchObject({ code: 'BOQ_UNCALIBRATED' });
    expect(response.body.error.details).toBeUndefined();
  });

  it('provides service metadata through the authenticated portal route', async () => {
    mockBoqClient.getMeta.mockResolvedValue({
      schema_version: '1',
      service: { name: 'acs-boq', version: '1.0.0' },
      data_status: 'REAL',
      data_status_notes: ['sample rates'],
      production_mode: false,
      sor_sources: [{ name: 'TN_PWD_SOR', edition: null, is_sample: true, rate_count: 18, regions: ['Tamil Nadu'], effective_from: '2024-04-01', effective_dates: ['2024-04-01'] }],
      wbs_groups: [{ code: '01', name: 'Preliminaries', order: 1, sor_chapters: ['01'] }],
      units: { canonical: ['m', 'm2'], aliases: { m: ['meter'] } },
      scale_presets: [{ id: 'full_size', drawing_scale: 1, requires_ratio: false, guidance: 'Confirm scale' }],
      scale_guidance: 'Use confirmed model scale',
      scale_suggestion: 100,
      scale_plausibility: {
        model_extent_min_m: 0.1, model_extent_max_m: 500,
        model_extent_check_enabled: true,
        mapped_door_window_width_min_m: 0.4,
        mapped_door_window_width_max_m: 4,
        guidance: 'Review implausible scales',
        tuning_marker: 'private tuning marker',
        outcome: { job_status: 'done', needs_scale_check: 'boolean', flag: 'SCALE_IMPLAUSIBLE' },
      },
      supported_input_types: ['dxf', 'ifc'],
      limits: { max_upload_bytes: 52428800, max_sources_per_job: 20, fetch_total_timeout_seconds: 60 },
      fetch: { allowed_hosts: ['private.internal'] },
      process: { memory: 'private operational detail' },
      readers: { ifc: { version: 'private-reader-version' } },
    });
    const app = buildApp(buildPrisma());
    const response = await request(app)
      .get('/api/boq-generator/meta')
      .set('x-test-employee', EMPLOYEE_ID)
      .set('x-request-id', 'portal-meta-request');
    const cachedResponse = await request(app)
      .get('/api/boq-generator/meta')
      .set('x-test-employee', EMPLOYEE_ID)
      .set('x-request-id', 'portal-meta-request-2');

    expect(response.status).toBe(200);
    expect(cachedResponse.status).toBe(200);
    expect(response.body).toEqual({
      schemaVersion: '1',
      service: { name: 'acs-boq', version: '1.0.0' },
      dataStatus: 'REAL',
      effectiveStatus: 'REAL',
      dataStatusNotes: ['sample rates'],
      productionMode: false,
      rateSources: [{ name: 'TN_PWD_SOR', edition: null, isSample: true, rateCount: 18, regions: ['Tamil Nadu'], effectiveFrom: '2024-04-01', effectiveDates: ['2024-04-01'] }],
      wbsGroups: [{ code: '01', name: 'Preliminaries', order: 1, sorChapters: ['01'] }],
      units: { canonical: ['m', 'm2'], aliases: { m: ['meter'] } },
      scalePresets: [{ id: 'full_size', drawingScale: 1, requiresRatio: false, guidance: 'Confirm scale' }],
      scaleGuidance: 'Use confirmed model scale',
      scaleSuggestion: 100,
      scalePlausibility: {
        modelExtentMinM: 0.1, modelExtentMaxM: 500, modelExtentCheckEnabled: true,
        mappedDoorWindowWidthMinM: 0.4, mappedDoorWindowWidthMaxM: 4,
        guidance: 'Review implausible scales',
        outcome: { jobStatus: 'done', needsScaleCheck: 'boolean', flag: 'SCALE_IMPLAUSIBLE' },
      },
      supportedInputTypes: ['dxf', 'ifc'],
      limits: { maxUploadBytes: 52428800, maxSourcesPerJob: 20 },
    });
    expect(JSON.stringify(response.body)).not.toMatch(/private\.internal|private operational|private-reader|private tuning/);
    expect(mockBoqClient.getMeta).toHaveBeenCalledTimes(1);
    expect(mockBoqClient.getMeta).toHaveBeenCalledWith({ requestId: 'portal-meta-request' });
  });

  it('does not accept GET job-list filters in a query string', async () => {
    const prisma = buildPrisma();
    const app = buildApp(prisma);
    const response = await request(app).get('/api/boq-generator/jobs?employeeId=employee-2&projectId=project-1')
      .set('x-test-employee', ADMIN_ID).set('x-test-admin', 'true');
    expect(response.status).toBe(405);
    expect(prisma.boqJob.findMany).not.toHaveBeenCalled();
  });

  it('uses the service priced-line counts when regenerating coverage', async () => {
    const prisma = buildPrisma();
    const snapshotPath = 'snapshots/project-1/portal-job-coverage/rev-1.json';
    const document = {
      schema_version: '1.0', data_status: 'SAMPLE',
      totals: { amount: 10, line_count: 2, priced_line_count: 1, unpriced_line_count: 1, withheld_count: 2 },
      lines: [
        { line_id: 'priced', item_code: 'A', description: 'Priced', qty_rounded: 1, rate: 10, amount: 10 },
        { line_id: 'unpriced', item_code: 'B', description: 'Unpriced', qty_rounded: 1, rate: null, amount: null },
      ],
      withheld: [
        { line_id: 'unpriced', reason_code: 'NO_RATE' },
        { reason_code: 'SCALE_IMPLAUSIBLE', description: 'Scale advisory' },
      ],
    };
    prisma._jobs.push({
      id: 'portal-job-coverage', employeeId: EMPLOYEE_ID, projectId: PROJECT_ID,
      serviceJobId: 'service-job-1', status: 'COMPLETED', productionMode: false,
      inputFiles: [], settingsJson: {}, createdAt: new Date(), updatedAt: new Date(),
    });
    prisma._snapshots.push({
      id: 'snapshot-coverage', boqJobId: 'portal-job-coverage', revision: 1,
      snapshotBlobPath: snapshotPath, exportBlobPath: null,
      acknowledgedAt: new Date(), acknowledgedById: EMPLOYEE_ID,
    });
    mockStoredArtifacts.set(snapshotPath, document);
    const app = buildApp(prisma);

    const response = await request(app)
      .post('/api/boq-generator/jobs/portal-job-coverage/export/regenerate')
      .set('x-test-employee', EMPLOYEE_ID);

    expect(response.status).toBe(200);
    const workbook = JSON.parse(mockWriteExport.mock.calls.at(-1)[0].buffer.toString());
    const coverage = workbook.find((sheet) => sheet.name === 'COVERAGE');
    expect(coverage.rows[2][0]).toBe('1 of 2 lines priced (50% unpriced).');
  });

  it('limits each employee to two active submissions without applying a global cap', async () => {
    const prisma = buildPrisma();
    prisma._jobs.push(
      { id: 'owner-active-1', employeeId: EMPLOYEE_ID, projectId: PROJECT_ID, status: 'RUNNING', inputFiles: [], createdAt: new Date() },
      { id: 'owner-active-2', employeeId: EMPLOYEE_ID, projectId: PROJECT_ID, status: 'SUBMITTED', inputFiles: [], createdAt: new Date() },
      { id: 'other-active-1', employeeId: OTHER_EMPLOYEE_ID, projectId: PROJECT_ID, status: 'RUNNING', inputFiles: [], createdAt: new Date() },
      { id: 'other-active-2', employeeId: OTHER_EMPLOYEE_ID, projectId: PROJECT_ID, status: 'SUBMITTED', inputFiles: [], createdAt: new Date() },
    );
    const app = buildApp(prisma);
    const { presign } = await createConfirmedUpload(app, prisma);
    const response = await request(app)
      .post('/api/boq-generator/jobs')
      .set('x-test-employee', EMPLOYEE_ID)
      .set('Idempotency-Key', 'job-key-cap')
      .send({ projectId: PROJECT_ID, uploads: [presign.body.uploadId] });

    expect(response.status).toBe(429);
    expect(response.body.code).toBe('BOQ_EMPLOYEE_JOB_LIMIT');
    expect(mockBoqClient.submitJob).not.toHaveBeenCalled();
    expect(prisma._intents[0].boundAt).toBeNull();
  });

  it('counts retained drafts against the per-employee in-flight cap', async () => {
    const prisma = buildPrisma();
    prisma._jobs.push(
      { id: 'owner-draft-1', employeeId: EMPLOYEE_ID, projectId: PROJECT_ID, status: 'DRAFT', inputFiles: [], createdAt: new Date() },
      { id: 'owner-draft-2', employeeId: EMPLOYEE_ID, projectId: PROJECT_ID, status: 'DRAFT', inputFiles: [], createdAt: new Date() },
    );
    const app = buildApp(prisma);
    const { presign } = await createConfirmedUpload(app, prisma);
    const response = await request(app)
      .post('/api/boq-generator/jobs')
      .set('x-test-employee', EMPLOYEE_ID)
      .set('Idempotency-Key', 'job-key-drafts-not-counted')
      .send({ projectId: PROJECT_ID, uploads: [presign.body.uploadId] });

    expect(response.status).toBe(201);
    expect(mockBoqClient.submitJob).toHaveBeenCalledTimes(1);
  });

  it('does not let another employee\'s active jobs block this employee', async () => {
    const prisma = buildPrisma();
    prisma._jobs.push(
      { id: 'other-active-1', employeeId: OTHER_EMPLOYEE_ID, projectId: PROJECT_ID, status: 'RUNNING', inputFiles: [], createdAt: new Date() },
      { id: 'other-active-2', employeeId: OTHER_EMPLOYEE_ID, projectId: PROJECT_ID, status: 'RUNNING', inputFiles: [], createdAt: new Date() },
    );
    const app = buildApp(prisma);
    const { presign } = await createConfirmedUpload(app, prisma);
    const response = await request(app)
      .post('/api/boq-generator/jobs')
      .set('x-test-employee', EMPLOYEE_ID)
      .set('Idempotency-Key', 'job-key-independent-cap')
      .send({ projectId: PROJECT_ID, uploads: [presign.body.uploadId] });

    expect(response.status).toBe(201);
    expect(mockBoqClient.submitJob).toHaveBeenCalledTimes(1);
  });

  it('rejects non-owner, non-admin users with 404 for job and snapshot resources', async () => {
    const prisma = buildPrisma();
    const app = buildApp(prisma);
    const { presign } = await createConfirmedUpload(app, prisma);
    const created = await request(app)
      .post('/api/boq-generator/jobs')
      .set('x-test-employee', EMPLOYEE_ID)
      .set('Idempotency-Key', 'job-key-2')
      .send({ projectId: PROJECT_ID, uploads: [presign.body.uploadId] });
    prisma._snapshots.push({ boqJobId: created.body.id, revision: 1, snapshotBlobPath: 'snapshots/private.json' });
    prisma.projectAssignment.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

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

  it('hides another employee\'s job from any non-owner employee on both read routes', async () => {
    const prisma = buildPrisma();
    const app = buildApp(prisma);
    const { presign } = await createConfirmedUpload(app, prisma);
    const created = await request(app)
      .post('/api/boq-generator/jobs')
      .set('x-test-employee', EMPLOYEE_ID)
      .set('Idempotency-Key', 'job-key-owner-read')
      .send({ projectId: PROJECT_ID, uploads: [presign.body.uploadId] });
    expect(created.status).toBe(201);
    prisma._snapshots.push({ boqJobId: created.body.id, revision: 1, snapshotBlobPath: 'snapshots/private.json' });
    prisma.projectAssignment.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

    const colleagueJob = await request(app)
      .get(`/api/boq-generator/jobs/${created.body.id}`)
      .set('x-test-employee', OTHER_EMPLOYEE_ID);
    const colleagueBoq = await request(app)
      .get(`/api/boq-generator/jobs/${created.body.id}/boq`)
      .set('x-test-employee', OTHER_EMPLOYEE_ID);

    expect(colleagueJob.status).toBe(404);
    expect(colleagueBoq.status).toBe(404);
    expect(mockReadSnapshot).not.toHaveBeenCalled();
  });

  it('allows an administrator to read another employee\'s saved BOQ', async () => {
    const prisma = buildPrisma();
    const app = buildApp(prisma);
    const { presign } = await createConfirmedUpload(app, prisma);
    const created = await request(app)
      .post('/api/boq-generator/jobs')
      .set('x-test-employee', EMPLOYEE_ID)
      .set('Idempotency-Key', 'job-key-admin-read')
      .send({ projectId: PROJECT_ID, uploads: [presign.body.uploadId] });
    expect(created.status).toBe(201);
    prisma._snapshots.push({ boqJobId: created.body.id, revision: 1, snapshotBlobPath: 'snapshots/private.json' });

    const adminJob = await request(app)
      .get(`/api/boq-generator/jobs/${created.body.id}`)
      .set('x-test-employee', ADMIN_ID)
      .set('x-test-admin', 'true');
    const adminBoq = await request(app)
      .get(`/api/boq-generator/jobs/${created.body.id}/boq`)
      .set('x-test-employee', ADMIN_ID)
      .set('x-test-admin', 'true');

    expect(adminJob.status).toBe(200);
    expect(adminBoq.status).toBe(200);
    expect(mockReadSnapshot).toHaveBeenCalledWith('snapshots/private.json');
  });

  it('revokes cross-employee BOQ access immediately after an admin is demoted', async () => {
    const prisma = buildPrisma();
    const app = buildApp(prisma);
    const { presign } = await createConfirmedUpload(app, prisma);
    const created = await request(app)
      .post('/api/boq-generator/jobs')
      .set('x-test-employee', EMPLOYEE_ID)
      .set('Idempotency-Key', 'job-key-demoted-admin')
      .send({ projectId: PROJECT_ID, uploads: [presign.body.uploadId] });
    expect(created.status).toBe(201);
    prisma._snapshots.push({ boqJobId: created.body.id, revision: 1, snapshotBlobPath: 'snapshots/private.json' });
    prisma._employees.get(ADMIN_ID).isAdmin = false;
    process.env.BOQ_PILOT_EMPLOYEE_IDS = [EMPLOYEE_ID, OTHER_EMPLOYEE_ID, RATE_LIMIT_EMPLOYEE_ID, ADMIN_ID].join(',');

    const response = await request(app)
      .get(`/api/boq-generator/jobs/${created.body.id}/boq`)
      .set('x-test-employee', ADMIN_ID)
      .set('x-test-admin', 'true');

    expect(response.status).toBe(404);
    expect(mockReadSnapshot).not.toHaveBeenCalled();
  });

  it('returns the private snapshot JSON to the owning employee', async () => {
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

  it('shows metadata for saved snapshots without reading the snapshot blob', async () => {
    const prisma = buildPrisma();
    const app = buildApp(prisma);
    prisma._jobs.push({
      id: 'portal-job-list-coverage', employeeId: EMPLOYEE_ID, projectId: PROJECT_ID,
      status: 'COMPLETED', createdAt: new Date(), updatedAt: new Date(), inputFiles: [],
    });
    prisma._snapshots.push({
      boqJobId: 'portal-job-list-coverage', revision: 1,
      pricedLineCount: 7, unpricedLineCount: 2,
    });

    const response = await request(app)
      .post('/api/boq-generator/jobs/search').send({})
      .set('x-test-employee', EMPLOYEE_ID);

    expect(response.status).toBe(200);
    expect(response.body.jobs[0].snapshot).toMatchObject({ pricedLineCount: 7, unpricedLineCount: 2 });
    expect(mockReadSnapshot).not.toHaveBeenCalled();
  });
});