# ClockOff worker service (Railway "worker", railway/worker.json): the background jobs (Work Mode tick,
# override expiry, schedule upkeep, the 15-minute integrations sync), the heartbeat and the push bridge.
# Built from apps/web/src/worker/main.ts as one esbuild bundle (apps/web/scripts/build-worker.mjs) plus the
# native/runtime externals it needs (@prisma/client with its generated engine, @node-rs/argon2).
#
#   docker build -f docker/worker/Dockerfile -t clockoff-worker .     # context = repo root (.dockerignore)
#   docker run --rm clockoff-worker node main.mjs list                 # CLI: serve (default) | list | run <job> | …
#
# Deterministic: the base image is pinned by NODE_IMAGE, pnpm by version, dependencies by pnpm-lock.yaml.
# No application environment or secrets at build time.
# Pinned to an exact Node 22 release and its multi-arch index digest (amd64 on Railway, arm64 locally).
# Bump both together: docker buildx imagetools inspect node:22.<x>.<y>-bookworm-slim
ARG NODE_IMAGE=node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

# ── os: runtime OS packages (Prisma's engine links OpenSSL; TLS to Neon needs CA certificates) ─────────
FROM ${NODE_IMAGE} AS os
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# ── base: build tooling (pnpm pinned to package.json#packageManager; no corepack) ─────────────────────
FROM os AS base
RUN npm install -g pnpm@11.10.0
ENV CI=true NEXT_TELEMETRY_DISABLED=1
WORKDIR /repo

# ── deps: install from the lockfile only (cached until a manifest or the Prisma schema changes) ───────
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json apps/web/
COPY packages/config/package.json packages/config/
COPY packages/db/package.json packages/db/prisma.config.ts packages/db/
COPY packages/db/prisma packages/db/prisma
COPY packages/shared/package.json packages/shared/
COPY packages/validation/package.json packages/validation/
# The root postinstall runs `prisma generate`, producing the engine for this image's platform.
RUN pnpm install --frozen-lockfile

# ── build: bundle the worker → apps/web/dist/worker (main.mjs + node_modules with the externals) ──────
FROM deps AS build
COPY . .
RUN node apps/web/scripts/build-worker.mjs

# ── runner ────────────────────────────────────────────────────────────────────────────────────────────
FROM os AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/dist/worker/ ./
USER node
# The heap cap leaves room for Prisma's engine and the pg/pino buffers inside the 256 MiB service limit.
ENV NODE_OPTIONS="--max-old-space-size=160 --enable-source-maps"
# Node is PID 1 (exec form) so SIGTERM reaches the worker's graceful shutdown (finish jobs, release locks).
CMD ["node", "main.mjs"]
