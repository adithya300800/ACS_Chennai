/**
 * DR-009 — the checked-in migration history must be able to rebuild a clean
 * database.
 *
 * Audit row: "Code review by SOL/ACS-Portal-Live-Readiness-Review-2026-09-05.md"
 *   line 62  — DR-009 | P1 | "Migration history cannot rebuild a clean
 *              database and disagrees with mapped schema"
 *   line 212 — "DR-009 — Schema and migration history are not a reproducible
 *              whole"
 *
 * The fix is a single baseline migration
 * (20260101000000_init_baseline/migration.sql) that creates every table, enum,
 * index and FK the schema declares, using existence guards so re-running it on
 * the live database is a strict no-op.
 *
 * This suite is a STATIC contract test: it reads the .sql file as text and
 * pins the properties that make it safe (idempotent) and complete (every
 * table / enum present, correct FK target table, correct id column type).
 * It does not connect to a database — there is no live DB in CI, and the
 * point of the check is that the FILE is right before anyone replays it.
 *
 * Lesson carried forward from the Phase-4 P0 (`training_enrollments` vs
 * `training_enrollment`): when a migration is force-adopted with
 * `prisma migrate resolve --applied`, no SQL ever runs, so a typo can sit
 * undetected forever. A text-level contract test is the cheapest thing that
 * would have caught it.
 */

const fs = require('fs');
const path = require('path');

const MIGRATION_PATH = path.join(
  __dirname,
  '..',
  'prisma',
  'migrations',
  '20260101000000_init_baseline',
  'migration.sql'
);

/** Every table in schema.prisma, keyed by the model's `@@map` value. */
const REQUIRED_TABLES = [
  'employees', // Employee
  'revoked_token', // RevokedToken
  'refresh_token', // RefreshToken
  'attendance', // Attendance
  'attendance_sessions', // AttendanceSession
  'dpr', // DPR
  'dpr_photo', // DPRPhoto
  'dpr_revision', // DPRRevision
  'inspection_record', // InspectionRecord
  'inspection_photo', // InspectionPhoto
  'notification', // Notification
  'leave_request', // LeaveRequest
  'training_course', // TrainingCourse
  'training_enrollment', // TrainingEnrollment
  'notification_preference', // NotificationPreference
  'email_log', // EmailLog
  'digest_item', // DigestItem
  'digest_run', // DigestRun
  'admin_digest_run', // AdminDigestRun
  'upload_intent', // UploadIntent
];

const REQUIRED_ENUMS = [
  'DPRStatus',
  'TrainingProvider',
  'TrainingEnrollmentStatus',
  'TrainingPriority',
];

let raw;
/** The file with every `-- ...` comment removed, so assertions see DDL only. */
let ddl;

beforeAll(() => {
  raw = fs.readFileSync(MIGRATION_PATH, 'utf8');
  ddl = raw
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
});

describe('DR-009 baseline migration — file exists and is documented', () => {
  test('the baseline migration file exists', () => {
    expect(fs.existsSync(MIGRATION_PATH)).toBe(true);
    expect(raw.length).toBeGreaterThan(0);
  });

  test('it sorts before every other migration (earliest timestamp)', () => {
    const migrationsDir = path.join(__dirname, '..', 'prisma', 'migrations');
    const dirs = fs
      .readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(dirs[0]).toBe('20260101000000_init_baseline');
  });

  test('the header explains the purpose, the guard strategy and DR-009', () => {
    expect(raw).toMatch(/DR-009/);
    expect(raw).toMatch(/ACS-Portal-Live-Readiness-Review-2026-09-05\.md/);
    expect(raw).toMatch(/IF NOT EXISTS STRATEGY/i);
    expect(raw).toMatch(/NO DATA MOVEMENT IS NEEDED/i);
  });

  test('it never mutates or drops data — no INSERT/UPDATE/DELETE/DROP/TRUNCATE', () => {
    // Matched as statements, not as substrings: `ON UPDATE CASCADE` is a
    // referential action, not a data mutation.
    const mutations = [
      /\bINSERT\s+INTO\b/i,
      /\bUPDATE\s+"?\w+"?\s+(?:\w+\s+)?SET\b/i,
      /\bDELETE\s+FROM\b/i,
      /\bDROP\s+(?:TABLE|TYPE|INDEX|COLUMN|CONSTRAINT|SCHEMA|DATABASE)\b/i,
      /\bTRUNCATE\b/i,
    ];
    for (const pattern of mutations) {
      expect(ddl).not.toMatch(pattern);
    }
  });
});

describe('DR-009 baseline migration — completeness (fresh database)', () => {
  test.each(REQUIRED_TABLES)('creates table %s', (table) => {
    const pattern = new RegExp(
      `CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+"${table}"\\s*\\(`,
      'i'
    );
    expect(ddl).toMatch(pattern);
  });

  test('creates exactly the 20 tables the schema declares — no more, no fewer', () => {
    const created = [...ddl.matchAll(/CREATE\s+TABLE[^"]*"([^"]+)"/gi)].map((m) => m[1]);
    expect(created.sort()).toEqual([...REQUIRED_TABLES].sort());
  });

  test.each(REQUIRED_ENUMS)('creates enum type %s', (enumName) => {
    const pattern = new RegExp(`CREATE\\s+TYPE\\s+"${enumName}"\\s+AS\\s+ENUM`, 'i');
    expect(ddl).toMatch(pattern);
  });

  test('enum columns reference their enum types', () => {
    // dpr.status, training_course.provider, training_enrollment.status/priority
    expect(ddl).toMatch(/"status"\s+"DPRStatus"\s+NOT NULL DEFAULT 'DRAFT'/);
    expect(ddl).toMatch(/"provider"\s+"TrainingProvider"\s+NOT NULL/);
    expect(ddl).toMatch(/"status"\s+"TrainingEnrollmentStatus"\s+NOT NULL DEFAULT 'ASSIGNED'/);
    expect(ddl).toMatch(/"priority"\s+"TrainingPriority"\s+NOT NULL DEFAULT 'NORMAL'/);
  });

  test('preserves the Prisma column types the schema pins with @db attributes', () => {
    // @db.Date
    expect(ddl).toMatch(/"reportDate"\s+DATE\s+NOT NULL/);
    expect(ddl).toMatch(/"startDate"\s+DATE\s+NOT NULL/);
    expect(ddl).toMatch(/"endDate"\s+DATE\s+NOT NULL/);
    expect(ddl).toMatch(/"due_date"\s+DATE\b/);
    // @db.Decimal(10, 7)
    for (const col of ['check_in_lat', 'check_in_lng', 'check_out_lat', 'check_out_lng']) {
      expect(ddl).toMatch(new RegExp(`"${col}"\\s+DECIMAL\\(10,7\\)`));
    }
    // @db.VarChar(N)
    expect(ddl).toMatch(/"title"\s+VARCHAR\(160\)\s+NOT NULL/);
    expect(ddl).toMatch(/"external_url"\s+VARCHAR\(2048\)\s+NOT NULL/);
    expect(ddl).toMatch(/"category"\s+VARCHAR\(60\)/);
    expect(ddl).toMatch(/"evidence_class"\s+VARCHAR\(40\)/);
    expect(ddl).toMatch(/"provider_session_id"\s+VARCHAR\(120\)/);
    expect(ddl).toMatch(/"employee_note"\s+VARCHAR\(500\)/);
    // Json -> JSONB, with the '{}' default only where the schema declares it
    expect(ddl).toMatch(/"type_mutes"\s+JSONB\s+NOT NULL DEFAULT '\{\}'::jsonb/);
    expect(ddl).toMatch(/"custom_sections"\s+JSONB/);
    expect(ddl).toMatch(/"snapshot"\s+JSONB\s+NOT NULL/);
    expect(ddl).toMatch(/"data"\s+JSONB\s+NOT NULL/);
  });

  test('keeps camelCase for the fields schema.prisma leaves un-@map-ed', () => {
    // A field without @map keeps its Prisma name as the SQL column name.
    expect(ddl).toMatch(/"projectName"\s+TEXT\s+NOT NULL/);
    expect(ddl).toMatch(/"workEntries"\s+JSONB/);
    expect(ddl).toMatch(/"workType"\s+TEXT\s+NOT NULL DEFAULT 'MATERIAL_RECEIPT'/);
    // LeaveRequest.startDate / .endDate are `DateTime @db.Date` with NO @map,
    // so they are camelCase even though their table's other columns are
    // snake_case. 20260902220220_dr009_leave_overlap_constraint gets this
    // wrong (it says "start_date"/"end_date"); the baseline must not.
    expect(ddl).not.toMatch(/"start_date"/);
    expect(ddl).not.toMatch(/"end_date"/);
    // ...while @map-ed fields are snake_case.
    expect(ddl).toMatch(/"materials_received_summary"\s+TEXT/);
    expect(ddl).toMatch(/"submitted_by_id"\s+TEXT\s+NOT NULL/);
  });

  test('carries the post-DR-010 / post-S3-6 training columns', () => {
    for (const col of [
      'evidence_class',
      'completed_by',
      'evidence_metadata',
      'provider_session_id',
      'overdue_notified_at',
    ]) {
      expect(ddl).toContain(`"${col}"`);
    }
  });

  test('never references the phantom plural "training_enrollments" table', () => {
    // The Phase-4 P0 typo. @@map is singular.
    expect(ddl).not.toMatch(/training_enrollments/);
  });
});

describe('DR-009 baseline migration — idempotency (safe on production)', () => {
  test('every CREATE TABLE is guarded with IF NOT EXISTS', () => {
    const creates = [...ddl.matchAll(/CREATE\s+TABLE\s+([\s\S]{0,24}?)"/gi)].map((m) => m[1]);
    expect(creates.length).toBe(REQUIRED_TABLES.length);
    for (const prefix of creates) {
      expect(prefix.replace(/\s+/g, ' ').trim().toUpperCase()).toBe('IF NOT EXISTS');
    }
  });

  test('every CREATE INDEX / CREATE UNIQUE INDEX is guarded with IF NOT EXISTS', () => {
    const indexStatements = [...ddl.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX[^"]*"/gi)].map(
      (m) => m[0]
    );
    expect(indexStatements.length).toBeGreaterThan(0);
    for (const statement of indexStatements) {
      expect(statement.toUpperCase()).toContain('IF NOT EXISTS');
    }
  });

  test('every CREATE TYPE is wrapped in a duplicate_object-trapping DO block', () => {
    // Postgres has no CREATE TYPE IF NOT EXISTS, so the guard is an
    // exception handler. One DO block per enum.
    const guardedBlocks = [
      ...raw.matchAll(
        /DO\s+\$\$\s*BEGIN\s*CREATE\s+TYPE\s+"([^"]+)"[\s\S]*?EXCEPTION\s+WHEN\s+duplicate_object\s+THEN\s+NULL;\s*END\s+\$\$;/gi
      ),
    ].map((m) => m[1]);

    expect(guardedBlocks.sort()).toEqual([...REQUIRED_ENUMS].sort());

    const allTypeCreates = [...ddl.matchAll(/CREATE\s+TYPE\s+"([^"]+)"/gi)].map((m) => m[1]);
    expect(allTypeCreates.sort()).toEqual([...REQUIRED_ENUMS].sort());
  });

  test('every ADD CONSTRAINT is preceded by an information_schema existence probe', () => {
    const addConstraints = [...ddl.matchAll(/ADD\s+CONSTRAINT\s+"([^"]+)"/gi)].map((m) => m[1]);
    // Only FK constraints are added via ALTER; PK constraints are inline in
    // the guarded CREATE TABLE bodies.
    expect(addConstraints.length).toBeGreaterThan(0);

    for (const name of addConstraints) {
      expect(name).toMatch(/_fkey$/);
      const probe = new RegExp(
        `information_schema\\.table_constraints[\\s\\S]{0,200}?constraint_name\\s*=\\s*'${name}'`,
        'i'
      );
      expect(ddl).toMatch(probe);
    }

    // Every probe/ALTER pair sits inside its own DO block.
    const doBlocks = [...ddl.matchAll(/DO\s+\$\$\s*BEGIN\s+IF\s+NOT\s+EXISTS/gi)];
    expect(doBlocks.length).toBe(addConstraints.length);
  });

  test('no unguarded bare DDL slipped in', () => {
    // A CREATE TABLE/INDEX without IF NOT EXISTS, or an ALTER TABLE ... ADD
    // COLUMN (which has no place in a baseline), would break a production
    // re-run. Assert the negative directly.
    expect(ddl).not.toMatch(/CREATE\s+TABLE\s+"/i);
    expect(ddl).not.toMatch(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+"/i);
    expect(ddl).not.toMatch(/ADD\s+COLUMN/i);
  });
});

describe('DR-009 baseline migration — correctness of FK targets and id types', () => {
  test('every Employee FK targets "employees" (plural), never "employee"', () => {
    // The adopted 20260903010000_r25_notifications file points at a singular
    // "employee" table that has never existed. The baseline must not repeat
    // that typo — and by creating those tables first it prevents the bad
    // statement from ever executing.
    const references = [...ddl.matchAll(/REFERENCES\s+"([^"]+)"/gi)].map((m) => m[1]);
    expect(references.length).toBeGreaterThan(0);
    expect(references).not.toContain('employee');
    expect(references).toContain('employees');

    // Every referenced table must be one this baseline actually creates.
    for (const target of references) {
      expect(REQUIRED_TABLES).toContain(target);
    }
  });

  test('FK constraint names follow Prisma\'s <table>_<column>_fkey convention', () => {
    const names = [...ddl.matchAll(/ADD\s+CONSTRAINT\s+"([^"]+)"/gi)].map((m) => m[1]);
    for (const name of names) {
      expect(name).toMatch(/^[a-z_]+_fkey$/);
    }
  });

  test('all Employee-owning columns pointing at employees.id are declared TEXT', () => {
    const fkColumns = [
      ...ddl.matchAll(
        /FOREIGN KEY \("([^"]+)"\) REFERENCES "employees"\("id"\)/gi
      ),
    ].map((m) => m[1]);
    expect(fkColumns.length).toBeGreaterThan(0);
    for (const col of fkColumns) {
      expect(ddl).toMatch(new RegExp(`"${col}"\\s+TEXT\\b`));
    }
  });

  test('id and employee_id columns are TEXT, never UUID', () => {
    // schema.prisma models every id as `String @default(uuid())`; Prisma maps
    // String -> TEXT. 20260903000000_lpr012_upload_intents declared UUID,
    // which is part of the DR-009 "disagrees with mapped schema" finding.
    expect(ddl).not.toMatch(/\bUUID\b(?!\s*\))/); // no UUID column type anywhere
    expect(ddl).not.toMatch(/"id"\s+UUID/i);
    expect(ddl).not.toMatch(/"employee_id"\s+UUID/i);

    const idDeclarations = [...ddl.matchAll(/"id"\s+(\w+)/g)].map((m) => m[1].toUpperCase());
    expect(idDeclarations.length).toBe(REQUIRED_TABLES.length - 2); // revoked_token PK is "jti"; notification_preference PK is "employee_id"
    for (const type of idDeclarations) {
      expect(type).toBe('TEXT');
    }

    const employeeIdDeclarations = [...ddl.matchAll(/"employee_id"\s+(\w+)\s/g)].map((m) =>
      m[1].toUpperCase()
    );
    expect(employeeIdDeclarations.length).toBeGreaterThan(0);
    for (const type of employeeIdDeclarations) {
      expect(type).toBe('TEXT');
    }
  });

  test('uuid-defaulted primary keys self-default via gen_random_uuid()::text', () => {
    const defaults = [...ddl.matchAll(/"id"\s+TEXT\s+NOT NULL DEFAULT \(gen_random_uuid\(\)\)::text/g)];
    expect(defaults.length).toBe(REQUIRED_TABLES.length - 2);
  });

  test('timestamps use TIMESTAMP(3) and default to CURRENT_TIMESTAMP', () => {
    expect(ddl).not.toMatch(/\bnow\(\)/i);
    // Column declarations are space-padded for alignment; compare normalized.
    const normalize = (s) => s.trim().replace(/\s+/g, ' ');
    const createdAt = [...ddl.matchAll(/"created_at"\s+([^,\n]+)/g)].map((m) => normalize(m[1]));
    expect(createdAt.length).toBeGreaterThan(0);
    for (const decl of createdAt) {
      expect(decl).toBe('TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP');
    }
    const updatedAt = [...ddl.matchAll(/"updated_at"\s+([^,\n]+)/g)].map((m) => normalize(m[1]));
    expect(updatedAt.length).toBeGreaterThan(0);
    for (const decl of updatedAt) {
      expect(decl).toBe('TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP');
    }
  });
});
