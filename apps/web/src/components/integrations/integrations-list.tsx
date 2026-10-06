"use client";

import { ACTIVATION_MODES } from "@workmode/shared/enums";
import { FileUp } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { CardSkeleton } from "@/components/loading-skeletons";
import { SectionCard } from "@/components/section";
import { Button } from "@/components/ui/button";
import { EMPTY_STATES } from "@/config/emptyStates";
import { ROUTES } from "@/config/navigation";
import { usePermission } from "@/hooks/use-current-user";
import { IntegrationCard } from "./integration-card";
import { ACTIVATION_MODE_COPY, INTEGRATIONS_EXPLAINER } from "./integration-view-model";
import { useIntegrations } from "./use-integrations";

/** Integrations page body: explainer (what syncs, Scheduled vs Clock-in) and one card per provider. */
export function IntegrationsList() {
  const integrations = useIntegrations();
  const canWrite = usePermission("integrations:write");

  const allComingSoon = integrations.data?.every((integration) => integration.availability === "COMING_SOON") ?? false;

  return (
    <div className="space-y-6">
      <SectionCard
        title={INTEGRATIONS_EXPLAINER.title}
        description={INTEGRATIONS_EXPLAINER.body}
        actions={
          <Button asChild variant="outline">
            <Link href={ROUTES.scheduleImport}>
              <FileUp aria-hidden="true" />
              Import a CSV instead
            </Link>
          </Button>
        }
      >
        <div className="space-y-5">
          {allComingSoon ? <p className="text-sm">{INTEGRATIONS_EXPLAINER.comingSoon}</p> : null}
          <div>
            <h3 className="mb-3 text-sm font-semibold">Two ways to switch Work Mode on</h3>
            <dl className="grid gap-4 sm:grid-cols-2">
              {ACTIVATION_MODES.map((mode) => (
                <div key={mode} className="rounded-lg border p-4">
                  <dt className="font-medium">{ACTIVATION_MODE_COPY[mode].label}</dt>
                  <dd className="text-muted-foreground mt-1 text-sm leading-relaxed">{ACTIVATION_MODE_COPY[mode].detail}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </SectionCard>

      {integrations.isError ? (
        <ErrorState
          title="Couldn't load integrations"
          error={integrations.error}
          onRetry={() => void integrations.refetch()}
          isRetrying={integrations.isRefetching}
        />
      ) : integrations.isPending ? (
        <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-busy="true" aria-label="Loading integrations">
          {Array.from({ length: 6 }, (_, index) => (
            <li key={index}>
              <CardSkeleton lines={4} />
            </li>
          ))}
        </ul>
      ) : integrations.data.length === 0 ? (
        <EmptyState
          icon={EMPTY_STATES.integrations.icon}
          title={EMPTY_STATES.integrations.title}
          description={EMPTY_STATES.integrations.description}
          action={
            <Button asChild>
              <Link href={EMPTY_STATES.integrations.action.href}>{EMPTY_STATES.integrations.action.label}</Link>
            </Button>
          }
        />
      ) : (
        <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-label="Rota providers">
          {integrations.data.map((integration) => (
            <IntegrationCard key={integration.provider} integration={integration} canWrite={canWrite} />
          ))}
        </ul>
      )}
    </div>
  );
}
