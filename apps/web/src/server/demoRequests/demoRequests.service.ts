import type { RequestDemoInput, RequestDemoResponse } from "@clockoff/validation/organisation";
import { logger, type Logger } from "@/lib/logger";
import type { RateLimitRule } from "@/server/rateLimit";
import { createDemoRequest } from "./demoRequests.repository";

/**
 * `POST /api/request-demo` (public). Stores the marketing form; the response is always `{ ok: true }` so a
 * caller learns nothing about what happened. A filled honeypot (`website`, hidden from real visitors) is
 * accepted but not stored. Nothing personal is logged — only the request id.
 */

/** 5 demo requests per hour per IP (coarse per-IP rule applied by the route). */
export const DEMO_REQUEST_RATE_LIMIT: RateLimitRule = {
  key: "demo:request",
  limit: 5,
  windowSeconds: 60 * 60,
  by: "ip",
};

export interface DemoRequestMeta {
  requestId?: string;
  log?: Logger;
}

export async function submitDemoRequest(
  input: RequestDemoInput,
  meta: DemoRequestMeta = {},
): Promise<RequestDemoResponse> {
  const log = meta.log ?? logger;
  if (input.website && input.website.trim().length > 0) {
    log.info({ requestId: meta.requestId }, "demo request dropped: honeypot filled");
    return { ok: true };
  }
  const row = await createDemoRequest({
    name: input.name,
    email: input.email,
    company: input.company,
    teamSize: input.teamSize?.trim() ? input.teamSize.trim() : null,
    message: input.message?.trim() ? input.message.trim() : null,
    source: input.source?.trim() ? input.source.trim() : null,
  });
  log.info({ requestId: meta.requestId, demoRequestId: row.id }, "demo request stored");
  return { ok: true };
}
