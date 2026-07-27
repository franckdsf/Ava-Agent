# syntax=docker/dockerfile:1

# Debian slim rather than Alpine: @libsql/client loads a native module for
# `file:` databases, and glibc builds are the well-trodden path.

# ─── build ─────────────────────────────────────────────────────────────────────
FROM node:22-slim AS build
WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
# No secrets needed here — the bundler never evaluates the env schema.
RUN pnpm build

# ─── runtime ───────────────────────────────────────────────────────────────────
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# `mastra build` emits a self-contained bundle, its own package.json and
# node_modules included, so nothing is installed at this stage.
COPY --from=build /app/.mastra/output ./
# Migrations are read at runtime and must travel with the server.
COPY --from=build /app/drizzle ./drizzle

RUN mkdir -p /data && chown -R node:node /data /app
USER node

# Overridden by docker-compose / your platform. Point AVA_DATA_DB_URL at a
# libsql:// URL to drop the volume entirely and run stateless.
ENV AVA_DATA_DB_URL=file:/data/ava.db \
    AVA_TRACES_DB_URL=file:/data/traces.db \
    AVA_MIGRATIONS_DIR=/app/drizzle

EXPOSE 4111
CMD ["node", "./index.mjs"]
