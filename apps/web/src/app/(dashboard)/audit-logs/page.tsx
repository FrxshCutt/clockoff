import type { Metadata } from "next";
import { AuditLogsPage as AuditLogsView } from "@/components/activity/audit-logs-page";

export const metadata: Metadata = { title: "Audit Log" };

/** `/audit-logs` — owners and admins only (`audit:read`); other roles see an explanation. */
export default function Page() {
  return <AuditLogsView />;
}
