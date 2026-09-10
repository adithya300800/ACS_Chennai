FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
# DR-032: install is DB-free. `npm ci` no longer runs a migration-recovery
# postinstall hook. If the build needs the recovery helper on disk (for
# manual operator use), it is copied below; otherwise the install step
# must succeed without DB connectivity.
COPY scripts/ ./scripts/

RUN npm ci --only=production

COPY prisma ./prisma/
RUN npx prisma generate

COPY src ./src/

EXPOSE 3000

# [DR-032] Native/Docker release contract.
#
# 1. `prisma db push` is destructive (accepts data loss, no migration
#    history) and must never run against production. Schema reconciliation
#    is exclusively the job of `prisma migrate deploy`, which applies only
#    pending checked-in SQL migrations and is idempotent.
# 2. Failure-before-serving: `npx prisma migrate deploy` MUST run before
#    the app starts. If it returns a non-zero exit code (e.g. P3009 for
#    a failed migration in `_prisma_migrations`), the container stops
#    rather than serving traffic against a stale schema. The chained
#    `&&` enforces this; the shell exits on first failure.
# 3. Recovery is operator-only. The postinstall hook that auto-cleared
#    allowlisted rows is gone. If `migrate deploy` fails because of a
#    stuck row, an operator runs
#      `npm run db:recover -- --confirmed-abandoned`
#    after inspecting the ledger and verifying backup readiness.
# 4. Render's dashboard startCommand is authoritative and overrides
#    anything here. The same chain (`npx prisma migrate deploy &&
#    node src/index.js`) is set in the dashboard; this Dockerfile is the
#    authoritative contract for non-Render Docker deployments.
CMD ["sh", "-c", "npx prisma migrate deploy && node src/index.js"]
