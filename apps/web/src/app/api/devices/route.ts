import { deviceQuerySchema } from "@workmode/validation/devices";
import { listDevices } from "@/server/devices";
import { createHandler } from "@/server/http/apiHandler";

/** `GET /api/devices?page&pageSize&employeeId&locationId&isActive&permissionState` (employees:read) → `listDevicesResponseSchema`. */
export const GET = createHandler(
  { auth: "manager", permission: "employees:read", query: deviceQuerySchema },
  async ({ ctx, query }) => listDevices(ctx, query),
);
