FROM node:22-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci --only=production

COPY prisma ./prisma/
RUN npx prisma generate

COPY src ./src/

EXPOSE 3000

# LPR-001: `prisma db push` is destructive (accepts data loss, no migration
# history) and must never run against production. Schema reconciliation is now
# exclusively the job of `prisma migrate deploy`, which applies only pending
# checked-in SQL migrations and is idempotent. This Dockerfile is invoked by
# Render's build step; the runtime migration happens in startup.sh so the
# migration log is owned by the boot phase rather than the build cache.
CMD ["sh", "-c", "node src/index.js"]
