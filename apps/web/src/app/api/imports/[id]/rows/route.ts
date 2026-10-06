import { importRowsQuerySchema } from "@workmode/validation/imports";
import { idParamsSchema } from "@workmode/validation/primitives";
import { createHandler } from "@/server/http/apiHandler";
import { listImportRowsPage } from "@/server/imports";

/** `GET /api/imports/:id/rows?status&page&pageSize` (`schedule:read`) → paginated rows in file order. */
export const GET = createHandler(
  { auth: "manager", permission: "schedule:read", params: idParamsSchema, query: importRowsQuerySchema },
  async ({ ctx, params, query }) => listImportRowsPage(ctx, params.id, query),
);
