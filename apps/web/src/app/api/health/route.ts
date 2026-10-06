import { prisma } from "@workmode/db";
import { errorSummary } from "@/lib/logger";
import { createHandler, json } from "@/server/http/apiHandler";

export const dynamic = "force-dynamic";

/**
 * `GET /api/health` — liveness + database reachability for load balancers / uptime checks.
 * 200 `{ status: "ok", database: "ok", time }`, or 503 `{ status: "degraded", database: "unreachable" }`.
 * Reveals no version, configuration or error detail.
 */
export const GET = createHandler({ auth: "public" }, async ({ log }) => {
  const time = new Date().toISOString();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return json({ status: "ok", database: "ok", time });
  } catch (err) {
    log.error({ error: errorSummary(err) }, "health check: database unreachable");
    return json({ status: "degraded", database: "unreachable", time }, 503);
  }
});
