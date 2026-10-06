import { commitImportSchema } from "@workmode/validation/imports";
import { idParamsSchema } from "@workmode/validation/primitives";
import { createHandler } from "@/server/http/apiHandler";
import { commitImport } from "@/server/imports";

/**
 * `POST /api/imports/:id/commit` `{ includeWarnings?, skipErrors? }` (`imports:write`) →
 * `{ import, shiftsCreated, employeesCreated, rowsSkipped }`. IMPORT_HAS_ERRORS while ERROR rows remain.
 */
export const POST = createHandler(
  { auth: "manager", permission: "imports:write", params: idParamsSchema, body: commitImportSchema },
  async ({ ctx, params, body }) => commitImport(ctx, params.id, body),
);
