FROM node:22-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci --only=production

COPY prisma ./prisma/
RUN npx prisma generate

COPY src ./src/

EXPOSE 3000

CMD ["sh", "-c", "npx prisma db push && node src/index.js"]
