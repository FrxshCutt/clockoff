import { getComplianceSummary } from "@/server/compliance/compliance.service";
import { createHandler } from "@/server/http/apiHandler";

export const dynamic = "force-dynamic";

/** `GET /api/compliance/summary` (employees:read) → metrics, upcoming shifts, integration status. */
export const GET = createHandler({ auth: "manager", permission: "employees:read" }, async ({ ctx }) =>
  getComplianceSummary(ctx),
);
