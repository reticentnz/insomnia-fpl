# syntax=docker/dockerfile:1

FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm install --no-audit

COPY index.html tsconfig.json ./
COPY db ./db
COPY scripts ./scripts
COPY src ./src

RUN npm run build

FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4173 \
    DATABASE_URL=file:/app/data/insomnia-fpl.db \
    SIGNAL_CONFIG_FILE=/app/data/signal-config.json \
    FPL_INGEST_CACHE_PATH=/app/data/cache/fpl-official.json \
    FPL_DATA_CACHE_FILE=/app/data/cache/fpl-data.json \
    SIGNAL_CACHE_DIR=/app/data/cache/signal-feeds \
    FPL_INGEST_INTERVAL_HOURS=12 \
    UNDERLYING_INGEST_INTERVAL_HOURS=24 \
    HISTORICAL_PRIOR_IMPORT_ENABLED=1 \
    MARKET_INGEST_INTERVAL_HOURS=6 \
    MANAGER_REFRESH_INTERVAL_HOURS=12 \
    CREATOR_INGEST_INTERVAL_HOURS=0.5 \
    PYTHON_BIN=/opt/venv/bin/python

WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm install --omit=dev --no-audit

COPY requirements.txt ./
RUN apk add --no-cache python3 py3-pip \
    && python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt

COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY --from=build --chown=node:node /app/db ./db
COPY --from=build --chown=node:node /app/src ./src
RUN mkdir -p /app/data && chown node:node /app/data

USER node

EXPOSE 4173
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --quiet --spider http://127.0.0.1:4173/api/health || exit 1

CMD ["node", "--experimental-strip-types", "scripts/serve.mjs"]
