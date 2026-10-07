import { requestDemoSchema } from "@clockoff/validation/organisation";
import { DEMO_REQUEST_RATE_LIMIT, submitDemoRequest } from "@/server/demoRequests";
import { createHandler } from "@/server/http/apiHandler";

/**
 * `POST /api/request-demo` (public, 5 / hour per IP, same-origin only) → `{ ok: true }`. Stores a marketing
 * demo request; a filled honeypot (`website`) is accepted but dropped.
 */
export const POST = createHandler(
  { auth: "public", body: requestDemoSchema, rateLimit: DEMO_REQUEST_RATE_LIMIT },
  async ({ body, requestId, log }) => submitDemoRequest(body, { requestId, log }),
);
