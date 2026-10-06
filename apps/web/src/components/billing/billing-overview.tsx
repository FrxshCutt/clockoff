"use client";

import { PLAN_CONFIG, PLAN_LIMIT_METRICS, PLAN_ORDER, formatLimit } from "@workmode/shared/plans";
import type { Plan } from "@workmode/shared/enums";
import { Check, ExternalLink, Mail, Minus } from "lucide-react";
import { ErrorState } from "@/components/error-state";
import { InlineAlert } from "@/components/inline-alert";
import { CardSkeleton } from "@/components/loading-skeletons";
import { SectionCard } from "@/components/section";
import { StatusBadge } from "@/components/status/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { BillingSummary } from "@/hooks/api-shapes";
import { usePermission } from "@/hooks/use-current-user";
import { useCurrentOrganisation } from "@/hooks/use-organisation";
import { useBilling } from "@/hooks/use-settings";
import { getErrorMessage } from "@/lib/errorMessages";
import { formatDate, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { PLAN_CHANGE_COMING_SOON, PLAN_CTA_LABELS, planCardCta, planHighlights, planLimitLines, salesMailto } from "./plan-cards";
import { usagePercent } from "./usage";

const USAGE_LABELS: Record<(typeof PLAN_LIMIT_METRICS)[number], string> = {
  employees: "Employees",
  locations: "Locations",
  integrations: "Rota integrations",
};

/**
 * Billing: the current plan and status (`GET /api/organisations/current`), usage against plan limits
 * (`GET /api/settings/billing`, when available) and the plan catalogue from `@workmode/shared/plans`.
 * There is no in-app checkout or card processing in the MVP: plan changes go through sales (mailto) or, once
 * wired up, the provider portal at `manageUrl`. "Upgrade" is shown disabled as coming soon, never as working.
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

  const { plan, billingStatus, dateFormat, timezone, name } = organisation.data.organisation;
  const definition = PLAN_CONFIG[plan];
  const summary: BillingSummary | null = billing.data?.available ? billing.data.data : null;
  const contactSales = salesMailto(`Change plan for ${name}`, `Organisation: ${name}\nCurrent plan: ${definition.name}\n\nI'd like to talk about: `);

  return (
    <div className="space-y-6">
      {billingStatus === "PAST_DUE" ? (
        <InlineAlert variant="warning" title="Payment overdue">
          The last payment didn&apos;t go through. Contact us to update your payment details and keep Work Mode running for your team.
        </InlineAlert>
      ) : null}
      <InlineAlert variant="info" title="No card payments in the dashboard yet">
        Work Mode doesn&apos;t process payments here. Plans are set up and changed with our team: contact sales and we&apos;ll
        arrange it with your owner.
      </InlineAlert>
      <SectionCard
        title="Current plan"
        description={canManageBilling ? undefined : "Only owners can change the plan."}
        actions={<StatusBadge kind="billingStatus" value={billingStatus} />}
        footer={
          canManageBilling ? (
            <>
              {summary?.manageUrl ? (
                <Button asChild>
                  <a href={summary.manageUrl} target="_blank" rel="noopener noreferrer">
                    Manage subscription
                    <ExternalLink aria-hidden="true" />
                    <span className="sr-only">(opens in a new tab)</span>
                  </a>
                </Button>
              ) : null}
              <Button asChild variant={summary?.manageUrl ? "outline" : "default"}>
                <a href={contactSales}>
                  <Mail aria-hidden="true" />
                  Contact sales
                </a>
              </Button>
            </>
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
          ) : (
            <p className="text-muted-foreground text-sm">Usage against your plan limits will appear here once billing is connected.</p>
          )}
        </div>
      </SectionCard>
      <SectionCard
        title="Plans"
        description="Every plan includes Work Policies, Break Rules, scheduling and live device status. Changing plan is handled by our team for now."
      >
        <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {PLAN_ORDER.map((id) => (
            <PlanCard key={id} plan={id} currentPlan={plan} contactHref={salesMailto(`${PLAN_CONFIG[id].name} plan for ${name}`)} />
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

function PlanCard({ plan, currentPlan, contactHref }: { plan: Plan; currentPlan: Plan; contactHref: string }) {
  const definition = PLAN_CONFIG[plan];
  const cta = planCardCta(plan, currentPlan);
  const current = cta === "current";
  return (
    <li
      className={cn("flex flex-col gap-5 rounded-xl border p-5", current ? "border-primary/50 bg-primary/5 ring-primary/20 ring-1" : "bg-card")}
      aria-current={current ? "true" : undefined}
    >
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-semibold">{definition.name}</h3>
          {current ? <Badge>Current plan</Badge> : null}
        </div>
        <p className="text-muted-foreground text-sm">{definition.priceLabel}</p>
      </div>
      <dl className="space-y-1.5 text-sm">
        {planLimitLines(plan).map((line) => (
          <div key={line.key} className="flex items-start justify-between gap-3">
            <dt className="text-muted-foreground">{line.label}</dt>
            <dd className={cn("text-right font-medium", !line.included && "text-muted-foreground font-normal")}>{line.value}</dd>
          </div>
        ))}
      </dl>
      <ul className="flex-1 space-y-2 text-sm">
        {planHighlights(plan).map((feature) => (
          <li key={feature} className="flex gap-2">
            <Check className="text-primary mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{feature}</span>
          </li>
        ))}
      </ul>
      <PlanCardAction cta={cta} planName={definition.name} contactHref={contactHref} />
    </li>
  );
}

function PlanCardAction({ cta, planName, contactHref }: { cta: ReturnType<typeof planCardCta>; planName: string; contactHref: string }) {
  if (cta === "current") {
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-sm">
        <Minus className="size-4" aria-hidden="true" />
        You&apos;re on this plan
      </p>
    );
  }
  if (cta === "contact-sales") {
    return (
      <Button asChild variant="outline" className="w-full">
        <a href={contactHref}>
          <Mail aria-hidden="true" />
          {PLAN_CTA_LABELS[cta]}
        </a>
      </Button>
    );
  }
  // Self-serve plan changes are not built: the button is real, disabled and says why.
  return (
    <div className="space-y-1.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="block rounded-md outline-none focus-visible:ring-[3px]">
            <Button type="button" variant={cta === "upgrade" ? "default" : "outline"} className="w-full" disabled aria-describedby={undefined}>
              {PLAN_CTA_LABELS[cta]} to {planName}
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{PLAN_CHANGE_COMING_SOON}: contact sales to change plan today.</TooltipContent>
      </Tooltip>
      <p className="text-muted-foreground text-center text-xs">
        {PLAN_CHANGE_COMING_SOON} ·{" "}
        <a href={contactHref} className="hover:text-foreground underline underline-offset-4">
          contact sales
        </a>
      </p>
    </div>
  );
}
