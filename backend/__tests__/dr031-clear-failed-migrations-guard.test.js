/**
 * DR-031 — the destructive migration-recovery script must guard its
 * DELETE so a successfully-applied migration row is never clobbered.
 *
 * Audit citation (pre-DR-031):
 *   backend/scripts/clear-failed-migrations.js DELETE matched only on
 *   migration_name with no state predicate. A typo or migration-name
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
 * [DR-032] Recovery is operator-only. The script's destructive path
 * requires `--confirmed-abandoned`; without the flag it runs a
 * read-only inspection and exits non-zero when non-applied rows exist.
 * No RENDER auto-fire, no postinstall hook, no lifecycle auto-fire.
 *
 * This test loads the script in two modes — destructive
 * (--confirmed-abandoned) and inspection (default with RENDER env) —
 * with a mocked PrismaClient, and asserts the captured SQL contains the
 * NOT-applied guard (destructive path) and never invokes DELETE
 * (inspection path).
 */

const capturedQueries = [];

let resolveDisconnect;
const disconnectPromise = new Promise((resolve) => {
  resolveDisconnect = resolve;
});

const mockExecuteRawUnsafe = jest.fn((sql) => {
  capturedQueries.push({ kind: 'execute', sql });
  return Promise.resolve(0);
});
const mockQueryRawUnsafe = jest.fn((sql) => {
  capturedQueries.push({ kind: 'query', sql });
  return Promise.resolve([]);
});
const mockDisconnect = jest.fn(() => {
  if (resolveDisconnect) resolveDisconnect();
  return Promise.resolve();
});

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    $executeRawUnsafe: mockExecuteRawUnsafe,
    $queryRawUnsafe: mockQueryRawUnsafe,
    $disconnect: mockDisconnect,
  })),
}));

describe('clear-failed-migrations — DR-031 NOT-applied guard', () => {
  const originalEnv = {
    RENDER: process.env.RENDER,
    DATABASE_URL: process.env.DATABASE_URL,
    DIRECT_DATABASE_URL: process.env.DIRECT_DATABASE_URL,
    POSTINSTALL_CLEAR_MIGRATIONS: process.env.POSTINSTALL_CLEAR_MIGRATIONS,
    OPS_RECONCILE_FAILED_MIGRATIONS: process.env.OPS_RECONCILE_FAILED_MIGRATIONS,
  };

  afterAll(() => {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(() => {
    capturedQueries.length = 0;
    mockExecuteRawUnsafe.mockClear();
    mockQueryRawUnsafe.mockClear();
    mockDisconnect.mockClear();
    resolveDisconnect = null;
    disconnectPromise.catch(() => {});
  });

  describe('destructive path (--confirmed-abandoned)', () => {
    let originalArgv;

    beforeEach(() => {
      originalArgv = process.argv;
      process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
      delete process.env.RENDER;
      delete process.env.POSTINSTALL_CLEAR_MIGRATIONS;
    });

    afterEach(() => {
      process.argv = originalArgv;
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
        // Set argv BEFORE requiring so CONFIRMED_ABANDONED flips true.
        process.argv = ['node', 'clear-failed-migrations.js', '--confirmed-abandoned'];
        require('../scripts/clear-failed-migrations.js');
      });

      await localDisconnect;

      const executes = capturedQueries.filter((q) => q.kind === 'execute');
      expect(executes.length).toBeGreaterThan(0);

      // Every emitted DELETE must exclude successfully-applied rows. The
      // NOT-applied guard: rolled_back_at IS NULL AND (finished_at IS NULL
      // OR applied_steps_count = 0). A successfully-applied row has
      // finished_at NOT NULL AND applied_steps_count > 0 AND rolled_back_at
      // IS NULL, which fails the guard on the right-hand OR clause.
      executes.forEach(({ sql }) => {
        expect(sql).toMatch(/_prisma_migrations/);
        expect(sql).toMatch(/migration_name/);
        expect(sql).toMatch(/"rolled_back_at"\s+IS\s+NULL/);
        expect(sql).toMatch(/"finished_at"\s+IS\s+NULL/);
        expect(sql).toMatch(/"applied_steps_count"\s+=\s*0/);
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
        process.argv = ['node', 'clear-failed-migrations.js', '--confirmed-abandoned'];
        require('../scripts/clear-failed-migrations.js');
      });

      await localDisconnect;

      const executes = capturedQueries.filter((q) => q.kind === 'execute');
      // KNOWN_BAD (per scripts/clear-failed-migrations.js) — pin the
      // order so a future re-ordering shows up as a test diff.
      expect(executes).toHaveLength(2);
      expect(executes[0].sql).toMatch(/20260905020000_n17_projects/);
      expect(executes[1].sql).toMatch(/20260906000000_n1_project_fk/);
    });
  });

  describe('inspection path (default; RENDER=true or POSTINSTALL_CLEAR_MIGRATIONS=1)', () => {
    let originalArgv;

    beforeEach(() => {
      originalArgv = process.argv;
      process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
      process.env.RENDER = 'true';
      delete process.env.POSTINSTALL_CLEAR_MIGRATIONS;
    });

    afterEach(() => {
      process.argv = originalArgv;
    });

    it('uses SELECT (read-only) — never issues DELETE', async () => {
      let resolveForThisTest;
      const localDisconnect = new Promise((resolve) => {
        resolveForThisTest = resolve;
      });
      mockDisconnect.mockImplementationOnce(() => {
        resolveForThisTest();
        return Promise.resolve();
      });

      jest.isolateModules(() => {
        // No --confirmed-abandoned → inspection path.
        process.argv = ['node', 'clear-failed-migrations.js'];
        require('../scripts/clear-failed-migrations.js');
      });

      await localDisconnect;

      const executes = capturedQueries.filter((q) => q.kind === 'execute');
      expect(executes).toHaveLength(0);

      // Inspection issues exactly one SELECT against _prisma_migrations
      // with the allowlist filter.
      const queries = capturedQueries.filter((q) => q.kind === 'query');
      expect(queries.length).toBeGreaterThan(0);
      queries.forEach(({ sql }) => {
        expect(sql).toMatch(/FROM\s+"_prisma_migrations"/);
        expect(sql).toMatch(/SELECT/);
        expect(sql).not.toMatch(/DELETE/);
      });
    });

    it('exits non-zero when non-applied rows are found', async () => {
      // Override the query result to simulate the inspection finding
      // a non-applied row.
      mockQueryRawUnsafe.mockImplementationOnce(() =>
        Promise.resolve([
          {
            migration_name: '20260905020000_n17_projects',
            finished_at: null,
            rolled_back_at: null,
            applied_steps_count: 0,
            started_at: new Date(),
          },
        ]),
      );

      let resolveForThisTest;
      const localDisconnect = new Promise((resolve) => {
        resolveForThisTest = resolve;
      });
      mockDisconnect.mockImplementationOnce(() => {
        resolveForThisTest();
        return Promise.resolve();
      });

      let exitCode;
      const originalExit = process.exit;
      process.exit = (code) => {
        exitCode = code;
        throw new Error('__exit__'); // unwinds the IIFE
      };

      try {
        jest.isolateModules(() => {
          process.argv = ['node', 'clear-failed-migrations.js'];
          require('../scripts/clear-failed-migrations.js');
        });
        // Allow IIFE to settle (it sets process.exitCode, doesn't call process.exit).
      } catch (e) {
        // ignore __exit__
      } finally {
        process.exit = originalExit;
      }

      await localDisconnect;

      // The script uses process.exitCode = 1 (preferred over process.exit
      // for IIFE-style cleanup). Check either exitCode (if process.exit
      // was called) or process.exitCode.
      expect(exitCode === 1 || process.exitCode === 1).toBe(true);
    });
  });

  describe('safety guards', () => {
    let originalArgv;

    beforeEach(() => {
      originalArgv = process.argv;
      delete process.env.RENDER;
      delete process.env.POSTINSTALL_CLEAR_MIGRATIONS;
    });

    afterEach(() => {
      process.argv = originalArgv;
    });

    it('short-circuits without --confirmed-abandoned AND without RENDER/POSTINSTALL env vars', async () => {
      // Operator intent (--confirmed-abandoned) is absent AND no env var
      // opted into the inspection path. The script must skip entirely
      // — never touch the DB.
      jest.isolateModules(() => {
        process.argv = ['node', 'clear-failed-migrations.js'];
        require('../scripts/clear-failed-migrations.js');
      });

      // Microtask flush.
      await Promise.resolve();

      expect(mockExecuteRawUnsafe).not.toHaveBeenCalled();
      expect(mockQueryRawUnsafe).not.toHaveBeenCalled();
    });

    it('short-circuits without DB env vars', async () => {
      // Even on Render, if there's no DATABASE_URL or DIRECT_DATABASE_URL,
      // the script must skip — never crash, never partially-connect.
      delete process.env.DATABASE_URL;
      delete process.env.DIRECT_DATABASE_URL;
      process.env.RENDER = 'true';

      jest.isolateModules(() => {
        process.argv = ['node', 'clear-failed-migrations.js'];
        require('../scripts/clear-failed-migrations.js');
      });

      await Promise.resolve();

      expect(mockExecuteRawUnsafe).not.toHaveBeenCalled();
      expect(mockQueryRawUnsafe).not.toHaveBeenCalled();
    });
  });
});
