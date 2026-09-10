FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
# [DR-032] npm `postinstall` hook has been REMOVED. `npm ci` is now
# database-free — there is no longer any DB-touching lifecycle hook
# wired into the install. The previous postinstall
# (scripts/clear-failed-migrations.js) would clobber unfinished
# `_prisma_migrations` rows from concurrent releases. The script
# remains on disk as an operator-only tool (requires
# `OPS_RECONCILE_FAILED_MIGRATIONS=1`); the production recovery path
# is backend/start.sh, which is invoked by Render's dashboard
# startCommand and the only serialized release procedure.
# scripts/ is still copied because the script is referenced as a
# documentation/operator reference, but no hook fires it during build.
COPY scripts/ ./scripts/

RUN npm ci --only=production

COPY prisma ./prisma/
RUN npx prisma generate

COPY src ./src/

EXPOSE 3000

# LPR-001: `prisma db push` is destructive (accepts data loss, no migration
# history) and must never run against production. Schema reconciliation is
# exclusively the job of `prisma migrate deploy`, which applies only
# pending checked-in SQL migrations and is idempotent.
#
# [DR-032] Release contract: production runs `sh start.sh` (set as the
# startCommand on the Render dashboard; also declared in render.yaml).
# `start.sh` is the SOLE serialized release/operator procedure: it
# deletes non-applied rows for known-bad migrations, runs
# `prisma migrate resolve --rolled-back`, runs `prisma migrate deploy`
# (failure-before-serving: exits non-zero on failed migration so the
# broken revision does NOT receive traffic), then exec's node.
#
# Render's dashboard startCommand is authoritative and overrides
# anything declared here or in render.yaml. This Dockerfile's CMD is a
# safety net for environments that DON'T override CMD (local docker
# run, dev containers). It deliberately skips `prisma migrate deploy`
# — running a container without the migration prerequisite requires
# the operator to either (a) use `start.sh` or (b) run migrations
# explicitly before invoking this image. The contract is: production
# = `sh start.sh`; this CMD is dev/local fallback.
CMD ["node", "src/index.js"]
