# 20260903010000_r25_notifications — apply instructions

## Why this folder exists

Round-25 added four Prisma models (`NotificationPreference`, `EmailLog`,
`DigestItem`, `DigestRun`) to support the employee notification preference
page, the email audit log, and the daily digest cron. The previous
deployment path ran `prisma db push --accept-data-loss`, which silently
created these tables in production without writing any checked-in
migration under `prisma/migrations/`.

LPR-001 (separate commit) converted the deployment path to
`prisma migrate deploy`. Without a checked-in migration for the round-25
models, the next deploy would either:

1. Re-emit empty `CREATE TABLE` statements that succeed silently
   (`IF NOT EXISTS` makes them idempotent), but `_prisma_migrations`
   would gain a row for tables that already exist — which is misleading
   audit metadata; or
2. Hit a non-trivial drift between schema.prisma and the live catalog
   and require a manual `prisma migrate diff` reconciliation step that
   blocks the deploy.

## How to apply

### Fresh database (e.g. disposable restore-rehearsal env)

```sh
cd backend
npx prisma migrate deploy
```

This will apply all four `CREATE TABLE IF NOT EXISTS` blocks and record
the migration in `_prisma_migrations`. Idempotent.

### Production (the live case — tables already exist)

The four tables are already live in production. Apply once and resolve
without re-executing:

```sh
# Step 1: apply the DDL with --create-only so nothing actually runs yet.
cd backend
npx prisma migrate deploy --create-only

# Step 2: edit the generated SQL to ensure CREATE TABLE IF NOT EXISTS
# semantics are used. (This file already does.)

# Step 3: mark the migration as applied WITHOUT executing it:
npx prisma migrate resolve --applied 20260903010000_r25_notifications
```

After step 3, `_prisma_migrations` records this migration as applied,
future `prisma migrate deploy` calls see it as already-applied, and the
schema is reconcilable from checked-in SQL.

### Verification

After apply (either path), confirm:

```sql
SELECT migration_name, finished_at IS NOT NULL AS done
  FROM _prisma_migrations
 WHERE migration_name = '20260903010000_r25_notifications';

-- All four tables exist with the expected columns:
SELECT table_name FROM information_schema.tables
 WHERE table_schema = 'public'
   AND table_name IN (
     'notification_preference',
     'email_log',
     'digest_item',
     'digest_run'
   );
```

## What this migration does NOT do

- It does NOT seed `notification_preference` rows for existing employees.
  The application code treats a missing preference row as `enabled` (the
  contract from the round-25 implementation), so no backfill is required.
- It does NOT migrate historical email/digest data — that data has been
  written through the live app since round-25 and lives in the existing
  tables.
- It does NOT change the `channel` column's free-form `String` constraint
  on `email_log` — round-25 added ADMIN_IMMEDIATE / ADMIN_DIGEST values
  in round-26 and the schema deliberately keeps the column free-form so
  new values are a no-op migration.
