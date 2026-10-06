"use client";

import { ScrollText } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { TableSkeleton } from "@/components/loading-skeletons";
import { PageHeader } from "@/components/page-header";
import { RealtimeProvider, RealtimeStatusIndicator } from "@/components/realtime";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ROUTES } from "@/config/navigation";
import { usePermission } from "@/hooks/use-current-user";
import { ActivityFeed } from "./activity-feed";
import { isActivityTab, parseActivityPageState, serializeActivityPageState, type ActivityPageState } from "./activity-filters";
import { ComplianceTable } from "./compliance-table";
import { useUrlState } from "./use-url-state";

/**
 * `/activity`: the organisation feed and the compliance table as two tabs, with every filter in the URL so
 * views can be shared. The page frame (title, live indicator, audit log link) renders straight away; the
 * tabs read the search params, so they sit behind their own Suspense boundary (as Next requires for
 * `useSearchParams`). The audit log link only appears for roles with `audit:read` (owners and admins).
 */
export function ActivityPage() {
  const canReadAudit = usePermission("audit:read");

  return (
    <RealtimeProvider>
      <PageHeader
        title="Activity"
        description="A timeline of joins, setup, Work Mode and breaks across your organisation."
        actions={
          <>
            <RealtimeStatusIndicator />
            {canReadAudit ? (
              <Button asChild variant="outline">
                <Link href={ROUTES.auditLogs}>
                  <ScrollText aria-hidden="true" />
                  Audit log
                </Link>
              </Button>
            ) : null}
          </>
        }
      />
      <Suspense fallback={<TableSkeleton />}>
        <ActivityTabs />
      </Suspense>
    </RealtimeProvider>
  );
}

/** The two tabs; owns the URL state (`?tab=…` plus each tab's filters). */
function ActivityTabs() {
  const [state, setState] = useUrlState<ActivityPageState>(parseActivityPageState, serializeActivityPageState);

  return (
    <Tabs
      value={state.tab}
      onValueChange={(next) => {
        if (isActivityTab(next)) setState({ ...state, tab: next });
      }}
      className="gap-4"
    >
      <TabsList aria-label="Activity views">
        <TabsTrigger value="activity">Timeline</TabsTrigger>
        <TabsTrigger value="compliance">Compliance</TabsTrigger>
      </TabsList>
      <TabsContent value="activity">
        <ActivityFeed feed={state.feed} onChange={(feed) => setState({ ...state, feed })} />
      </TabsContent>
      <TabsContent value="compliance">
        <ComplianceTable params={state.compliance} onChange={(compliance) => setState({ ...state, compliance })} />
      </TabsContent>
    </Tabs>
  );
}
