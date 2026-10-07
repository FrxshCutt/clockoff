import { AppError } from "@clockoff/shared/errors";
import { emailSchema } from "@clockoff/validation/common";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { getRequestId } from "@/lib/request";
import { lastDevOutboxEmail } from "@/server/email";
import { createHandler, errorResponse } from "@/server/http/apiHandler";

export const dynamic = "force-dynamic";

const lastEmailQuerySchema = z.object({ to: emailSchema }).strict();

/** Development tooling is on only when `DEV_TOOLS_ENABLED=true` AND the process is not production. */
function devToolsEnabled(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  const e = env();
  return e.DEV_TOOLS_ENABLED && !e.isProduction;
}

const handler = createHandler(
  { auth: "public", query: lastEmailQuerySchema },
  async ({ query }) => {
    const email = lastDevOutboxEmail(query.to);
    if (!email) throw new AppError("NOT_FOUND", "No email has been sent to that address yet");
    return {
      email: { to: email.to, subject: email.subject, text: email.text, sentAt: email.sentAt },
    };
  },
);

/**
 * `GET /api/dev/last-email?to=<address>` (development only) → `{ email: { to, subject, text, sentAt } }`:
 * the most recent message the console email provider sent to that address, from its in-memory ring buffer.
 * Playwright uses it to follow verification links. Answers 404 `NOT_FOUND` before reading the query unless
 * `DEV_TOOLS_ENABLED=true` and `NODE_ENV` is not production (and `env()` refuses to start production with
 * dev tools on). Not part of the OpenAPI document (docs/API.md "Not in the document").
 */
export async function GET(req: NextRequest, context: unknown): Promise<Response> {
  if (!devToolsEnabled()) {
    return errorResponse(new AppError("NOT_FOUND", "Not found"), getRequestId(req));
  }
  return handler(req, context);
}
