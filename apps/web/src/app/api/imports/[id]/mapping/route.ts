import { importMappingSchema } from "@workmode/validation/imports";
import { idParamsSchema } from "@workmode/validation/primitives";
import { createHandler } from "@/server/http/apiHandler";
import { saveImportMapping } from "@/server/imports";

/**
 * `POST /api/imports/:id/mapping` `{ mapping, options? }` (`imports:write`) → `{ import, suggestion }`,
 * status MAPPED. IMPORT_MAPPING_INCOMPLETE unless date, start, end and an employee identifier are mapped.
 */
export const POST = createHandler(
  {
    auth: "manager",
    permission: "imports:write",
    params: idParamsSchema,
    body: importMappingSchema,
  },
  async ({ ctx, params, body }) => saveImportMapping(ctx, params.id, body),
);
