import { idParamsSchema } from "@clockoff/validation/primitives";
import { createHandler } from "@/server/http/apiHandler";
import { getImport } from "@/server/imports";

/** `GET /api/imports/:id` (`schedule:read`) → `{ import, suggestion? }` (suggestion until committed). */
export const GET = createHandler(
  { auth: "manager", permission: "schedule:read", params: idParamsSchema },
  async ({ ctx, params }) => getImport(ctx, params.id),
);
