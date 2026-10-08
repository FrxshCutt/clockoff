#!/bin/sh
# Railway pre-deploy command for the web service (railway/web.json → "/app/migrate.sh"): applies pending
# Prisma migrations with the image's own Prisma CLI before the new web deployment receives traffic.
#
# It needs the DIRECT (non-pooled) connection: Prisma's migration lock is a session-level advisory lock,
# which PgBouncer's transaction mode cannot hold. A pooled string is refused, whether it comes from
# DIRECT_URL or the DATABASE_URL fallback (local runs without DIRECT_URL). No URL is ever printed.
# There is no prisma.config.ts in the image (no dotenv / TypeScript loader): the schema is passed explicitly.
set -eu
: "${DATABASE_URL:?DATABASE_URL must be set}"
url="${DIRECT_URL:-$DATABASE_URL}"
case "$url" in
  *-pooler.*|*pgbouncer=true*)
    echo "migrate.sh: refusing a pooled connection string; set DIRECT_URL to the direct (non-pooled) URL" >&2
    exit 1 ;;
esac
export DATABASE_URL="$url" CHECKPOINT_DISABLE=1 PRISMA_HIDE_UPDATE_MESSAGE=1
# /app/migrate in the image: the Prisma CLI closure (node_modules) + prisma/ (schema and migrations).
cd "$(dirname -- "$0")/migrate"
exec node node_modules/prisma/build/index.js migrate deploy --schema prisma/schema.prisma
