#!/usr/bin/env node
// scripts/google-allowlist.js
//
// [feat/google-login-allowlist] Operator CLI for the Google sign-in
// allowlist. Every command routes through a host-guard that refuses to
// mutate a non-localhost database without an explicit confirmation —
// the goal is to make "I ran the wrong script against prod" require
// operator intent at the keyboard, not just a wrong invocation.
//
// Subcommands:
//
//   add <email> [--note "..."] [--user <employee>] [--override] [--reset-sub] [--yes]
//     Add (or update) an allowlist row for <email>. Lowercases the
//     address before the lookup so 'Test.User@Gmail.com' and
//     'test.user@gmail.com' map to the same row. Rejects
//     @acschennai.com addresses — those must use Zoho, not Google.
//
//   remove <email> [--yes]
//     Soft-disable the allowlist row (isActive=false). Does NOT delete
//     the row and does NOT clear googleSub — so an `enable` (no
//     --reset-sub) reconnects the same physical Google account
//     seamlessly. Also revokes every live refresh token for the
//     linked Employee so the user cannot extend the session past the
//     in-flight access token's TTL (matches the logout semantics).
//
//   enable <email> [--reset-sub] [--yes]
//     Reactivate a soft-disabled row. Does NOT touch googleSub by
//     default. With --reset-sub, clears googleSub so the next Google
//     login re-binds to whatever sub the current Google session has.
//
//   list
//     Print every allowlist row. Read-only; never guarded.
//
// Host-guard (amendment-final-1):
//   - The DATABASE_URL host determines "where will this write?".
//   - localhost / 127.0.0.1 / ::1 → trusted without confirmation.
//   - Anything else → require ONE of:
//       (a) --yes on the command line, OR
//       (b) an interactive prompt typed into a TTY. The operator
//           must type the host string verbatim.
//     If neither is available (no --yes and no TTY), the script
//     exits non-zero with a clear message — never silently proceeds.
//   - `add --user <admin>` requires --yes even on localhost: an admin
//     allowlist row is a security-sensitive write (a wrong link lets a
//     Gmail user inherit admin permissions on the linked Employee).
//
// All writes go through Prisma transactions where multi-row changes
// would be unsafe to interleave. readline is used for the interactive
// prompt; on a non-TTY stdin the script falls back to a clear
// "refusing to run" error.

'use strict';

const { PrismaClient } = require('@prisma/client');
const readline = require('readline');
const { revokeAllRefreshTokensForEmployee } = require('../src/lib/revocation');

// Both `::1` and the bracketed form `[::1]` — the WHATWG URL parser
// returns the bracketed form for IPv6 literals in postgres URLs.
const LOCALHOST_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

// Permissive but strict-enough shape for "looks like an email". Not
// RFC-5322 — the allowlist is a small operator-curated set, not user
// input. The server lowercases the incoming Google id_token email and
// hits the same CHECK (email = lower(email)) constraint.
const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const ACS_DOMAIN = 'acschennai.com';

const USAGE = `Usage:
  node scripts/google-allowlist.js add <email> [--note "..."] [--user <employee>] [--override] [--reset-sub] [--yes]
  node scripts/google-allowlist.js remove <email> [--yes]
  node scripts/google-allowlist.js enable <email> [--reset-sub] [--yes]
  node scripts/google-allowlist.js list

Flags:
  --user <employee>    Pre-link the row to an existing Employee
                       (email or UUID). Without this flag the first
                       Google login creates / reuses an Employee by
                       matching the verified email.
  --override           Force the pre-link even if the target
                       Employee is already allowlisted under a
                       different row. Unlinks the previous row.
  --reset-sub          Clear googleSub. add: if re-adding and the
                       row already had a sub. enable: clear the sub
                       so the next Google login re-binds.
  --note "<text>"      Free-form operator note (added-by, ticket
                       number, etc.). Idempotent on re-add.
  --yes                Skip the non-localhost confirmation prompt
                       and the admin-link confirmation. Required for
                       any non-localhost host and for --user on an
                       admin Employee.
`;

// ─────────────────────────────────────────────────────────────────────────────
// Argument parsing
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  // argv[0] is node, argv[1] is the script path. Positional args come
  // first, then optional flags. A flag's value is the next argv
  // token, or `true` for boolean flags.
  const positional = [];
  const flags = {};
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--yes') {
      flags.yes = true;
    } else if (a === '--override') {
      flags.override = true;
    } else if (a === '--reset-sub') {
      flags.resetSub = true;
    } else if (a === '--note' || a === '--user') {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new Error(`${a} requires a value`);
      }
      flags[a.slice(2)] = v;
      i += 1;
    } else if (a.startsWith('--')) {
      throw new Error(`unknown flag: ${a}`);
    } else {
      positional.push(a);
    }
  }
  return { command: positional[0], positional: positional.slice(1), flags };
}

// ─────────────────────────────────────────────────────────────────────────────
// Host guard
// ─────────────────────────────────────────────────────────────────────────────

function parseDatabaseHost() {
  const url = process.env.DATABASE_URL || process.env.DIRECT_DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL (or DIRECT_DATABASE_URL) is not set');
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
    throw new Error(`DATABASE_URL is not a parseable URL: ${err.message}`);
  }
  return {
    host: parsed.hostname,
    redacted: `${parsed.protocol}//***@${parsed.hostname}:${parsed.port || ''}/${parsed.pathname.replace(/^\//, '')}`,
  };
}

function isLocalhostHost(host) {
  return LOCALHOST_HOSTS.has(host);
}

async function confirmOrAbort({ host, redacted, flags, action }) {
  if (isLocalhostHost(host)) return;
  if (flags.yes) return;
  if (!process.stdin.isTTY) {
    console.error('');
    console.error(`[google-allowlist] REFUSING to run ${action} against non-localhost host.`);
    console.error(`[google-allowlist] Target: ${redacted}`);
    console.error('[google-allowlist] Pass --yes on the command line, or run interactively from a TTY.');
    process.exit(2);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise((resolve) => {
    rl.question(`[google-allowlist] About to ${action} on ${redacted}.\n[google-allowlist] Type the target host ("${host}") to confirm: `, resolve);
  });
  rl.close();
  if (answer.trim() !== host) {
    console.error(`[google-allowlist] Confirmation did not match. Aborting.`);
    process.exit(2);
  }
  console.error(`[google-allowlist] Confirmed against ${host}.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

function normalizeEmail(raw) {
  if (typeof raw !== 'string') {
    throw new Error('email is required');
  }
  const trimmed = raw.trim().toLowerCase();
  if (!EMAIL_RE.test(trimmed)) {
    throw new Error(`not a valid email address: ${raw}`);
  }
  return trimmed;
}

function isAcsDomainEmail(email) {
  const domain = email.split('@')[1] || '';
  return domain.toLowerCase() === ACS_DOMAIN;
}

// Resolve --user to an Employee. Accepts either an email (case-
// insensitive) or the textual id (UUID-shaped or otherwise —
// findFirst by id with `String` works for our text PK).
async function resolveEmployeeByArg(prisma, userArg) {
  if (!userArg) return null;
  if (userArg.includes('@')) {
    return prisma.employee.findUnique({ where: { email: userArg.toLowerCase() } });
  }
  return prisma.employee.findUnique({ where: { id: userArg } });
}

async function confirmAdminLink({ employee, flags, redacted, host }) {
  // amendment-final-6: --user on an admin Employee requires --yes even
  // on localhost. The risk is real — a wrong link lets a Gmail user
  // inherit admin permissions on the linked Employee.
  if (!employee || !employee.isAdmin) return;
  if (flags.yes) return;
  if (isLocalhostHost(host)) {
    if (process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      const answer = await new Promise((resolve) => {
        rl.question(
          `[google-allowlist] WARNING: --user ${employee.email} (id ${employee.id}) is an admin Employee.\n` +
          `[google-allowlist] Linking will let this Gmail address sign in AS AN ADMIN. Confirm? (type "yes"): `,
          resolve,
        );
      });
      rl.close();
      if (answer.trim().toLowerCase() !== 'yes') {
        throw new Error('admin link confirmation declined');
      }
      return;
    }
    console.error('');
    console.error(`[google-allowlist] REFUSING: --user ${employee.email} is an admin Employee.`);
    console.error('[google-allowlist] Pass --yes to confirm, or run interactively from a TTY.');
    process.exit(2);
  }
  // Non-localhost host: the host-guard already gates this; nothing
  // extra to do.
}

// ─────────────────────────────────────────────────────────────────────────────
// Subcommand: add
// ─────────────────────────────────────────────────────────────────────────────

async function cmdAdd(prisma, { positional, flags, host, redacted }) {
  if (positional.length !== 1) {
    throw new Error('add requires exactly one positional argument: <email>');
  }
  const email = normalizeEmail(positional[0]);
  if (isAcsDomainEmail(email)) {
    throw new Error(`${ACS_DOMAIN} addresses must use Zoho sign-in, not Google`);
  }
  await confirmOrAbort({ host, redacted, flags, action: 'add an allowlist row' });

  let employee = null;
  if (flags.user) {
    employee = await resolveEmployeeByArg(prisma, flags.user);
    if (!employee) {
      throw new Error(`--user ${flags.user} does not match any employee`);
    }
    await confirmAdminLink({ employee, flags, redacted, host });
  }

  // Re-running `add` for an existing email is idempotent: the existing
  // row's googleSub, isActive, and lastLoginAt are NOT touched unless
  // the caller asked for it via --reset-sub. The note and userId ARE
  // updated so the operator can re-issue `add` to fix a wrong --user
  // link or refresh the note.
  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.googleLoginAllowlist.findUnique({ where: { email } });

    if (existing && employee) {
      // If the target Employee is already linked to a DIFFERENT
      // allowlist row, refuse without --override so the operator
      // doesn't accidentally clobber a different Gmail user's link.
      if (existing.userId !== employee.id) {
        const otherRow = await tx.googleLoginAllowlist.findFirst({
          where: { userId: employee.id, NOT: { id: existing.id } },
        });
        if (otherRow && !flags.override) {
          throw new Error(
            `Employee ${employee.email} is already linked to a different allowlist row ` +
            `(${otherRow.email}). Re-run with --override to unlink the previous row.`,
          );
        }
        if (otherRow && flags.override) {
          await tx.googleLoginAllowlist.update({
            where: { id: otherRow.id },
            data: { userId: null },
          });
        }
      }
    }

    const data = {
      email,
      userId: employee ? employee.id : undefined,
      ...(flags.note !== undefined ? { note: flags.note } : {}),
    };
    if (flags.resetSub) data.googleSub = null;
    if (!existing) data.isActive = true; // first-time add defaults active; re-adds leave isActive alone

    const row = existing
      ? await tx.googleLoginAllowlist.update({ where: { id: existing.id }, data })
      : await tx.googleLoginAllowlist.create({ data: { email, ...data } });

    return { row, created: !existing };
  });

  console.log(JSON.stringify({
    ok: true,
    created: result.created,
    email: result.row.email,
    userId: result.row.userId,
    isActive: result.row.isActive,
    googleSub: result.row.googleSub ? `${result.row.googleSub.slice(0, 8)}…` : null,
    note: result.row.note,
  }, null, 2));
}

// ─────────────────────────────────────────────────────────────────────────────
// Subcommand: remove
// ─────────────────────────────────────────────────────────────────────────────

async function cmdRemove(prisma, { positional, flags, host, redacted }) {
  if (positional.length !== 1) {
    throw new Error('remove requires exactly one positional argument: <email>');
  }
  const email = normalizeEmail(positional[0]);
  await confirmOrAbort({ host, redacted, flags, action: 'remove an allowlist row' });

  // Soft-disable: isActive=false, googleSub preserved, then revoke
  // refresh tokens. Done in a single transaction so a partial
  // failure doesn't leave an active row with a dead session (or
  // vice versa).
  const result = await prisma.$transaction(async (tx) => {
    const row = await tx.googleLoginAllowlist.findUnique({ where: { email } });
    if (!row) {
      throw new Error(`no allowlist row for ${email}`);
    }
    const updated = await tx.googleLoginAllowlist.update({
      where: { id: row.id },
      data: { isActive: false },
    });
    return { row: updated, employeeId: row.userId };
  });

  let revokedCount = 0;
  if (result.employeeId) {
    revokedCount = await revokeAllRefreshTokensForEmployee(prisma, result.employeeId, {
      reason: 'google_allowlist_removed',
    });
  }

  console.log(JSON.stringify({
    ok: true,
    email: result.row.email,
    isActive: result.row.isActive,
    googleSub: result.row.googleSub ? `${result.row.googleSub.slice(0, 8)}…` : null,
    employeeId: result.employeeId,
    refreshTokensRevoked: revokedCount,
  }, null, 2));
}

// ─────────────────────────────────────────────────────────────────────────────
// Subcommand: enable
// ─────────────────────────────────────────────────────────────────────────────

async function cmdEnable(prisma, { positional, flags, host, redacted }) {
  if (positional.length !== 1) {
    throw new Error('enable requires exactly one positional argument: <email>');
  }
  const email = normalizeEmail(positional[0]);
  await confirmOrAbort({ host, redacted, flags, action: 'enable an allowlist row' });

  const row = await prisma.googleLoginAllowlist.findUnique({ where: { email } });
  if (!row) {
    throw new Error(`no allowlist row for ${email}`);
  }
  const data = { isActive: true };
  if (flags.resetSub) data.googleSub = null;
  const updated = await prisma.googleLoginAllowlist.update({ where: { id: row.id }, data });
  console.log(JSON.stringify({
    ok: true,
    email: updated.email,
    isActive: updated.isActive,
    googleSub: updated.googleSub ? `${updated.googleSub.slice(0, 8)}…` : null,
    resetSub: !!flags.resetSub,
  }, null, 2));
}

// ─────────────────────────────────────────────────────────────────────────────
// Subcommand: list
// ─────────────────────────────────────────────────────────────────────────────

async function cmdList(prisma) {
  // Read-only: no host-guard. (An operator listing rows is reading
  // from a database they already have a connection string to — the
  // threat model is "don't let me accidentally write", not "don't
  // let me look".)
  const rows = await prisma.googleLoginAllowlist.findMany({
    orderBy: [{ email: 'asc' }],
  });
  if (rows.length === 0) {
    console.log('(no allowlist rows)');
    return;
  }
  for (const r of rows) {
    let linkedUser = null;
    if (r.userId) {
      linkedUser = await prisma.employee.findUnique({
        where: { id: r.userId },
        select: { email: true, name: true, isAdmin: true },
      });
    }
    console.log(JSON.stringify({
      email: r.email,
      isActive: r.isActive,
      linkedUserEmail: linkedUser ? linkedUser.email : null,
      linkedUserId: r.userId,
      isAdmin: linkedUser ? !!linkedUser.isAdmin : null,
      googleSub: r.googleSub ? `${r.googleSub.slice(0, 8)}…` : null,
      lastLoginAt: r.lastLoginAt ? r.lastLoginAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
      note: r.note,
    }));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv);
  } catch (err) {
    console.error('[google-allowlist] argument error:', err.message);
    console.error(USAGE);
    process.exit(2);
    return;
  }
  const { command, positional, flags } = parsed;
  if (!command) {
    console.error(USAGE);
    // No command → usage error. (The previous expression
    // `command === undefined ? 0 : 2` exited 0 when no positional
    // args were passed, which silently swallowed the "no command"
    // case and made `node scripts/google-allowlist.js` succeed with
    // just a usage print. Always exit 2 here.)
    process.exit(2);
    return;
  }
  if (command === 'list') {
    // No host guard — see cmdList for rationale.
  } else if (['add', 'remove', 'enable'].includes(command)) {
    // host guard runs lazily inside the cmd to keep the prompt text
    // specific to the action. Validate DATABASE_URL is parseable
    // before opening a Prisma client, so the operator gets a clean
    // error if their env is misconfigured.
    const { host, redacted } = parseDatabaseHost();
    const prisma = new PrismaClient();
    try {
      if (command === 'add') await cmdAdd(prisma, { positional, flags, host, redacted });
      else if (command === 'remove') await cmdRemove(prisma, { positional, flags, host, redacted });
      else if (command === 'enable') await cmdEnable(prisma, { positional, flags, host, redacted });
    } finally {
      await prisma.$disconnect();
    }
    return;
  } else {
    console.error(`[google-allowlist] unknown command: ${command}`);
    console.error(USAGE);
    process.exit(2);
    return;
  }

  // `list` is the only path that reaches here.
  const prisma = new PrismaClient();
  try {
    await cmdList(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[google-allowlist] error:', err && err.message ? err.message : err);
  if (err && err.stack) console.error(err.stack);
  process.exit(1);
});
