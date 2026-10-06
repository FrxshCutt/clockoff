import { GET as auditLogsRoute } from "@/app/api/audit-logs/route";
import { audit } from "@/server/audit/audit";
import { registerTenantIsolationCase } from "../../helpers/tenantIsolation";

/** Audit logs: org A's owner never sees org B's rows, even when filtering by B's actor. */

registerTenantIsolationCase({
  name: "GET /api/audit-logs filtered by another tenant's actor",
  build: async (_a, b) => {
    await audit(
      { organisation: { id: b.organisation.id }, user: b.owner },
      { action: "policy.published", entityType: "Policy", entityId: "b-policy" },
    );
    return { handler: auditLogsRoute, path: "/api/audit-logs", query: { actorUserId: b.owner.id } };
  },
  // The filter is honoured inside org A only, so the answer is an empty list (asserted in auditLogs.test.ts).
  expectStatus: 200,
});
