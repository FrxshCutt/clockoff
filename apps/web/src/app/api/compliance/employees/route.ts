import { complianceEmployeesQuerySchema } from "@workmode/validation/compliance";
import { listComplianceEmployees } from "@/server/compliance/compliance.service";
import { createHandler } from "@/server/http/apiHandler";

export const dynamic = "force-dynamic";

/** `GET /api/compliance/employees?filter&locationId&teamId&search&page&pageSize` (employees:read). */
export const GET = createHandler(
  { auth: "manager", permission: "employees:read", query: complianceEmployeesQuerySchema },
  async ({ ctx, query }) => listComplianceEmployees(ctx, query),
);
