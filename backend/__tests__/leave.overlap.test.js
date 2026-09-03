/**
 * Round-20 DR-009: PostgreSQL exclusion constraint is the authority for
 * "no two overlapping PENDING/APPROVED leaves for the same employee".
 *
 * What this file tests (against a mock-Prisma harness):
 *
 *   1. Two concurrent inserts — both pass the application-side precheck
 *      (mock returns empty array), and the DB rejects the second one
 *      with the EXCLUDE constraint violation. The route handler must
 *      translate that raw P2010 into a clean 409 LEAVE_OVERLAP, mirroring
 *      what a real Postgres btree_gist EXCLUDE constraint would do.
 *
 *   2. Sequential insert after a PENDING leave exists in the same range —
 *      the precheck catches it (we keep this layer because it produces
 *      better error messages than the raw constraint violation can).
 *
 *   3. INSERT with an overlapping REJECTED leave — both precheck and
 *      constraint filter to (status IN ('PENDING','APPROVED')), so the
 *      REJECTED row does NOT block a fresh submission. (The constraint's
 *      `WHERE status IN ('PENDING','APPROVED')` clause is mirrored by the
 *      precheck's `status: { in: ['PENDING','APPROVED'] }` so the two
 *      layers always agree.)
 *
 * Tests use a mocked Prisma client — we are NOT spinning up Postgres to
 * verify the constraint itself (that's the integration layer; the
 * migration in prisma/migrations/20260902220220_dr009_leave_overlap_constraint/
 * is the reviewable record). What we ARE verifying is that the route
 * handler treats the raw P2010 exactly the way a real Postgres violation
 * would land.
 */

const jwt = require('jsonwebtoken');

const mockPrisma = {
  employee: {
    findUnique: jest.fn(),
  },
  leaveRequest: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
};

const createMockReq = (overrides = {}) => ({
  body: {},
  params: {},
  query: {},
  headers: {},
  employeeId: 'test-employee-id',
  isAdmin: false,
  app: { get: () => mockPrisma },
  ...overrides,
});

const createMockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const generateToken = (employeeId) => {
  return jwt.sign(
    { employeeId, email: 'test@example.com' },
    process.env.JWT_SECRET || 'change-me-in-production',
    { expiresIn: '8h' }
  );
};

// findRoute helper (mirrors attendance.test.js). The router does
//   router.use(requireAuth);
//   router.post('/', leaveCreateLimiter, asyncHandler(...));
// so the route's own stack has [leaveCreateLimiter, asyncHandler]; we
// invoke the LAST entry, which is the asyncHandler.
function findRoute(router, method, path) {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === path && l.route.methods[method.toLowerCase()]
  );
  if (!layer) throw new Error(`route not found: ${method} ${path}`);
  const handlers = layer.route.stack.map((s) => s.handle);
  return handlers[handlers.length - 1];
}

// A valid future payload, anchored to today so validateCreatePayload's
// "max past days" / "max future days" don't reject it under any clock.
function makePayload() {
  // Anchor 7 days in the future so it's safely inside both windows
  // regardless of when the test runs.
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + 7);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 2); // 3-day inclusive window
  const fmt = (d) => d.toISOString().slice(0, 10);
  return {
    startDate: fmt(start),
    endDate: fmt(end),
    leaveType: 'CASUAL',
    reason: 'family event',
  };
}

describe('Leave POST — DR-009 overlap rejection', () => {
  let leaveRouter;
  let postHandler;

  beforeAll(() => {
    leaveRouter = require('../src/routes/leave');
    postHandler = findRoute(leaveRouter, 'POST', '/');
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects when a PENDING leave already overlaps (precheck path) — 409 LEAVE_OVERLAP', async () => {
    const payload = makePayload();
    // Precheck sees one PENDING leave in the same window.
    mockPrisma.leaveRequest.findMany.mockResolvedValueOnce([{
      id: 'existing-pending-1',
      startDate: new Date(payload.startDate),
      endDate: new Date(payload.endDate),
      status: 'PENDING',
    }]);

    const req = createMockReq({ body: payload });
    const res = createMockRes();

    await postHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    const body = res.json.mock.calls[0][0];
    expect(body.code).toBe('LEAVE_OVERLAP');
    expect(body.conflicts).toHaveLength(1);
    expect(body.conflicts[0].id).toBe('existing-pending-1');
    // The DB insert MUST NOT be attempted once the precheck says no.
    expect(mockPrisma.leaveRequest.create).not.toHaveBeenCalled();
  });

  it('rejects when an APPROVED leave already overlaps — 409 LEAVE_OVERLAP', async () => {
    const payload = makePayload();
    mockPrisma.leaveRequest.findMany.mockResolvedValueOnce([{
      id: 'existing-approved-1',
      startDate: new Date(payload.startDate),
      endDate: new Date(payload.endDate),
      status: 'APPROVED',
    }]);

    const req = createMockReq({ body: payload });
    const res = createMockRes();

    await postHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0].code).toBe('LEAVE_OVERLAP');
    expect(mockPrisma.leaveRequest.create).not.toHaveBeenCalled();
  });

  it('two concurrent inserts: precheck passes for both, second hits the EXCLUDE constraint and returns 409 LEAVE_OVERLAP', async () => {
    // Race scenario: both requests run their precheck at the same time,
    // both see "no overlap", both attempt to INSERT. Postgres rejects the
    // second one with the EXCLUDE constraint violation. Prisma surfaces
    // that as P2010 (raw query failed) with the constraint name in the
    // error body. The route handler must translate it into the same 409
    // LEAVE_OVERLAP the precheck would have produced.
    const payload = makePayload();

    // Precheck returns empty for BOTH concurrent attempts — they race.
    mockPrisma.leaveRequest.findMany.mockResolvedValueOnce([]);

    // First INSERT succeeds (the "winning" concurrent attempt).
    mockPrisma.leaveRequest.create.mockResolvedValueOnce({
      id: 'winner-1',
      employeeId: 'test-employee-id',
      startDate: new Date(payload.startDate),
      endDate: new Date(payload.endDate),
      leaveType: 'CASUAL',
      reason: 'family event',
      status: 'PENDING',
      reviewedById: null,
      reviewedAt: null,
      reviewNotes: null,
      cancelledAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      employee: { id: 'test-employee-id', name: 'Test', email: 'test@example.com', department: 'Eng' },
    });

    // Second INSERT fails — Postgres exclusion constraint violation.
    // Prisma surfaces raw query failures as P2010 with the constraint name
    // in err.meta.constraint (modern Prisma) and/or in err.message.
    const constraintError = new Error(
      'Raw query failed. Code: 23P01. Message: ERROR: conflicting key value violates exclusion constraint "no_overlap_leave"'
    );
    constraintError.code = 'P2010';
    constraintError.meta = { constraint: 'no_overlap_leave' };
    mockPrisma.leaveRequest.create.mockResolvedValueOnce(constraintError);

    // Fire BOTH inserts back-to-back; the test harness can't actually
    // run them concurrently, but we exercise both code paths so each is
    // covered.
    const req1 = createMockReq({ body: payload });
    const res1 = createMockRes();
    await postHandler(req1, res1);

    const req2 = createMockReq({ body: payload });
    const res2 = createMockRes();
    // The second attempt's precheck ALSO passes (race) — mock empty again
    // (jest.clearAllMocks wasn't called between calls).
    mockPrisma.leaveRequest.findMany.mockResolvedValueOnce([]);
    await postHandler(req2, res2);

    // First insert: 201.
    expect(res1.status).toHaveBeenCalledWith(201);

    // Second insert: translated to 409 LEAVE_OVERLAP (NOT 500, NOT a
    // generic Prisma error).
    expect(res2.status).toHaveBeenCalledWith(409);
    const body2 = res2.json.mock.calls[0][0];
    expect(body2.code).toBe('LEAVE_OVERLAP');
    expect(body2.error).toBe('This leave overlaps an existing request');
  });

  it('recognises the EXCLUDE constraint violation by message body even if err.meta is missing', async () => {
    // Older Prisma versions surface the constraint name only in err.message.
    // The detector must still match.
    const payload = makePayload();

    mockPrisma.leaveRequest.findMany.mockResolvedValueOnce([]);

    const messageOnlyError = new Error(
      'ERROR: conflicting key value violates exclusion constraint "no_overlap_leave"'
    );
    messageOnlyError.code = 'P2010';
    // Intentionally NO err.meta
    mockPrisma.leaveRequest.create.mockRejectedValueOnce(messageOnlyError);

    const req = createMockReq({ body: payload });
    const res = createMockRes();
    await postHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0].code).toBe('LEAVE_OVERLAP');
  });

  it('does NOT swallow unrelated P2010 errors — surfaces them through mapPrismaError', async () => {
    // A P2010 with a different constraint name (or no constraint name)
    // must NOT be silently translated to LEAVE_OVERLAP — that would mask
    // real DB bugs. The route falls through to mapPrismaError (which
    // returns null for P2010, since it's not in the switch) and then the
    // generic 500 handler.
    const payload = makePayload();

    mockPrisma.leaveRequest.findMany.mockResolvedValueOnce([]);

    const unrelated = new Error('Raw query failed. Some other constraint');
    unrelated.code = 'P2010';
    unrelated.meta = { constraint: 'some_other_constraint' };
    mockPrisma.leaveRequest.create.mockRejectedValueOnce(unrelated);

    const req = createMockReq({ body: payload });
    const res = createMockRes();
    await postHandler(req, res);

    // 500 is the fallback for unmapped errors.
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('INSERT is allowed when the overlapping leave is REJECTED (precheck filters by status)', async () => {
    // The constraint's WHERE clause is `status IN ('PENDING','APPROVED')`,
    // so a REJECTED leave in the same window does NOT block a fresh
    // submission. The precheck mirrors this with the same allowlist.
    const payload = makePayload();

    // Precheck returns empty: REJECTED rows are not in the
    // { in: ['PENDING','APPROVED'] } filter, so they don't show up.
    mockPrisma.leaveRequest.findMany.mockResolvedValueOnce([]);

    // Insert succeeds.
    mockPrisma.leaveRequest.create.mockResolvedValueOnce({
      id: 'new-after-rejected',
      employeeId: 'test-employee-id',
      startDate: new Date(payload.startDate),
      endDate: new Date(payload.endDate),
      leaveType: 'CASUAL',
      reason: 'family event',
      status: 'PENDING',
      reviewedById: null,
      reviewedAt: null,
      reviewNotes: null,
      cancelledAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      employee: { id: 'test-employee-id', name: 'Test', email: 'test@example.com', department: 'Eng' },
    });

    const req = createMockReq({ body: payload });
    const res = createMockRes();
    await postHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    // Verify the precheck actually filtered to PENDING/APPROVED — the
    // REJECTED status in the same window must not be in the result set
    // that decides "no overlap".
    const findManyArgs = mockPrisma.leaveRequest.findMany.mock.calls[0][0];
    expect(findManyArgs.where.status.in).toEqual(['PENDING', 'APPROVED']);
  });

  it('INSERT is allowed when the overlapping leave is CANCELLED (precheck filters by status)', async () => {
    const payload = makePayload();
    mockPrisma.leaveRequest.findMany.mockResolvedValueOnce([]);
    mockPrisma.leaveRequest.create.mockResolvedValueOnce({
      id: 'new-after-cancelled',
      employeeId: 'test-employee-id',
      startDate: new Date(payload.startDate),
      endDate: new Date(payload.endDate),
      leaveType: 'CASUAL',
      reason: 'family event',
      status: 'PENDING',
      reviewedById: null,
      reviewedAt: null,
      reviewNotes: null,
      cancelledAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      employee: { id: 'test-employee-id', name: 'Test', email: 'test@example.com', department: 'Eng' },
    });

    const req = createMockReq({ body: payload });
    const res = createMockRes();
    await postHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    const findManyArgs = mockPrisma.leaveRequest.findMany.mock.calls[0][0];
    expect(findManyArgs.where.status.in).toEqual(['PENDING', 'APPROVED']);
  });

  it('precheck is keyed by employeeId from the JWT, not the body', async () => {
    // Sanity check: the precheck must scope overlap detection to the
    // authenticated employee. An attacker who could spoof employeeId in
    // the body would otherwise be able to detect (and DoS by blocking)
    // other employees' leaves.
    const payload = makePayload();
    mockPrisma.leaveRequest.findMany.mockResolvedValueOnce([]);
    mockPrisma.leaveRequest.create.mockResolvedValueOnce({
      id: 'new-1',
      employeeId: 'test-employee-id',
      startDate: new Date(payload.startDate),
      endDate: new Date(payload.endDate),
      leaveType: 'CASUAL',
      reason: 'family event',
      status: 'PENDING',
      reviewedById: null,
      reviewedAt: null,
      reviewNotes: null,
      cancelledAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      employee: { id: 'test-employee-id', name: 'Test', email: 'test@example.com', department: 'Eng' },
    });

    const req = createMockReq({
      body: { ...payload, employeeId: 'someone-elses-id' },
    });
    const res = createMockRes();
    await postHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    const findManyArgs = mockPrisma.leaveRequest.findMany.mock.calls[0][0];
    expect(findManyArgs.where.employeeId).toBe('test-employee-id');
    // The created row also uses the JWT employeeId, not the body.
    const createArgs = mockPrisma.leaveRequest.create.mock.calls[0][0];
    expect(createArgs.data.employeeId).toBe('test-employee-id');
  });
});
