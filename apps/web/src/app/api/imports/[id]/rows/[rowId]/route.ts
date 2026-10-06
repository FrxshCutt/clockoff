import { importRowParamsSchema, updateImportRowSchema } from "@workmode/validation/imports";
import { createHandler } from "@/server/http/apiHandler";
import { updateImportRow } from "@/server/imports";

/**
 * `PATCH /api/imports/:id/rows/:rowId` (`imports:write`) → `{ row, summary }`. Exactly one of
 * `{ matchedEmployeeId }`, `{ createEmployee }`, `{ skip }`, `{ locationAction }`; the import is re-validated.
 */
export const PATCH = createHandler(
  {
    auth: "manager",
    permission: "imports:write",
    params: importRowParamsSchema,
    body: updateImportRowSchema,
  },
  async ({ ctx, params, body }) => updateImportRow(ctx, params.id, params.rowId, body),
);
