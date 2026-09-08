/**
 * DR-031 — the postinstall migration-recovery script must guard its DELETE
 * so a successfully-applied migration row is never clobbered.
 *
 * Audit citation:
 *   backend/scripts/clear-failed-migrations.js:78-82 — DELETE matched only
 *   on migration_name with no state predicate. A typo or migration-name
 *   collision would delete a legitimately-applied ledger row, forcing
 *   `migrate deploy` to re-apply DDL on the next deploy.
 *
 * Prisma 5's `_prisma_migrations` table has NO `status` column — the
 * "applied" state is derived from
 *   finished_at IS NOT NULL
 *   AND rolled_back_at IS NULL
 *   AND applied_steps_count > 0
 * The fix narrows the WHERE clause so the DELETE only matches rows that
 * are clearly NOT applied (rolled back, or never finished).
 *
 * This test loads the script with a mocked PrismaClient, lets the IIFE
 * run, and asserts the captured DELETE SQL contains the NOT-applied guard.
 */

const capturedQueries = [];

let resolveDisconnect;
const disconnectPromise = new Promise((resolve) => {
  resolveDisconnect = resolve;
});

const mockExecuteRawUnsafe = jest.fn((sql) => {
  capturedQueries.push(sql);
  return Promise.resolve(0);
});
const mockDisconnect = jest.fn(() => {
  resolveDisconnect();
  return Promise.resolve();
});

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    $executeRawUnsafe: mockExecuteRawUnsafe,
    $disconnect: mockDisconnect,
  })),
}));

describe('clear-failed-migrations — DR-031 NOT-applied guard', () => {
  const originalEnv = {
    RENDER: process.env.RENDER,
    DATABASE_URL: process.env.DATABASE_URL,
    DIRECT_DATABASE_URL: process.env.DIRECT_DATABASE_URL,
    POSTINSTALL_CLEAR_MIGRATIONS: process.env.POSTINSTALL_CLEAR_MIGRATIONS,
  };

  beforeAll(() => {
    // The script is production-only (per the local-dev guard at lines 50-58).
    // Pretend we're on Render so the IIFE body actually runs.
    process.env.RENDER = 'true';
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterAll(() => {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(() => {
    capturedQueries.length = 0;
    mockExecuteRawUnsafe.mockClear();
    mockDisconnect.mockClear();
    // Reset the disconnect promise so each test waits for its own IIFE.
    resolveDisconnect = null;
    disconnectPromise.catch(() => {});
  });

  it('emits a DELETE whose WHERE clause excludes successfully-applied rows', async () => {
    let resolveForThisTest;
    const localDisconnect = new Promise((resolve) => {
      resolveForThisTest = resolve;
    });
    mockDisconnect.mockImplementationOnce(() => {
      resolveForThisTest();
      return Promise.resolve();
    });

    jest.isolateModules(() => {
      require('../scripts/clear-failed-migrations.js');
    });

    await localDisconnect;

    expect(capturedQueries.length).toBeGreaterThan(0);

    // Every emitted DELETE must exclude successfully-applied rows. The
    // NOT-applied guard: rolled_back_at IS NULL AND (finished_at IS NULL
    // OR applied_steps_count = 0). A successfully-applied row has
    // finished_at NOT NULL AND applied_steps_count > 0 AND rolled_back_at
    // IS NULL, which fails the guard on the right-hand OR clause.
    capturedQueries.forEach((sql) => {
      expect(sql).toMatch(/_prisma_migrations/);
      expect(sql).toMatch(/migration_name/);
      expect(sql).toMatch(/"rolled_back_at"\s+IS\s+NULL/);
      expect(sql).toMatch(/"finished_at"\s+IS\s+NULL/);
      expect(sql).toMatch(/"applied_steps_count"\s+=\s+0/);
    });
  });

  it('iterates the KNOWN_BAD list — one DELETE per entry', async () => {
    let resolveForThisTest;
    const localDisconnect = new Promise((resolve) => {
      resolveForThisTest = resolve;
    });
    mockDisconnect.mockImplementationOnce(() => {
      resolveForThisTest();
      return Promise.resolve();
    });

    jest.isolateModules(() => {
      require('../scripts/clear-failed-migrations.js');
    });

    await localDisconnect;

    // KNOWN_BAD (per scripts/clear-failed-migrations.js:41-47) — pin the
    // order so a future re-ordering shows up as a test diff.
    expect(capturedQueries).toHaveLength(2);
    expect(capturedQueries[0]).toMatch(/20260905020000_n17_projects/);
    expect(capturedQueries[1]).toMatch(/20260906000000_n1_project_fk/);
  });

  it('still short-circuits in non-Render / non-CI environments', async () => {
    process.env.RENDER = 'false';
    delete process.env.POSTINSTALL_CLEAR_MIGRATIONS;

    jest.isolateModules(() => {
      require('../scripts/clear-failed-migrations.js');
    });

    // The IIFE returns BEFORE constructing PrismaClient or calling
    // $executeRawUnsafe. Give it a tick to settle.
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockExecuteRawUnsafe).not.toHaveBeenCalled();
  });
});