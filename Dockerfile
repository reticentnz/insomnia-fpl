# syntax=docker/dockerfile:1

FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

COPY index.html tsconfig.json ./
COPY prisma ./prisma
COPY scripts ./scripts
COPY src ./src

RUN npm run build

FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4173 \
    DATABASE_URL=file:/app/data/fplgod.db \
    FPL_DATA_CACHE_FILE=/app/data/cache/fpl-data.json

WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev && npm cache clean --force

COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/scripts/serve.mjs ./scripts/serve.mjs
COPY --from=build --chown=node:node /app/scripts/db.mjs ./scripts/db.mjs
COPY --from=build --chown=node:node /app/src/player-signals.ts ./src/player-signals.ts
RUN mkdir -p /app/data && chown node:node /app/data

USER node

EXPOSE 4173
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --quiet --spider http://127.0.0.1:4173/api/health || exit 1

CMD ["node", "--experimental-strip-types", "scripts/serve.mjs"]
