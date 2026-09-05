FROM node:22-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci --only=production

COPY prisma ./prisma/
RUN npx prisma generate

COPY src ./src/

EXPOSE 3000

# LPR-001: `prisma db push` is destructive (accepts data loss, no migration
# history) and must never run against production. Schema reconciliation is
# exclusively the job of `prisma migrate deploy`, which applies only
# pending checked-in SQL migrations and is idempotent. This Dockerfile is
# invoked by Render's build step; the runtime migration happens in the
# startCommand (`npx prisma migrate deploy && node src/index.js` — set in
# the Render dashboard).
#
# Render's dashboard startCommand is authoritative and overrides anything
# here or in render.yaml. The migration-recovery hook that clears failed
# rows in `_prisma_migrations` (P3009 blocker) lives in the npm
# `postinstall` lifecycle (backend/scripts/clear-failed-migrations.js),
# which fires during the `npm install` build step — that runs BEFORE the
# startCommand, so it executes regardless of dashboard config.
CMD ["node", "src/index.js"]
