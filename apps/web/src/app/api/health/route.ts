import { getMigrationStatus, prisma } from "@workmode/db";
import { errorSummary } from "@/lib/logger";
import { createHandler, json } from "@/server/http/apiHandler";

export const dynamic = "force-dynamic";

/**
 * `GET /api/health` — liveness, database reachability and migration state, for load balancers, uptime
 * checks and post-deploy verification.
 * 200 `{ status: "ok", database: "ok", migrations: "up_to_date", time }`;
 * 503 `{ status: "degraded", … }` when the database is unreachable or migrations are pending/failed.
 * Reveals no version, configuration or error detail.
 */
export const GET = createHandler({ auth: "public" }, async ({ log }) => {
  const time = new Date().toISOString();
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    log.error({ error: errorSummary(err) }, "health check: database unreachable");
    return json({ status: "degraded", database: "unreachable", migrations: "unknown", time }, 503);
  }
  const migrations = await getMigrationStatus(prisma);
  if (migrations !== "up_to_date")
    log.warn({ migrations }, "health check: migrations not up to date");
  const healthy = migrations === "up_to_date";
  return json(
    { status: healthy ? "ok" : "degraded", database: "ok", migrations, time },
    healthy ? 200 : 503,
  );
});
