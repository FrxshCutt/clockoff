"use client";

import { ScrollText } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { TableSkeleton } from "@/components/loading-skeletons";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { ROUTES } from "@/config/navigation";
import { useCurrentUser, usePermission } from "@/hooks/use-current-user";
import { AuditLogTable } from "./audit-log-table";

/**
 * `/audit-logs`: owners and admins only (`audit:read`). The page frame renders straight away; until the
 * session is known the table area shows a skeleton, and other roles see an explanation rather than a
 * failing table — the API would answer FORBIDDEN anyway.
 */
export function AuditLogsPage() {
  const { isPending } = useCurrentUser();
  const canRead = usePermission("audit:read");

  return (
    <>
      <PageHeader
        title="Audit Log"
        description="A record of changes made by managers in this organisation."
      />
      {isPending ? (
        <div role="status" aria-live="polite" aria-busy="true">
          <span className="sr-only">Loading…</span>
          <TableSkeleton />
        </div>
      ) : canRead ? (
        <AuditLogTable />
      ) : (
        <EmptyState
          icon={ScrollText}
          title="Owners and admins only"
          description="The audit log records every change managers make to employees, policies, schedules and settings. Ask an owner or admin if you need access."
          action={
            <Button asChild variant="outline">
              <Link href={ROUTES.overview}>Back to overview</Link>
            </Button>
          }
        />
      )}
    </>
  );
}
