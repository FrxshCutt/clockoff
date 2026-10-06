import type { Metadata } from "next";
import { PlaceholderPage } from "@/components/placeholder-page";

export const metadata: Metadata = { title: "Audit Log" };

export default function AuditLogsPage() {
  return (
    <PlaceholderPage
      title="Audit Log"
      description="A record of changes made by managers in this organisation."
      emptyState="auditLogs"
    />
  );
}
