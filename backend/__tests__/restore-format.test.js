// SOL DR-008 — restore-database.sh format dispatch + checksum sidecar
// format regression coverage.
//
// Two contracts pinned here:
//
//   A. restore-database.sh dispatches on BACKUP_FILE suffix:
//        *.dump.gz  → gunzip -c <file> | pg_restore ...
//        *.dump     → pg_restore ... <file>
//        other      → exit 2 with an error on stderr
//      Pre-fix, the script unconditionally piped through `gunzip -c`,
//      so the off-site cron artifact (.dump) could never be restored.
//
//   B. cron-backup.yml's SHA256 sidecar matches sha256sum -c's expected
//      format ("<hash>  <filename>", two spaces, with trailing newline).
//      Pre-fix, only the bare hash was written, so every restore
//      verification (sha256sum -c) failed at the last step.
//
// We don't actually shell out to pg_dump / pg_restore here — that needs
// a live Postgres. Instead we read the script + workflow text and assert
// on the patterns that encode each contract. This is the lightest test
// that catches a regression of either defect.

const fs = require('fs');
const path = require('path');

const RESTORE_SCRIPT = fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'restore-database.sh'),
  'utf8',
);

const CRON_WORKFLOW = fs.readFileSync(
  path.join(__dirname, '..', '..', '.github', 'workflows', 'cron-backup.yml'),
  'utf8',
);

describe('SOL DR-008 — restore contract', () => {
  test('A1. restore script dispatches on .dump.gz suffix (pre-deploy backup)', () => {
    expect(RESTORE_SCRIPT).toMatch(/case\s+"\$BACKUP_FILE"\s+in/);
    expect(RESTORE_SCRIPT).toMatch(/\*\.dump\.gz\)/);
    expect(RESTORE_SCRIPT).toMatch(/gunzip\s+-c\s+"\$\{?BACKUP_FILE\}?"/);
    // The pre-fix path is gone — no UNCONDITIONAL gunzip before the case.
    // To make this assertion robust against the word "gunzip" appearing
    // in comments, strip comment lines before searching.
    const code = RESTORE_SCRIPT
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    const casePos = code.indexOf('case "$BACKUP_FILE" in');
    const gunzipPos = code.search(/gunzip\s+-c/);
    expect(casePos).toBeGreaterThan(-1);
    expect(gunzipPos).toBeGreaterThan(-1);
    expect(casePos).toBeLessThan(gunzipPos);
  });

  test('A2. restore script handles .dump suffix (cron off-site backup)', () => {
    expect(RESTORE_SCRIPT).toMatch(/\*\.dump\)/);
    // The .dump branch should pipe pg_restore directly into the file
    // (no gunzip), with the BACKUP_FILE as the LAST argument.
    const dumpBranch = RESTORE_SCRIPT.match(/\*\.dump\)\s*\n([\s\S]*?);;/);
    expect(dumpBranch).not.toBeNull();
    expect(dumpBranch[1]).toMatch(/pg_restore\s+/);
    expect(dumpBranch[1]).toMatch(/\$\{?BACKUP_FILE\}?/);
    expect(dumpBranch[1]).not.toMatch(/gunzip/);
  });

  test('A3. restore script rejects unknown extensions with a clear error', () => {
    expect(RESTORE_SCRIPT).toMatch(/\*\)/);
    expect(RESTORE_SCRIPT).toMatch(/ERROR:\s*BACKUP_FILE must end in/);
    expect(RESTORE_SCRIPT).toMatch(/exit\s+2/);
  });

  test('A4. restore script surfaces verification queries with mapped (physical) table names', () => {
    // Pre-fix, the script suggested querying "Employee" and "DPR" — both
    // logical Prisma model names. Raw SQL needs the @@map targets
    // (employees, dpr). The DR-008 fix updated both the script and
    // docs/BACKUPS.md to use the physical names.
    expect(RESTORE_SCRIPT).toMatch(/select count\(\*\) from employees;/);
    expect(RESTORE_SCRIPT).toMatch(/select count\(\*\) from dpr;/);
    // Negative assertions: the logical names should no longer appear
    // in the verification echo.
    expect(RESTORE_SCRIPT).not.toMatch(/from\s+"Employee"/);
    expect(RESTORE_SCRIPT).not.toMatch(/from\s+"DPR"/);
  });
});

describe('SOL DR-008 — checksum sidecar format', () => {
  test('B1. cron workflow writes sha256sum -c-compatible sidecar (hash + filename)', () => {
    // The DR-008 fix changed `sha256sum $DUMP_NAME | awk '{print $1}'`
    // to `sha256sum $DUMP_NAME > $SHA_NAME` so the sidecar carries
    // BOTH the hash and the filename. sha256sum -c requires this format.
    expect(CRON_WORKFLOW).toMatch(/sha256sum\s+"\$\{?DUMP_NAME\}?"\s*>\s*"\$\{?SHA_NAME\}?"/);
    // The pre-fix bare-hash pipe must be gone.
    expect(CRON_WORKFLOW).not.toMatch(/sha256sum\s+"\$\{?DUMP_NAME\}?"\s*\|\s*awk\s+'\{\s*print\s+\$1\s*\}'/);
  });

  test('B2. cron workflow job env exposes the required secrets to all steps', () => {
    // Pre-fix, DIRECT_DATABASE_URL etc. were only declared in the
    // "Run pg_dump" step's per-step env block, so the verify-required-
    // secrets guard saw an empty environment and silently passed. The
    // DR-008 fix moves them into job-level env.
    expect(CRON_WORKFLOW).toMatch(/env:\s*\n[\s\S]*?DIRECT_DATABASE_URL:\s*\$\{\{\s*secrets\.DIRECT_DATABASE_URL\s*\}\}/);
    expect(CRON_WORKFLOW).toMatch(/R2_ACCESS_KEY_ID:\s*\$\{\{\s*secrets\.R2_ACCESS_KEY_ID\s*\}\}/);
    expect(CRON_WORKFLOW).toMatch(/R2_SECRET_ACCESS_KEY:\s*\$\{\{\s*secrets\.R2_SECRET_ACCESS_KEY\s*\}\}/);
    expect(CRON_WORKFLOW).toMatch(/R2_ACCOUNT_ID:\s*\$\{\{\s*secrets\.R2_ACCOUNT_ID\s*\}\}/);
    expect(CRON_WORKFLOW).toMatch(/R2_BUCKET_DB_BACKUPS:\s*\$\{\{\s*secrets\.R2_BUCKET_DB_BACKUPS\s*\}\}/);
    // The verify-required-secrets guard must NOT have its own env block
    // (would be redundant + re-introduce the hazard).
    const verifyStep = CRON_WORKFLOW.match(
      /- name: Verify required secrets[\s\S]*?(?=\n      - name:|\njobs:)/,
    );
    expect(verifyStep).not.toBeNull();
    expect(verifyStep[0]).not.toMatch(/^\s+env:/m);
  });

  test('B3. weekly sweep deletes .sha256 sidecar (parity with daily sweep)', () => {
    // Pre-fix, the weekly sweep deleted the .dump file but left its
    // .sha256 sidecar in place. After 28 days the bucket listing
    // accumulated orphan checksums, breaking the restore runbook's
    // "find the sidecar" lookup. The DR-008 fix mirrors the daily-
    // sweep contract into the weekly branch.
    const weeklyBlock = CRON_WORKFLOW.match(
      /Sweep weekly\/[\s\S]*?(?=\n          # ---- 7\.|----\s*7\.)/,
    );
    expect(weeklyBlock).not.toBeNull();
    expect(weeklyBlock[0]).toMatch(/sha_key="\$\{key%\.dump\}\.sha256"/);
    expect(weeklyBlock[0]).toMatch(/s3 rm.*--no-progress.*2>\/dev\/null \|\| true/);
  });
});
