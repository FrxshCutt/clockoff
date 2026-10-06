import { createOverrideSchema, overrideQuerySchema } from "@workmode/validation/overrides";
import { createHandler, json } from "@/server/http/apiHandler";
import { createOverride, listOverrides } from "@/server/overrides/overrides.service";

export const dynamic = "force-dynamic";

/** `GET /api/overrides?employeeId&type&status&cursor&limit` (employees:read) → `{ items, nextCursor }`. */
export const GET = createHandler(
  { auth: "manager", permission: "employees:read", query: overrideQuerySchema },
  async ({ ctx, query }) => listOverrides(ctx, query),
);

/** `POST /api/overrides` (overrides:create) → 201 `{ override }`; EMERGENCY_POLICY_OVERRIDE also needs org:manage. */
export const POST = createHandler(
  { auth: "manager", permission: "overrides:create", body: createOverrideSchema },
  async ({ ctx, body }) => json({ override: await createOverride(ctx, body) }, 201),
);
