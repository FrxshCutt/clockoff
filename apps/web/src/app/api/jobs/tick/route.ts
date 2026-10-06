import { createHandler } from "@/server/http/apiHandler";
import { runWorkModeTick } from "@/server/workState/workStateJob";

export const dynamic = "force-dynamic";
/** A tick over a large tenant base can take a while; never let the platform cut it short at the default. */
export const maxDuration = 300;

/**
 * `POST /api/jobs/tick` (cron: `Authorization: Bearer <CRON_SECRET>`) → `{ ok, report }`. Runs one Work
 * Mode tick for an external scheduler; idempotent and safe alongside the node-cron runner
 * (docs/WORK_MODE_SERVER_JOB.md). Not part of the public OpenAPI document (internal endpoint).
 */
export const POST = createHandler({ auth: "cron" }, async ({ log }) => ({
  ok: true as const,
  report: await runWorkModeTick(new Date(), { log }),
}));
