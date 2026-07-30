# syntax=docker/dockerfile:1

# Debian slim rather than Alpine: @libsql/client loads a native module for
# `file:` databases, and glibc builds are the well-trodden path.

# ─── build ─────────────────────────────────────────────────────────────────────
FROM node:22-slim AS build
WORKDIR /app

# Corepack reads `packageManager` from package.json and fetches that exact pnpm.
# Without the pin it takes whatever is latest on the day of the build: this image
# resolved 11.18.0 against a lockfile written by 11.0.3, and the next major would
# arrive the same silent way. The prompt is disabled because the download is not
# a decision anyone is here to make.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# `pnpm-workspace.yaml` belongs in this layer, not with the source below.
# pnpm 10+ refuses to run a dependency's build script unless it is approved
# there, and *errors* rather than warning — `ERR_PNPM_IGNORED_BUILDS`. esbuild's
# postinstall is what fetches its native binary, so without this file the install
# fails outright and, if it did not, `mastra build` would fail for want of a
# bundler. Copying it after the install is too late to be seen.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
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
