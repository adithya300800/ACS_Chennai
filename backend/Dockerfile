FROM node:22-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci --only=production

COPY prisma ./prisma/
RUN npx prisma generate

COPY src ./src/
COPY start.sh ./start.sh
RUN chmod +x ./start.sh

EXPOSE 3000

# LPR-001: `prisma db push` is destructive (accepts data loss, no migration
# history) and must never run against production. Schema reconciliation is now
# exclusively the job of `prisma migrate deploy`, which applies only pending
# checked-in SQL migrations and is idempotent. This Dockerfile is invoked by
# Render's build step; the runtime migration happens in startup.sh so the
# migration log is owned by the boot phase rather than the build cache.
#
# [N1] The CMD points at start.sh — not at `node src/index.js` — because
# start.sh wraps `prisma migrate deploy` with a recovery block that clears
# `_prisma_migrations` failed rows for known-bad migrations BEFORE migrate
# deploy runs. Without this, P3009 blocks every subsequent deploy once any
# migration is marked failed. Render's render.yaml startCommand is
# belt-and-suspenders; the Dockerfile CMD is the canonical path.
CMD ["sh", "./start.sh"]
