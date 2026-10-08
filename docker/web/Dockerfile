# ClockOff web service (Railway "web", railway/web.json): marketing site, manager dashboard and every API
# route, served by Next.js's standalone server. Runs no background jobs (those live in the worker image).
#
#   docker build -f docker/web/Dockerfile -t clockoff-web .        # context = repo root (.dockerignore)
#
# Deterministic: the base image is pinned by NODE_IMAGE, pnpm by version, dependencies by pnpm-lock.yaml
# (--frozen-lockfile). The build needs no application environment and no secrets; everything is read at
# runtime from the platform's variables. Pre-deploy migrations: /app/migrate.sh (docker/web/migrate.sh).
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
COPY packages/integrations/package.json packages/integrations/
COPY packages/shared/package.json packages/shared/
COPY packages/validation/package.json packages/validation/
# The root postinstall runs `prisma generate`, producing the engine for this image's platform.
RUN pnpm install --frozen-lockfile

# ── build: Next.js standalone output + the Prisma CLI closure for pre-deploy migrations ───────────────
FROM deps AS build
COPY . .
RUN pnpm --filter @clockoff/web exec next build
RUN node apps/web/scripts/collect-runtime-deps.mjs --from packages/db --out /opt/migrate prisma \
  && cp -R packages/db/prisma /opt/migrate/prisma

# ── runner ────────────────────────────────────────────────────────────────────────────────────────────
FROM os AS runner
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
# outputFileTracingRoot = repo root, so the standalone tree mirrors the monorepo: apps/web/server.js.
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
COPY --from=build --chown=node:node /opt/migrate ./migrate
COPY --chown=node:node docker/web/migrate.sh ./migrate.sh
RUN chmod 0755 /app/migrate.sh
USER node
# HOSTNAME must stay: Docker sets it to the container id, and the server binds to it.
# The heap cap leaves room for Prisma's engine and buffers inside the 512 MiB service limit.
ENV HOSTNAME=0.0.0.0 PORT=3000 NODE_OPTIONS=--max-old-space-size=320
EXPOSE 3000
# Node is PID 1 (exec form): SIGTERM reaches Next's handler, which stops accepting connections, waits for
# in-flight requests and after() tasks, and exits; src/instrumentation.ts closes the SSE streams first.
CMD ["node", "apps/web/server.js"]
