/**
 * DR-037 (Fresh24 audit, 2026-09-24) — completed idempotency response
 * retention has no owned lifecycle.
 *
 * The durable `request_dedupe` table's COMPLETED-body retention had
 * no janitor. DR-037 fixes that with two retention windows:
 *
 *   - IDEMPOTENCY_BODY_TTL_HOURS (default 72): live body retention.
 *     On expiry the cron compacts the row (result_body = NULL,
 *     body_compacted_at = now()) and PRESERVES the identity so a
 *     same-key retry still recognises the request as completed.
 *
 *   - IDEMPOTENCY_IDENTITY_TTL_HOURS (default 720 = 30d): identity
 *     retention. On expiry the cron hard-deletes the row so a retry
 *     falls through to the fresh path.
 *
 * These tests pin the public surface — defaults, env-override knobs,
 * and the side-effects of compactIdempotencyRecords() against an
 * in-memory Prisma shape that mirrors the real call sites.
 */

const fs = require('fs');
const path = require('path');

const idempotency = require(path.join(__dirname, '..', 'src', 'lib', 'idempotency.js'));
const {
  compactIdempotencyRecords,
  DEFAULT_IDEMPOTENCY_BODY_TTL_HOURS,
  DEFAULT_IDEMPOTENCY_IDENTITY_TTL_HOURS,
  getBodyTtlHours,
  getIdentityTtlHours,
} = idempotency;

// Minimal Prisma shape that mirrors the methods idempotency.js calls.
// Prisma's query operators (`{ not: null }`, `{ lt: Date }`) are
// evaluated explicitly so we can pin the contract from source without
// relying on Prisma's runtime semantics.
function matchesWhere(row, where) {
  if (!where) return true;
  if ('state' in where && row.state !== where.state) return false;
  if (where.resultBody && 'not' in where.resultBody) {
    if (where.resultBody.not === null && row.resultBody === null) return false;
    if (where.resultBody.not !== null && row.resultBody === where.resultBody.not) return false;
  }
  if (where.bodyCompactedAt && 'not' in where.bodyCompactedAt) {
    if (where.bodyCompactedAt.not === null && row.bodyCompactedAt === null) return false;
  }
  if (where.updatedAt && 'lt' in where.updatedAt) {
    if (!(row.updatedAt < where.updatedAt.lt)) return false;
  }
  return true;
}

function makePrismaMock(rows) {
  const findUnique = jest.fn(async ({ where }) => {
    if (where && where.key) {
      return rows.find((r) => r.key === where.key) || null;
    }
    return null;
  });
  const create = jest.fn(async ({ data }) => {
    // Simulate Prisma's unique-key constraint: P2002 if the key
    // already exists. reserve() catches that and reads the existing
    // row back to figure out whether to replay, conflict, or
    // mismatch.
    if (rows.some((r) => r.key === data.key)) {
      const err = new Error('Unique constraint failed');
      err.code = 'P2002';
      throw err;
    }
    const row = { ...data };
    rows.push(row);
    return row;
  });
  const update = jest.fn(async ({ where, data }) => {
    const row = rows.find((r) => r.key === where.key);
    if (!row) throw new Error('not found');
    Object.assign(row, data);
    return row;
  });
  const updateMany = jest.fn(async ({ where, data }) => {
    let count = 0;
    for (const row of rows) {
      if (matchesWhere(row, where)) {
        Object.assign(row, data);
        count += 1;
      }
    }
    return { count };
  });
  const deleteMany = jest.fn(async ({ where }) => {
    let count = 0;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i];
      if (matchesWhere(row, where)) {
        rows.splice(i, 1);
        count += 1;
      }
    }
    return { count };
  });
  return { requestDedupe: { findUnique, create, update, updateMany, deleteMany } };
}

describe('DR-037 — idempotency body-compaction lifecycle (source-text + helper-level contract)', () => {
  test('defaults are exposed and idempotency.js declares both TTL knobs', () => {
    expect(DEFAULT_IDEMPOTENCY_BODY_TTL_HOURS).toBe(72);
    expect(DEFAULT_IDEMPOTENCY_IDENTITY_TTL_HOURS).toBe(720);

    const libSrc = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'lib', 'idempotency.js'),
      'utf8',
    );
    expect(libSrc).toMatch(/IDEMPOTENCY_BODY_TTL_HOURS/);
    expect(libSrc).toMatch(/IDEMPOTENCY_IDENTITY_TTL_HOURS/);
    expect(libSrc).toMatch(/process\.env\.IDEMPOTENCY_BODY_TTL_HOURS/);
    expect(libSrc).toMatch(/process\.env\.IDEMPOTENCY_IDENTITY_TTL_HOURS/);
  });

  test('getBodyTtlHours + getIdentityTtlHours read process.env and fall back to defaults', () => {
    const savedBody = process.env.IDEMPOTENCY_BODY_TTL_HOURS;
    const savedIdentity = process.env.IDEMPOTENCY_IDENTITY_TTL_HOURS;
    try {
      delete process.env.IDEMPOTENCY_BODY_TTL_HOURS;
      delete process.env.IDEMPOTENCY_IDENTITY_TTL_HOURS;
      expect(getBodyTtlHours()).toBe(DEFAULT_IDEMPOTENCY_BODY_TTL_HOURS);
      expect(getIdentityTtlHours()).toBe(DEFAULT_IDEMPOTENCY_IDENTITY_TTL_HOURS);

      process.env.IDEMPOTENCY_BODY_TTL_HOURS = '12';
      process.env.IDEMPOTENCY_IDENTITY_TTL_HOURS = 'not-a-number';
      expect(getBodyTtlHours()).toBe(12);
      // Non-numeric env falls back to default — matches the audit's
      // "neither measured database exhaustion nor blindly tight retention".
      expect(getIdentityTtlHours()).toBe(DEFAULT_IDEMPOTENCY_IDENTITY_TTL_HOURS);
    } finally {
      if (savedBody === undefined) delete process.env.IDEMPOTENCY_BODY_TTL_HOURS;
      else process.env.IDEMPOTENCY_BODY_TTL_HOURS = savedBody;
      if (savedIdentity === undefined) delete process.env.IDEMPOTENCY_IDENTITY_TTL_HOURS;
      else process.env.IDEMPOTENCY_IDENTITY_TTL_HOURS = savedIdentity;
    }
  });

  test('compact pass touches body-aged rows that have not been compacted yet', async () => {
    // Fixed reference time so the test doesn't depend on wall clock.
    const NOW = new Date('2026-09-24T12:00:00Z').getTime();
    const HOUR = 60 * 60 * 1000;
    const DAY = 24 * HOUR;

    // 3 rows:
    //   A. body aged (5d > 72h body TTL), body NOT compacted → expect compaction
    //   B. body aged (35d > 30d identity TTL), body ALREADY compacted → expect delete
    //   C. body fresh (1h), body NOT compacted → expect no touch
    const rows = [
      {
        key: 'A',
        state: 'COMPLETED',
        resultStatus: 200,
        resultBody: { ok: true },
        bodyCompactedAt: null,
        updatedAt: new Date(NOW - 5 * DAY),
      },
      {
        key: 'B',
        state: 'COMPLETED',
        resultStatus: 200,
        resultBody: null,
        bodyCompactedAt: new Date(NOW - 35 * DAY),
        updatedAt: new Date(NOW - 35 * DAY),
      },
      {
        key: 'C',
        state: 'COMPLETED',
        resultStatus: 201,
        resultBody: { ok: true, fresh: true },
        bodyCompactedAt: null,
        updatedAt: new Date(NOW - 1 * HOUR),
      },
    ];
    const prisma = makePrismaMock(rows);

    const result = await compactIdempotencyRecords({
      prisma,
      bodyTtlHours: 72,
      identityTtlHours: 720,
      now: () => new Date(NOW),
    });

    expect(result.compactedCount).toBe(1);
    expect(result.deletedCount).toBe(1);
    expect(result.bodyTtlHours).toBe(72);
    expect(result.identityTtlHours).toBe(720);
    expect(typeof result.ranAt).toBe('string');

    // A: compacted
    const a = rows.find((r) => r.key === 'A');
    expect(a.resultBody).toBeNull();
    expect(a.bodyCompactedAt).not.toBeNull();

    // B: deleted (no row left in the collection)
    expect(rows.find((r) => r.key === 'B')).toBeUndefined();

    // C: untouched
    const c = rows.find((r) => r.key === 'C');
    expect(c.resultBody).toEqual({ ok: true, fresh: true });
    expect(c.bodyCompactedAt).toBeNull();
  });

  test('a body-compacted replay marks the contract flag in idempotency.js source', () => {
    // The end-to-end reserve()-with-P2002-and-then-readback path is
    // exercised by the broader integration suites against the real
    // Prisma client. Pinning the source-text contract here is the
    // durable check: the COMPACTED branch MUST return `replay: true,
    // compacted: true, cached.body.__idempotent_replay__: 'tombstone'`
    // so any future refactor that drops the flag is caught.
    const libSrc = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'lib', 'idempotency.js'),
      'utf8',
    );
    // Locate the if-branch that handles `existing.resultBody == null`
    // and ensure the contract shape is on the immediate `return`.
    const branch = libSrc.match(/if\s*\(existing\.resultBody\s*==\s*null\)\s*\{([\s\S]*?)\n\s*\}/);
    expect(branch).not.toBeNull();
    expect(branch[1]).toMatch(/replay:\s*true/);
    expect(branch[1]).toMatch(/compacted:\s*true/);
    expect(branch[1]).toMatch(/__idempotent_replay__:\s*'tombstone'/);
    expect(branch[1]).toMatch(/status:\s*existing\.resultStatus/);
  });
});

// DR-037 source-text pins: the body-compaction column + lifecycle
// MUST be present in idempotency.js + schema.prisma + the migration.
describe('DR-037 — source-text pins', () => {
  const libSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'lib', 'idempotency.js'),
    'utf8',
  );
  const schemaSrc = fs.readFileSync(
    path.join(__dirname, '..', 'prisma', 'schema.prisma'),
    'utf8',
  );
  const migrationDir = path.join(
    __dirname,
    '..',
    'prisma',
    'migrations',
    '20260924150000_dr037_idempotency_body_compaction',
  );
  const migrationExists = fs.existsSync(path.join(migrationDir, 'migration.sql'));

  test('idempotency.js defines compactIdempotencyRecords and exports it', () => {
    expect(libSrc).toMatch(/async function compactIdempotencyRecords/);
    expect(libSrc).toMatch(/compactIdempotencyRecords,/);
  });

  test('idempotency.js exports the two TTL knobs + their getters', () => {
    expect(libSrc).toMatch(/DEFAULT_IDEMPOTENCY_BODY_TTL_HOURS,/);
    expect(libSrc).toMatch(/DEFAULT_IDEMPOTENCY_IDENTITY_TTL_HOURS,/);
    expect(libSrc).toMatch(/getBodyTtlHours,/);
    expect(libSrc).toMatch(/getIdentityTtlHours,/);
  });

  test('idempotency.js reset path on complete() sets bodyCompactedAt to null', () => {
    // A fresh complete() after a previous compact should re-mark the
    // row as live (body_compacted_at = null). Pin the field.
    expect(libSrc).toMatch(/bodyCompactedAt:\s*null/);
  });

  test('idempotency.js reserve() emits the tombstone sentinel when body is null', () => {
    expect(libSrc).toMatch(/compacted:\s*true/);
    expect(libSrc).toMatch(/__idempotent_replay__:\s*'tombstone'/);
  });

  test('schema.prisma declares bodyCompactedAt on RequestDedupe', () => {
    expect(schemaSrc).toMatch(/bodyCompactedAt\s+DateTime\?\s+@map\("body_compacted_at"\)/);
  });

  test('migration file adds body_compacted_at column + state index', () => {
    expect(migrationExists).toBe(true);
    const migrationSql = fs.readFileSync(path.join(migrationDir, 'migration.sql'), 'utf8');
    expect(migrationSql).toMatch(/ADD COLUMN IF NOT EXISTS "body_compacted_at"/);
    expect(migrationSql).toMatch(/CREATE INDEX IF NOT EXISTS "request_dedupe_state_compacted_idx"/);
  });
});
