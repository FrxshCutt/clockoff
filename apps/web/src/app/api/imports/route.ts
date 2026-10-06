import { importQuerySchema } from "@workmode/validation/imports";
import { createHandler, json } from "@/server/http/apiHandler";
import { IMPORT_UPLOAD_MAX_BODY_BYTES, listImports, uploadImport } from "@/server/imports";

/** `GET /api/imports?status&page&pageSize` (`schedule:read`) → recent imports, newest first. */
export const GET = createHandler(
  { auth: "manager", permission: "schedule:read", query: importQuerySchema },
  async ({ ctx, query }) => listImports(ctx, query),
);

/**
 * `POST /api/imports` (`imports:write`, multipart/form-data: `file` + optional `dateFormat`, `timezone`,
 * `locationId`) → 201 `{ import, suggestion, sampleRows }`. No `body` schema: the multipart body is read
 * inside the service, which enforces the 5 MB / CSV-type / 5,000-row limits (PAYLOAD_TOO_LARGE,
 * UNSUPPORTED_MEDIA_TYPE, INVALID_CSV).
 */
export const POST = createHandler(
  { auth: "manager", permission: "imports:write", maxBodyBytes: IMPORT_UPLOAD_MAX_BODY_BYTES },
  async ({ ctx, req }) => json(await uploadImport(ctx, req), 201),
);
