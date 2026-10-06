"use client";

import { listProviders } from "@workmode/shared/providers/registry";
import type { ComplianceSummaryResponse } from "@workmode/validation/compliance";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { RelativeTime } from "@/components/relative-time";
import { SectionCard } from "@/components/section";
import { StatusBadge } from "@/components/status/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ROUTES } from "@/config/navigation";

export type IntegrationStatusSummary = ComplianceSummaryResponse["integrationStatus"][number];

export interface IntegrationStatusCardProps {
  /** Providers with a stored integration row, from the compliance summary (undefined while loading). */
  statuses: readonly IntegrationStatusSummary[] | undefined;
  isLoading?: boolean;
  className?: string;
}

/**
 * Every supported rota provider with its connection state. Providers without an implementation yet read
 * "Coming soon" (from the shared registry) rather than pretending to be connectable.
 */
export function IntegrationStatusCard({
  statuses,
  isLoading = false,
  className,
}: IntegrationStatusCardProps) {
  const providers = listProviders();
  const byProvider = new Map((statuses ?? []).map((row) => [row.provider, row] as const));

  return (
    <SectionCard
      title="Integrations"
      description="Rota software that can keep shifts in sync automatically."
      className={className}
      actions={
        <Button asChild variant="ghost" size="sm">
          <Link href={ROUTES.integrations}>
            Manage
            <ArrowUpRight aria-hidden="true" />
          </Link>
        </Button>
      }
      contentClassName="px-5 py-2 sm:px-6"
      footer={
        <p className="text-muted-foreground mr-auto text-xs">
          Shifts can be imported from a CSV in the meantime.{" "}
          <Link
            href={ROUTES.scheduleImport}
            className="text-primary font-medium underline-offset-4 hover:underline"
          >
            Import schedule
          </Link>
        </p>
      }
    >
      <ul className="divide-border divide-y" aria-label="Integration providers">
        {providers.map((provider) => {
          const row = byProvider.get(provider.id) ?? null;
          return (
            <li key={provider.id} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{provider.displayName}</p>
                {row?.lastError ? (
                  <p className="truncate text-xs text-amber-700 dark:text-amber-400">
                    {row.lastError}
                  </p>
                ) : row?.lastSyncAt ? (
                  <p className="text-muted-foreground text-xs">
                    Last sync <RelativeTime value={row.lastSyncAt} />
                  </p>
                ) : null}
              </div>
              {isLoading && statuses === undefined ? (
                <Skeleton className="h-6 w-24 rounded-full" />
              ) : row ? (
                <StatusBadge kind="integrationStatus" value={row.status} size="sm" />
              ) : provider.status === "COMING_SOON" ? (
                <Badge variant="secondary" title="This integration isn't available yet.">
                  Coming soon
                </Badge>
              ) : (
                <StatusBadge kind="integrationStatus" value="NOT_CONNECTED" size="sm" />
              )}
            </li>
          );
        })}
      </ul>
    </SectionCard>
  );
}
