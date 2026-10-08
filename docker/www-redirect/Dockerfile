# ClockOff www redirect (Railway service "www", railway/www.json): www.clockoff.online → clockoff.online.
# A separate service only because Railway's Hobby plan allows two custom domains per service (web carries the
# apex and app hosts). Dependency-free; the same pinned base image as docker/web and docker/worker.
#
#   docker build -f docker/www-redirect/Dockerfile -t clockoff-www .     # context = repo root (.dockerignore)
ARG NODE_IMAGE=node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

FROM ${NODE_IMAGE}
ENV NODE_ENV=production PORT=8080 NODE_OPTIONS=--max-old-space-size=48
WORKDIR /app
COPY --chown=node:node docker/www-redirect/server.mjs ./
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
