"use client";

import { PLAN_CONFIG, PLAN_LIMIT_METRICS, PLAN_ORDER, formatLimit } from "@workmode/shared/plans";
import type { Plan } from "@workmode/shared/enums";
import { Check, ExternalLink, Mail } from "lucide-react";
import { ErrorState } from "@/components/error-state";
import { InlineAlert } from "@/components/inline-alert";
import { CardSkeleton } from "@/components/loading-skeletons";
import { SectionCard } from "@/components/section";
import { StatusBadge } from "@/components/status/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { SITE } from "@/config/site";
import type { BillingSummary } from "@/hooks/api-shapes";
import { usePermission } from "@/hooks/use-current-user";
import { useCurrentOrganisation } from "@/hooks/use-organisation";
import { useBilling } from "@/hooks/use-settings";
import { getErrorMessage } from "@/lib/errorMessages";
import { formatDate, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { usagePercent } from "./usage";

const USAGE_LABELS: Record<(typeof PLAN_LIMIT_METRICS)[number], string> = {
  employees: "Employees",
  locations: "Locations",
  integrations: "Rota integrations",
};

/**
 * Billing: the current plan and status (`GET /api/organisations/current`), usage against plan limits
 * (`GET /api/settings/billing`, when available) and the plan catalogue from `@workmode/shared/plans`.
 * There is no in-app checkout in the MVP; plan changes go through support or the provider's portal.
 */
export function BillingOverview() {
  const organisation = useCurrentOrganisation();
  const billing = useBilling();
  const canManageBilling = usePermission("billing:manage");

  if (organisation.isPending) {
    return (
      <div className="space-y-6">
        <CardSkeleton lines={3} />
        <CardSkeleton lines={5} />
      </div>
    );
  }
  if (organisation.isError) {
    return (
      <ErrorState
        title="Couldn't load billing"
        error={organisation.error}
        onRetry={() => void organisation.refetch()}
        isRetrying={organisation.isRefetching}
      />
    );
  }

  const { plan, billingStatus, dateFormat, timezone } = organisation.data.organisation;
  const definition = PLAN_CONFIG[plan];
  const summary: BillingSummary | null = billing.data?.available ? billing.data.data : null;

  return (
    <div className="space-y-6">
      {billingStatus === "PAST_DUE" ? (
        <InlineAlert variant="warning" title="Payment overdue">
          The last payment didn&apos;t go through. Update your payment details to keep Work Mode running for your team.
        </InlineAlert>
      ) : null}
      <SectionCard
        title="Current plan"
        description={canManageBilling ? undefined : "Only owners can change the plan."}
        actions={<StatusBadge kind="billingStatus" value={billingStatus} />}
        footer={
          canManageBilling ? (
            summary?.manageUrl ? (
              <Button asChild>
                <a href={summary.manageUrl} target="_blank" rel="noopener noreferrer">
                  Manage subscription
                  <ExternalLink aria-hidden="true" />
                  <span className="sr-only">(opens in a new tab)</span>
                </a>
              </Button>
            ) : (
              <Button asChild variant="outline">
                <a href={`mailto:${SITE.supportEmail}?subject=${encodeURIComponent("Change plan")}`}>
                  <Mail aria-hidden="true" />
                  Contact us to change plan
                </a>
              </Button>
            )
          ) : undefined
        }
      >
        <div className="space-y-6">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <p className="text-2xl font-semibold tracking-tight">{definition.name}</p>
            <p className="text-muted-foreground text-sm">{definition.priceLabel}</p>
          </div>
          {summary?.trialEndsAt && billingStatus === "TRIAL" ? (
            <p className="text-sm">
              Trial ends on <span className="font-medium">{formatDate(summary.trialEndsAt, { dateFormat, timeZone: timezone })}</span>.
            </p>
          ) : null}
          {summary ? (
            <UsageMeters summary={summary} />
          ) : billing.isPending ? (
            <CardSkeleton lines={2} className="border-dashed" />
          ) : billing.isError ? (
            <InlineAlert
              variant="warning"
              title="Usage couldn't be loaded"
              action={
                <Button type="button" variant="outline" size="sm" onClick={() => void billing.refetch()} disabled={billing.isFetching}>
                  Try again
                </Button>
              }
            >
              {getErrorMessage(billing.error)}
            </InlineAlert>
          ) : null}
        </div>
      </SectionCard>
      <SectionCard title="Plans" description="Every plan includes Work Policies, Break Rules, scheduling and live device status.">
        <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {PLAN_ORDER.map((id) => (
            <PlanCard key={id} plan={id} current={id === plan} />
          ))}
        </ul>
      </SectionCard>
    </div>
  );
}

function UsageMeters({ summary }: { summary: BillingSummary }) {
  return (
    <dl className="grid gap-4 sm:grid-cols-3">
      {PLAN_LIMIT_METRICS.map((metric) => {
        const used = summary.usage[metric];
        const limit = summary.limits[metric];
        const percent = usagePercent(used, limit);
        return (
          <div key={metric} className="space-y-2 rounded-lg border p-4">
            <dt className="text-muted-foreground text-sm">{USAGE_LABELS[metric]}</dt>
            <dd className="space-y-2">
              <p className="text-lg font-semibold tabular-nums">
                {formatNumber(used)}
                <span className="text-muted-foreground text-sm font-normal"> / {formatLimit(limit)}</span>
              </p>
              {percent !== null ? (
                <Progress
                  value={percent}
                  aria-label={`${USAGE_LABELS[metric]}: ${percent}% of plan limit used`}
                  className={cn("h-1.5", percent >= 90 && "[&>[data-slot=progress-indicator]]:bg-amber-500")}
                />
              ) : null}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function PlanCard({ plan, current }: { plan: Plan; current: boolean }) {
  const definition = PLAN_CONFIG[plan];
  return (
    <li
      className={cn("flex flex-col gap-4 rounded-xl border p-5", current ? "border-primary/50 bg-primary/5 ring-primary/20 ring-1" : "bg-card")}
      aria-current={current ? "true" : undefined}
    >
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-semibold">{definition.name}</h3>
          {current ? <Badge>Current plan</Badge> : null}
        </div>
        <p className="text-muted-foreground text-sm">{definition.priceLabel}</p>
      </div>
      <ul className="space-y-2 text-sm">
        {definition.features.map((feature) => (
          <li key={feature} className="flex gap-2">
            <Check className="text-primary mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{feature}</span>
          </li>
        ))}
      </ul>
    </li>
  );
}
