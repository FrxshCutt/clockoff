"use client";

import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { useRecentActivity } from "@/components/activity/activity-api";
import { ActivityList, ActivityListSkeleton } from "@/components/activity/activity-item";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { SectionCard } from "@/components/section";
import { Button } from "@/components/ui/button";
import { EMPTY_STATES } from "@/config/emptyStates";
import { ROUTES } from "@/config/navigation";

export const RECENT_ACTIVITY_LIMIT = 20;

/** The newest 20 organisation events (`GET /api/activity?limit=20`), kept fresh by the realtime stream. */
export function RecentActivityCard({ timeZone, className }: { timeZone?: string; className?: string }) {
  const query = useRecentActivity(RECENT_ACTIVITY_LIMIT);
  const copy = EMPTY_STATES.activity;

  return (
    <SectionCard
      title="Recent activity"
      description={`The last ${RECENT_ACTIVITY_LIMIT} events across your organisation.`}
      className={className}
      actions={
        <Button asChild variant="ghost" size="sm">
          <Link href={ROUTES.activity}>
            View all
            <ArrowUpRight aria-hidden="true" />
          </Link>
        </Button>
      }
      contentClassName="px-5 py-1 sm:px-6"
    >
      {query.isPending ? (
        <ActivityListSkeleton rows={5} />
      ) : query.isError ? (
        <ErrorState
          size="sm"
          title="Couldn't load recent activity"
          error={query.error}
          onRetry={() => void query.refetch()}
          isRetrying={query.isRefetching}
        />
      ) : query.data.length === 0 ? (
        <EmptyState icon={copy.icon} title={copy.title} description={copy.description} size="sm" bordered={false} headingLevel={3} />
      ) : (
        <div className="max-h-[36rem] overflow-y-auto">
          <ActivityList events={query.data} timeZone={timeZone} label="Recent activity" />
        </div>
      )}
    </SectionCard>
  );
}
