"use client";

import { Smartphone } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { PageHeader } from "@/components/page-header";
import { RealtimeProvider, RealtimeStatusIndicator } from "@/components/realtime";
import { Button } from "@/components/ui/button";
import { EMPTY_STATES } from "@/config/emptyStates";
import { ROUTES } from "@/config/navigation";
import { useCurrentOrganisation } from "@/hooks/use-organisation";
import { AwaitingSetupPanel } from "./awaiting-setup-panel";
import { useComplianceSummary } from "./compliance-api";
import { IntegrationStatusCard } from "./integration-status-card";
import { JoinCodeCard } from "./join-code-card";
import { OverviewMetrics } from "./metric-cards";
import { OnboardingChecklist } from "./onboarding-checklist";
import { RecentActivityCard } from "./recent-activity";
import { UpcomingShiftsList } from "./upcoming-shifts-list";

/**
 * `/overview`: setup checklist and join code, the eight compliance metrics, who still needs to set up,
 * the next shifts, the latest activity and integration status — all kept live by the realtime stream.
 */
export function OverviewPage() {
  const summary = useComplianceSummary();
  const organisation = useCurrentOrganisation();
  const timeZone = organisation.data?.organisation.timezone;
  const dateFormat = organisation.data?.organisation.dateFormat;
  const noEmployeesYet = summary.data !== undefined && summary.data.metrics.totalEmployees === 0;
  const overviewCopy = EMPTY_STATES.overview;

  return (
    <RealtimeProvider>
      <PageHeader
        title="Overview"
        description="Who's in Work Mode right now, who's on a break and what needs your attention."
        actions={
          <>
            <RealtimeStatusIndicator />
            <Button asChild variant="outline">
              <Link href={ROUTES.devices}>
                <Smartphone aria-hidden="true" />
                Devices
              </Link>
            </Button>
          </>
        }
      />
      <div className="space-y-6">
        <OnboardingChecklist />
        <JoinCodeCard />

        {summary.isError ? (
          <ErrorState
            title="Couldn't load your overview"
            error={summary.error}
            onRetry={() => void summary.refetch()}
            isRetrying={summary.isRefetching}
          />
        ) : noEmployeesYet ? (
          <EmptyState
            icon={overviewCopy.icon}
            title={overviewCopy.title}
            description={overviewCopy.description}
            action={
              overviewCopy.action?.href ? (
                <Button asChild>
                  <Link href={overviewCopy.action.href}>{overviewCopy.action.label}</Link>
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <OverviewMetrics metrics={summary.data?.metrics} isLoading={summary.isPending} />
            <div className="grid gap-6 xl:grid-cols-3">
              <div className="space-y-6 xl:col-span-2">
                <AwaitingSetupPanel />
                <UpcomingShiftsList shifts={summary.data?.upcomingShifts} isLoading={summary.isPending} dateFormat={dateFormat} />
              </div>
              <div className="space-y-6">
                <RecentActivityCard timeZone={timeZone} />
                <IntegrationStatusCard statuses={summary.data?.integrationStatus} isLoading={summary.isPending} />
              </div>
            </div>
          </>
        )}
      </div>
    </RealtimeProvider>
  );
}
