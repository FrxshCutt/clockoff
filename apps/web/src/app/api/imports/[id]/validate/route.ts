import { emptyBodySchema, idParamsSchema } from "@workmode/validation/primitives";
import { createHandler } from "@/server/http/apiHandler";
import { validateImport } from "@/server/imports";

/** `POST /api/imports/:id/validate` (`imports:write`) → `{ import, summary }`, status VALIDATED. Re-runnable. */
export const POST = createHandler(
  { auth: "manager", permission: "imports:write", params: idParamsSchema, body: emptyBodySchema },
  async ({ ctx, params }) => validateImport(ctx, params.id),
);
