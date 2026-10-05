#!/usr/bin/env node
/**
 * [Payslips Stage 1 / commit 8] Mis-delivered payslip purge script.
 *
 * Misdelivery = a payslip was published to the wrong employee, or to
 * the right employee but for the wrong period, or any other case
 * where the PDF bytes must be retired from R2 without delay. The
 * audit trail must survive the byte retirement — that's why this
 * script tombstone-stamps the row instead of hard-deleting it.
 *
 * Operator procedure (runbook: docs/runbooks/PAYSLIP_MISDELIVERY.md):
 *
 *   1. Identify the offending payslip row (`SELECT id, employee_id,
 *      year, month, blob_container, blob_path FROM payslip WHERE id =
 *      '<payslip-id>';`).
 *   2. Confirm with the affected employee + HR. Misdelivery is a
 *      payroll incident — never retire bytes without sign-off.
 *   3. Run DRY RUN first:
 *        node scripts/purge-misdelivered-payslip.js \
 *          --payslip-id <uuid> --reason 'wrong-recipient: typed name mismatch' \
 *          --operator-id <admin-uuid>
 *      Inspect the plan. The script will print exactly what would
 *      change and what would be deleted.
 *   4. Re-run with `--apply` to actually revoke + tombstone + delete
 *      the blob. The script refuses to run if --apply is omitted and
 *      refuses to revoke without a --reason.
 *
 * The script does TWO things in order:
 *   a. Revoke the row (sets deletedAt + revokedAt + revokedById +
 *      revokedReason, audited through the same path as the admin UI's
 *      Revoke button). This is the "revoke first" rule — the
 *      misdelivery MUST be recorded in the standard revoke audit
 *      trail so it shows up in the admin coverage view as "Revoked".
 *   b. Tombstone + delete blob (sets purgedAt + purgedById +
 *      purgedReason, then DELETE the R2 object). After this, the
 *      four-guard predicate excludes the row from every portal read
 *      and the partial unique index `payslip_active_per_month_uidx`
 *      frees up the (employee, year, month) tuple so a corrected
 *      re-upload can be bound.
 *
 * Exit codes:
 *   0  — success (dry-run or applied)
 *   1  — fatal error (DB unreachable, blob delete failed twice, etc.)
 *   2  — bad CLI args / missing required flag
 *   3  — refused by safety guard (row not found, not yet revoked,
 *        blob container out of scope, etc.)
 */
'use strict';

const { PrismaClient } = require('@prisma/client');
const {
  revokePayslip,
  purgePayslipBlob,
  PAYSLIP_BLOB_BUCKET,
  sanitizeAuditReason,
} = require('../src/lib/payslip');

const REQUIRED_FLAGS = ['--payslip-id', '--reason', '--operator-id'];

function parseArgs(argv) {
  const args = {
    payslipId: null,
    reason: null,
    operatorId: null,
    apply: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--payslip-id') {
      args.payslipId = argv[++i];
    } else if (tok === '--reason') {
      args.reason = argv[++i];
    } else if (tok === '--operator-id') {
      args.operatorId = argv[++i];
    } else if (tok === '--apply') {
      args.apply = true;
    } else if (tok === '--dry-run') {
      args.apply = false;
    } else if (tok === '--help' || tok === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${tok}`);
    }
  }
  return args;
}

function help() {
  return [
    'Usage: node scripts/purge-misdelivered-payslip.js [options]',
    '',
    'Retire the R2 blob for a misdelivered payslip and tombstone the row.',
    'Revoke first, then purge. Dry-run is the default — pass --apply to commit.',
    '',
    'Required:',
    '  --payslip-id <uuid>      The payslip row to retire.',
    '  --reason <text>          Audited reason (PII-sanitised — salary/uan/pan/tax',
    '                           substrings are rejected, not silently truncated).',
    '  --operator-id <uuid>     The admin acting. Stamped on the tombstone.',
    '',
    'Options:',
    '  --apply                  Commit the changes. Without this, runs as dry-run.',
    '  --dry-run                Explicit dry-run (default if --apply is absent).',
    '  --help, -h               Print this message.',
    '',
    'Exit codes:',
    '  0  success',
    '  1  fatal error (DB / R2 unreachable, blob delete failed)',
    '  2  bad CLI args / missing required flag',
    '  3  refused by safety guard (row not found, blob container out of scope,',
    '     PII in reason, etc.)',
    '',
  ].join('\n');
}

function missingFlags(args) {
  const missing = [];
  if (!args.payslipId) missing.push('--payslip-id');
  if (!args.reason) missing.push('--reason');
  if (!args.operatorId) missing.push('--operator-id');
  return missing;
}

function printPlan(row, args) {
  // We never log salary, filename, blob path, employee name or id to
  // stdout — the audit (purge row in `payslip`) carries those. The script
  // log line names only the payslip row id, the bucket, and the
  // planned action.
  const lines = [];
  lines.push('[purge] plan (DRY RUN, nothing will be committed without --apply):');
  lines.push(`[purge]   payslip_id: ${row.id}`);
  lines.push(`[purge]   bucket    : ${row.blobContainer || '-'}`);
  lines.push(`[purge]   blob_key  : ${row.blobContainer ? '<recorded blob_path>' : '-'}`);
  lines.push(`[purge]   state     : deletedAt=${row.deletedAt ? 'set' : 'NULL'} purgedAt=${row.purgedAt ? 'set' : 'NULL'}`);
  lines.push(`[purge]   step 1    : revokePayslip (sets deletedAt, revokedAt, revokedById, revokedReason)`);
  lines.push(`[purge]   step 2    : purgePayslipBlob (sets purgedAt, purgedById, purgedReason; deletes R2 object)`);
  lines.push(`[purge]   operator  : ${args.operatorId}`);
  lines.push(`[purge]   reason    : <sanitised reason, length=${(args.reason || '').length}>`);
  return lines.join('\n');
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`error: ${e.message}`);
    console.error(help());
    process.exit(2);
  }
  if (args.help) {
    process.stdout.write(help());
    process.exit(0);
  }

  const missing = missingFlags(args);
  if (missing.length > 0) {
    console.error(`error: missing required flag(s): ${missing.join(', ')}`);
    console.error(help());
    process.exit(2);
  }

  // PII guard runs before any DB query — the operator's reason is
  // sanitised through the same helper the admin UI uses on Revoke.
  // A refused reason exits with code 3 (safety guard) and prints the
  // banned keyword so the operator can rewrite.
  let sanitisedReason;
  try {
    sanitisedReason = sanitizeAuditReason(args.reason);
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(3);
  }

  const prisma = new PrismaClient();
  try {
    const row = await prisma.payslip.findUnique({
      where: { id: args.payslipId },
      select: {
        id: true,
        employeeId: true,
        year: true,
        month: true,
        blobContainer: true,
        blobPath: true,
        deletedAt: true,
        purgedAt: true,
      },
    });
    if (!row) {
      console.error(`error: payslip row not found: ${args.payslipId}`);
      await prisma.$disconnect().catch(() => {});
      process.exit(3);
    }

    // Pre-flight safety checks (run in BOTH dry-run and apply modes so
    // the operator sees the same refusal message either way).
    if (row.purgedAt) {
      console.error(`error: payslip ${row.id} is already purged (purgedAt set). No-op.`);
      await prisma.$disconnect().catch(() => {});
      process.exit(0);
    }
    if (!row.blobContainer || row.blobContainer !== PAYSLIP_BLOB_BUCKET) {
      console.error(
        `error: payslip ${row.id} blob container is ${row.blobContainer || 'unset'} ` +
        `(expected ${PAYSLIP_BLOB_BUCKET}). Out of scope for this script.`,
      );
      await prisma.$disconnect().catch(() => {});
      process.exit(3);
    }
    if (!row.blobPath) {
      console.error(`error: payslip ${row.id} has no recorded blobPath; nothing to delete.`);
      await prisma.$disconnect().catch(() => {});
      process.exit(3);
    }

    console.log(printPlan(row, args));

    if (!args.apply) {
      console.log('[purge] DRY RUN complete. Re-run with --apply to commit.');
      await prisma.$disconnect().catch(() => {});
      process.exit(0);
    }

    // Step 1: revoke first (only if not already revoked). The Revoke
    // UI does NOT do this; the script does because the misdelivery
    // audit must precede the byte retirement — once the R2 object is
    // gone, the row's "did anyone see this PDF" history must already
    // be stamped.
    if (!row.deletedAt) {
      await revokePayslip(prisma, {
        payslipId: row.id,
        revokedById: args.operatorId,
        reason: sanitisedReason,
      });
      console.log('[purge] step 1 complete: payslip revoked.');
    } else {
      console.log('[purge] step 1 skipped: payslip already revoked (deletedAt set).');
    }

    // Step 2: tombstone + blob delete.
    const result = await purgePayslipBlob(prisma, {
      payslipId: row.id,
      purgedById: args.operatorId,
      reason: sanitisedReason,
    });
    if (result.ok && result.alreadyPurged) {
      console.log('[purge] step 2 no-op: row already tombstoned.');
    } else if (result.ok) {
      console.log(`[purge] step 2 complete: tombstoned; blobDeleted=${result.blobDeleted}.`);
    } else {
      console.error(`[purge] step 2 failed: ${result.error || 'unknown'}`);
      await prisma.$disconnect().catch(() => {});
      process.exit(1);
    }

    console.log('[purge] DONE.');
    await prisma.$disconnect().catch(() => {});
    process.exit(0);
  } catch (err) {
    console.error(`[purge] fatal: ${err && (err.stack || err.message || err)}`);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[purge] uncaught:', err && (err.stack || err.message || err));
    process.exit(1);
  });
}

module.exports = { parseArgs, missingFlags, printPlan };