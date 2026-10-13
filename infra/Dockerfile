# One multi-stage Dockerfile for all apps; the build context is the repo root.
FROM node:22-bookworm-slim AS deps
# Prisma's query engine links against OpenSSL, which the slim image doesn't ship.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY apps/backend/package.json apps/backend/
COPY apps/worker/package.json apps/worker/
COPY apps/frontend/package.json apps/frontend/
RUN npm ci

FROM deps AS build
COPY packages ./packages
COPY apps ./apps
RUN npm run build

FROM build AS backend
WORKDIR /app/apps/backend
ENV NODE_ENV=production
EXPOSE 3000
# Apply pending migrations and (re)seed the admin before serving. Both are idempotent.
CMD ["sh", "-c", "npx prisma migrate deploy --schema /app/packages/db/prisma/schema.prisma && node dist/seed.js && exec node dist/main.js"]

FROM build AS worker
# ffmpeg/ffprobe live only in the worker image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app/apps/worker
ENV NODE_ENV=production
CMD ["node", "dist/main.js"]

FROM build AS frontend
WORKDIR /app/apps/frontend
EXPOSE 5173
CMD ["npx", "vite", "preview"]
