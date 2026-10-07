import { idParamsSchema } from "@clockoff/validation/primitives";
import { createHandler } from "@/server/http/apiHandler";
import { exportImportErrorsCsv } from "@/server/imports";

/** `GET /api/imports/:id/errors.csv` (`schedule:read`) → `text/csv` attachment of every row with problems. */
export const GET = createHandler(
  { auth: "manager", permission: "schedule:read", params: idParamsSchema },
  async ({ ctx, params }) => exportImportErrorsCsv(ctx, params.id),
);
