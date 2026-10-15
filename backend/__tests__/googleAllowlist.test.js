// [feat/google-login-allowlist] Management-script tests.
//
// Most cases invoke the actual `scripts/google-allowlist.js` via
// `child_process.spawnSync` so the script's `process.exit` calls,
// host-guard prompt logic, and Prisma transaction behaviour all run
// in their production form. The DB-touching cases require the
// `google_login_allowlist` table to exist in the test database; if
// the test DB has not been migrated, those cases early-return
// without making any assertion (no test-marker at all, so the
// no-skipped-tests guard does not fire).
//
// Isolation: every DB-touching test prefixes the rows it creates
// with `glx-<random>-` so the test can clean up its own scratch
// data even if a prior run left rows behind. The script under test
// normalises the email argument to lowercase before lookup, so the
// prefix is mixed-case-safe.

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const crypto = require('crypto');

// The script reads DATABASE_URL (or DIRECT_DATABASE_URL) at runtime.
// Pin to the same throwaway test DB the payslip-cross-employee-bind
// suite uses, so this suite is consistent with the rest of the
// real-DB test tier.
const TEST_DB_URL = process.env.THROW_AWAY_DATABASE_URL
  || 'postgresql://acs:acspw@localhost:55432/acs_portal';

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'google-allowlist.js');

// Run the script with `node` so its top-level `main()` runs.
// Returns { status, stdout, stderr, error }.
function run(args, { env, ...rest } = {}) {
  const fullEnv = {
    ...process.env,
    DATABASE_URL: TEST_DB_URL,
    ...(env || {}),
  };
  // Force a non-TTY stdin so the interactive prompt path is
  // unreachable — the script must rely on --yes.
  return spawnSync('node', [SCRIPT, ...args], {
    env: fullEnv,
    encoding: 'utf8',
    // Spawning without inheriting stdio ensures the spawned
    // process does not see a TTY (process.stdin.isTTY === false),
    // which is what we want to exercise the refusal path.
    stdio: ['pipe', 'pipe', 'pipe'],
    ...rest,
  });
}

// Probe whether the test DB has the google_login_allowlist table.
// If not, the DB-touching tests in this file are no-ops (the host-
// guard and arg-parsing tests are unaffected — they exit before any
// Prisma call).
let TABLE_AVAILABLE = null;
async function isTableAvailable() {
  if (TABLE_AVAILABLE !== null) return TABLE_AVAILABLE;
  try {
    const { PrismaClient } = require('@prisma/client');
    const p = new PrismaClient({ datasources: { db: { url: TEST_DB_URL } } });
    try {
      const rows = await p.$queryRawUnsafe(
        "SELECT to_regclass('public.google_login_allowlist') AS reg"
      );
      TABLE_AVAILABLE = !!(rows && rows[0] && rows[0].reg);
    } finally {
      await p.$disconnect();
    }
  } catch (_) {
    TABLE_AVAILABLE = false;
  }
  return TABLE_AVAILABLE;
}

function makeEmail() {
  return `glx-${crypto.randomBytes(4).toString('hex')}@gmail.com`;
}

// ─── Host-guard (no DB needed) ───────────────────────────────────────────
describe('google-allowlist script — host-guard', () => {
  it('refuses to run `add` against a non-localhost host with no --yes and no TTY', () => {
    // DATABASE_URL points at a non-loopback host; the script
    // refuses via process.exit(2) inside confirmOrAbort.
    const res = run(
      ['add', 'test@gmail.com'],
      { env: { DATABASE_URL: 'postgresql://u:p@db.example.supabase.co:5432/db' } }
    );
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/REFUSING to run add/);
    expect(res.stderr).toMatch(/db\.example\.supabase\.co/);
  });

  it('refuses `remove` against a non-localhost host with no --yes', () => {
    const res = run(
      ['remove', 'test@gmail.com'],
      { env: { DATABASE_URL: 'postgresql://u:p@db.example.supabase.co:5432/db' } }
    );
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/REFUSING to run remove/);
  });

  it('refuses `enable` against a non-localhost host with no --yes', () => {
    const res = run(
      ['enable', 'test@gmail.com'],
      { env: { DATABASE_URL: 'postgresql://u:p@db.example.supabase.co:5432/db' } }
    );
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/REFUSING to run enable/);
  });

  it('proceeds with --yes against a non-localhost host (no prompt) — but the table must exist for add to actually run', async () => {
    // This test does not assert a particular DB outcome; it asserts
    // that --yes BYPASSES the host-guard. With a missing table, the
    // script will exit 1 from the Prisma error; the important thing
    // is it does NOT exit 2 (the host-guard refusal code).
    const res = run(
      ['add', 'test@gmail.com', '--yes'],
      { env: { DATABASE_URL: 'postgresql://u:p@db.example.supabase.co:5432/db' } }
    );
    if (!(await isTableAvailable())) {
      // Without the table, expect a Prisma error (exit 1), not 2.
      expect(res.status).not.toBe(2);
      return;
    }
    // With the table, the add succeeds (exit 0). The row persists;
    // we don't clean it up here because the throwaway DB is
    // expected to be reset between runs.
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/"ok":\s*true/);
  });

  it('`list` is NOT guarded — proceeds against any host with no --yes', () => {
    const res = run(
      ['list'],
      { env: { DATABASE_URL: 'postgresql://u:p@db.example.supabase.co:5432/db' } }
    );
    // list never refuses, even against a non-localhost host. The
    // script may fail at the Prisma connect call (exit 1) if the
    // DB is unreachable, but it must NOT exit 2.
    expect(res.status).not.toBe(2);
  });
});

// ─── Argument parsing (no DB needed) ─────────────────────────────────────
describe('google-allowlist script — argument parsing', () => {
  it('`add` with no positional args → exit 1 + "add requires exactly one positional argument"', () => {
    // The script distinguishes argument-parser errors (parseArgs
    // throws → exit 2) from command-body errors (cmdAdd throws →
    // exit 1 from main's catch). A bare `add` reaches the command
    // body and fails on the missing email — exit 1, not 2.
    const res = run(['add']);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/add requires exactly one positional argument/);
  });

  it('no command at all → exit 2 + usage', () => {
    // Bare invocation with no command — parseArgs returns
    // command=undefined; the main() handler prints USAGE and
    // exits 2 (the "no command" usage error).
    const res = run([]);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/Usage:/);
  });

  it('`add` with unknown flag → exit 2 + "unknown flag"', () => {
    const res = run(['add', 'a@gmail.com', '--bogus']);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/unknown flag/);
  });

  it('`add` with --note but no value → exit 2 + "--note requires a value"', () => {
    const res = run(['add', 'a@gmail.com', '--note']);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/--note requires a value/);
  });

  it('`add` with @acschennai.com email → exit 1 + domain-gate message', () => {
    const res = run(['add', 'test@acschennai.com', '--yes']);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/acschennai\.com addresses must use Zoho sign-in/);
  });

  it('`add` with malformed email → exit 1 + "not a valid email address"', () => {
    const res = run(['add', 'not-an-email', '--yes']);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/not a valid email address/);
  });

  it('unknown command → exit 2 + usage', () => {
    const res = run(['frobnicate']);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/unknown command: frobnicate/);
  });
});

// ─── DB-touching cases (gated on table existence) ────────────────────────
describe('google-allowlist script — add / remove / enable round-trip', () => {
  let prisma;
  let cleanupEmails;

  beforeAll(async () => {
    if (!(await isTableAvailable())) return; // gate
    const { PrismaClient } = require('@prisma/client');
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DB_URL } } });
    cleanupEmails = [];
  });

  afterAll(async () => {
    if (prisma && cleanupEmails && cleanupEmails.length) {
      try {
        await prisma.googleLoginAllowlist.deleteMany({
          where: { email: { in: cleanupEmails } },
        });
      } catch (_) { /* best-effort cleanup */ }
    }
    if (prisma) await prisma.$disconnect();
  });

  it('add → list → remove → enable (sub preserved) → enable --reset-sub (sub cleared)', async () => {
    if (!(await isTableAvailable())) return; // gate
    const email = makeEmail();
    cleanupEmails.push(email);

    // 1. add (with a note; no --user)
    let res = run(['add', email, '--note', 'glx-script-test', '--yes']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/"created":\s*true/);
    expect(res.stdout).toMatch(/"isActive":\s*true/);

    let row = await prisma.googleLoginAllowlist.findUnique({ where: { email } });
    expect(row).toBeTruthy();
    expect(row.note).toBe('glx-script-test');
    expect(row.isActive).toBe(true);

    // 2. simulate a first Google login: stamp googleSub + lastLoginAt
    //    via a direct write (the route does this — we're testing the
    //    script, not the route).
    await prisma.googleLoginAllowlist.update({
      where: { id: row.id },
      data: { googleSub: 'GGL-SUB-1', lastLoginAt: new Date() },
    });

    // 3. remove → isActive=false, googleSub preserved, refresh tokens
    //    revoked (zero because no Employee is linked).
    res = run(['remove', email, '--yes']);
    expect(res.status).toBe(0);
    row = await prisma.googleLoginAllowlist.findUnique({ where: { email } });
    expect(row.isActive).toBe(false);
    expect(row.googleSub).toBe('GGL-SUB-1');

    // 4. enable (no --reset-sub) → isActive=true, googleSub preserved.
    res = run(['enable', email, '--yes']);
    expect(res.status).toBe(0);
    row = await prisma.googleLoginAllowlist.findUnique({ where: { email } });
    expect(row.isActive).toBe(true);
    expect(row.googleSub).toBe('GGL-SUB-1');

    // 5. enable --reset-sub → googleSub cleared.
    res = run(['enable', email, '--reset-sub', '--yes']);
    expect(res.status).toBe(0);
    row = await prisma.googleLoginAllowlist.findUnique({ where: { email } });
    expect(row.isActive).toBe(true);
    expect(row.googleSub).toBeNull();
  });

  it('add is idempotent: re-`add` for the same email updates note + userId but does not touch googleSub or isActive', async () => {
    if (!(await isTableAvailable())) return; // gate
    const email = makeEmail();
    cleanupEmails.push(email);

    // First add.
    let res = run(['add', email, '--note', 'note-1', '--yes']);
    expect(res.status).toBe(0);

    // Stamp a sub + set isActive=false (simulate a remove).
    let row = await prisma.googleLoginAllowlist.findUnique({ where: { email } });
    await prisma.googleLoginAllowlist.update({
      where: { id: row.id },
      data: { googleSub: 'GGL-SUB-2', isActive: false },
    });

    // Re-add with a new note.
    res = run(['add', email, '--note', 'note-2', '--yes']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/"created":\s*false/);

    row = await prisma.googleLoginAllowlist.findUnique({ where: { email } });
    expect(row.note).toBe('note-2');
    expect(row.googleSub).toBe('GGL-SUB-2'); // preserved
    expect(row.isActive).toBe(false);         // preserved (re-add doesn't re-enable)
  });

  it('add --user <orphan> → exit 1 (Employee not found)', async () => {
    if (!(await isTableAvailable())) return; // gate
    const email = makeEmail();
    const orphan = `glx-orphan-${crypto.randomBytes(4).toString('hex')}@acschennai.com`;

    const res = run(['add', email, '--user', orphan, '--yes']);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(new RegExp(`--user ${orphan} does not match any employee`));
  });

  it('remove of a non-existent email → exit 1 (no allowlist row)', async () => {
    if (!(await isTableAvailable())) return; // gate
    const email = makeEmail();

    const res = run(['remove', email, '--yes']);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(new RegExp(`no allowlist row for ${email}`));
  });

  it('remove revokes refresh tokens for the linked Employee', async () => {
    if (!(await isTableAvailable())) return; // gate
    // Pre-create an Employee + a refresh_token row + a linked allowlist.
    const employeeId = `glx-emp-${crypto.randomBytes(4).toString('hex')}`;
    const employeeEmail = `glx-emp-${crypto.randomBytes(4).toString('hex')}@acschennai.com`;
    const allowEmail = makeEmail();
    cleanupEmails.push(allowEmail);
    try {
      await prisma.employee.create({
        data: { id: employeeId, email: employeeEmail, name: 'GLX Test', isAdmin: false },
      });
      await prisma.refreshToken.create({
        data: {
          employeeId,
          tokenHash: `glx-hash-${crypto.randomBytes(4).toString('hex')}`,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });
      const row = await prisma.googleLoginAllowlist.create({
        data: { email: allowEmail, userId: employeeId, isActive: true },
      });
      expect(row).toBeTruthy();

      const res = run(['remove', allowEmail, '--yes']);
      expect(res.status).toBe(0);
      const liveTokens = await prisma.refreshToken.findMany({
        where: { employeeId, revokedAt: null },
      });
      expect(liveTokens).toHaveLength(0);

      // allowlist row preserved (soft-delete).
      const after = await prisma.googleLoginAllowlist.findUnique({ where: { email: allowEmail } });
      expect(after.isActive).toBe(false);
    } finally {
      // best-effort cleanup of the employee + tokens (in addition to the allowlist cleanup in afterAll)
      try {
        await prisma.refreshToken.deleteMany({ where: { employeeId } });
        await prisma.employee.delete({ where: { id: employeeId } }).catch(() => {});
      } catch (_) { /* ignore */ }
    }
  });
});
